// api/elo.js
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

module.exports = async (req, res) => {
  try {
    // Wir erwarten POST von Notion
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!process.env.NOTION_TOKEN || !process.env.PLAYERS_DB_ID || !process.env.MATCHES_DB_ID) {
      console.error("Missing NOTION env vars");
      return res.status(500).json({ error: "Missing NOTION env vars" });
    }

    // Body robust parsen
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    // pageId aus typischen Notion-Payload-Feldern holen
    let pageId =
      body.page_id ||
      body.entity?.id ||
      body.data?.id ||
      body.data?.entity?.id ||
      body.page?.id;

    if (!pageId) {
      console.error("Could not determine page_id from payload:", JSON.stringify(body));
      return res.status(400).json({ error: "Missing page_id in payload" });
    }

    // Match-Seite holen
    const match = await notion.pages.retrieve({ page_id: pageId });
    const p = match.properties;

    // Status-Property finden (Ergebnis / Status Ergebnis)
    const statusProp = p["Ergebnis"] || p["Status Ergebnis"];
    const statusName = (statusProp && statusProp.status && statusProp.status.name) || "";

    // Welche Statusnamen gelten als "offen"?
    const openStatuses = ["Offen", "To-do", "Todo", "Not started"];
    const isOpen = openStatuses.includes(statusName);

    if (!isOpen) {
      // Match ist nicht offen -> nichts tun
      return res.status(200).json({ message: `Match not open (status=${statusName}), nothing to do` });
    }

    const relA = p["Spieler A"]?.relation || [];
    const relB = p["Spieler B"]?.relation || [];

    if (relA.length !== 1 || relB.length !== 1) {
      console.error("Spieler A/B Relation invalid:", relA.length, relB.length);
      return res.status(400).json({ error: "Spieler A/B müssen genau 1 Relation haben" });
    }

    const playerAId = relA[0].id;
    const playerBId = relB[0].id;

    const [playerA, playerB] = await Promise.all([
      notion.pages.retrieve({ page_id: playerAId }),
      notion.pages.retrieve({ page_id: playerBId })
    ]);

    const eloA = playerA.properties["ELO"].number ?? 1000;
    const eloB = playerB.properties["ELO"].number ?? 1000;

    const goalsA = p["Tore A"]?.number;
    const goalsB = p["Tore B"]?.number;

    if (typeof goalsA !== "number" || typeof goalsB !== "number") {
      console.error("Tore sind keine Zahlen:", goalsA, goalsB);
      return res.status(400).json({ error: "Tore A/B müssen Zahlen sein" });
    }

    // Ergebnis in 1 / 0.5 / 0 mappen
    let scoreA = 0.5;
    let scoreB = 0.5;
    if (goalsA > goalsB) {
      scoreA = 1;
      scoreB = 0;
    } else if (goalsA < goalsB) {
      scoreA = 0;
      scoreB = 1;
    }

    // K lesen (oder Default 20)
    const kProp = p["K"];
    const K = (kProp && typeof kProp.number === "number" ? kProp.number : 20);

    // ELO-Formel
    const expectedA = 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
    const expectedB = 1 / (1 + Math.pow(10, (eloA - eloB) / 400));

    const newEloA = Math.round(eloA + K * (scoreA - expectedA));
    const newEloB = Math.round(eloB + K * (scoreB - expectedB));

    // Name der Status-Property bestimmen
    const statusPropertyName = p["Ergebnis"] ? "Ergebnis" : "Status Ergebnis";

    // Updates in Notion schreiben
    await Promise.all([
      notion.pages.update({
        page_id: playerAId,
        properties: {
          "ELO": { number: newEloA }
        }
      }),
      notion.pages.update({
        page_id: playerBId,
        properties: {
          "ELO": { number: newEloB }
        }
      }),
      notion.pages.update({
        page_id: pageId,
        properties: {
          "ELO A vor": { number: eloA },
          "ELO B vor": { number: eloB },
          "ELO A nach": { number: newEloA },
          "ELO B nach": { number: newEloB },
          "K": { number: K },
          [statusPropertyName]: { status: { name: "Complete" } }
        }
      })
    ]);

    return res.status(200).json({
      message: "ELO updated",
      pageId,
      playerA: { old: eloA, new: newEloA },
      playerB: { old: eloB, new: newEloB }
    });
  } catch (err) {
    console.error("ELO handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
