// api/elo.js
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

module.exports = async (req, res) => {
  try {
    if (!process.env.NOTION_TOKEN || !process.env.PLAYERS_DB_ID || !process.env.MATCHES_DB_ID) {
      return res.status(500).json({ error: "Missing NOTION env vars" });
    }

    let pageId = req.method === "GET" ? req.query.page_id : req.body?.page_id;
    if (!pageId) return res.status(400).json({ error: "Missing page_id" });

    if (process.env.ELO_WEBHOOK_SECRET) {
      const incoming = req.headers["x-elo-secret"];
      if (incoming !== process.env.ELO_WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
    }

    const match = await notion.pages.retrieve({ page_id: pageId });
    const p = match.properties;
    const status = p["Ergebnis"]?.status?.name;
    if (status !== "Offen") return res.status(200).json({ message: "Match already processed or not open" });

    const relA = p["Spieler A"]?.relation || [];
    const relB = p["Spieler B"]?.relation || [];
    if (relA.length !== 1 || relB.length !== 1)
      return res.status(400).json({ error: "Spieler A/B müssen genau 1 Relation haben" });

    const [playerAId, playerBId] = [relA[0].id, relB[0].id];
    const [playerA, playerB] = await Promise.all([
      notion.pages.retrieve({ page_id: playerAId }),
      notion.pages.retrieve({ page_id: playerBId })
    ]);

    const eloA = playerA.properties["ELO"].number ?? 1000;
    const eloB = playerB.properties["ELO"].number ?? 1000;
    const goalsA = p["Tore A"].number, goalsB = p["Tore B"].number;
    if (typeof goalsA !== "number" || typeof goalsB !== "number")
      return res.status(400).json({ error: "Tore A/B müssen Zahlen sein" });

    let scoreA = 0.5, scoreB = 0.5;
    if (goalsA > goalsB) [scoreA, scoreB] = [1, 0];
    else if (goalsA < goalsB) [scoreA, scoreB] = [0, 1];

    const K = p["K"]?.number || 20;
    const expectedA = 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
    const expectedB = 1 / (1 + Math.pow(10, (eloA - eloB) / 400));
    const newEloA = Math.round(eloA + K * (scoreA - expectedA));
    const newEloB = Math.round(eloB + K * (scoreB - expectedB));

    await Promise.all([
      notion.pages.update({ page_id: playerAId, properties: { "ELO": { number: newEloA } } }),
      notion.pages.update({ page_id: playerBId, properties: { "ELO": { number: newEloB } } }),
      notion.pages.update({
        page_id: pageId,
        properties: {
          "ELO A vor": { number: eloA },
          "ELO B vor": { number: eloB },
          "ELO A nach": { number: newEloA },
          "ELO B nach": { number: newEloB },
          "K": { number: K },
          "Ergebnis": { status: { name: "Gewertet" } }
        }
      })
    ]);

    return res.status(200).json({
      message: "ELO updated",
      playerA: { old: eloA, new: newEloA },
      playerB: { old: eloB, new: newEloB }
    });
  } catch (err) {
    console.error("ELO handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
