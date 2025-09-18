const express = require("express");
const { google } = require("googleapis");
const { Client } = require("@notionhq/client");

const router = express.Router();

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_API_KEY });
const processingEvents = new Set();

let oauth2Client = null;
function getOAuthClient() {
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  }
  return oauth2Client;
}

async function createNotionPage(ev) {
  try {
    const start = ev.start?.dateTime || ev.start?.date;
    const end = ev.end?.dateTime || ev.end?.date;

    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Título: {
          title: [{ type: "text", text: { content: ev.summary || "Sin título" } }],
        },
        "Fecha de entrega": start
          ? {
              date: {
                start,
                end: end || null,
              },
            }
          : undefined,
      },
    });
    return page.id;
  } catch (err) {
    console.warn("⚠️ Error creando página en Notion:", err.message);
    return null;
  }
}

// Guardamos el último `updatedMin` para no duplicar
let lastCheck = new Date(Date.now() - 2 * 60 * 1000).toISOString();

router.post("/webhook", async (req, res) => {
  // ⚡ Respondemos rápido, sin esperar al procesamiento
  res.status(200).end();

  try {
    const state = req.header("X-Goog-Resource-State");
    if (state === "sync") return; // ignorar notificación inicial

    if (state === "exists" || state === "not_exists") {
      const auth = getOAuthClient();
      const calendar = google.calendar({ version: "v3", auth });

      const events = await calendar.events.list({
        calendarId: CALENDAR_ID,
        updatedMin: lastCheck,
        showDeleted: true,
        singleEvents: true,
      });

      lastCheck = new Date().toISOString(); // actualizar marca de tiempo

      for (const ev of events.data.items || []) {
        if (processingEvents.has(ev.id)) continue;
        processingEvents.add(ev.id);

        try {
          if (ev.status === "cancelled") continue;

          const origin = ev.extendedProperties?.private?.origin;
          const notionPageId = ev.extendedProperties?.private?.notion_page_id;

          if (notionPageId) continue;
          if (origin === "calendar") continue;

          // 1) marcar origin=calendar para bloquear bucles
          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: ev.id,
            requestBody: {
              extendedProperties: {
                private: { ...(ev.extendedProperties?.private || {}), origin: "calendar" },
              },
            },
          });

          // 2) crear la página en Notion
          const newPageId = await createNotionPage(ev);
          if (!newPageId) continue;

          // 3) marcar el evento con notion_page_id
          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: ev.id,
            requestBody: {
              extendedProperties: {
                private: { origin: "calendar", notion_page_id: newPageId },
              },
            },
          });

          console.log("🆕 Evento vinculado con Notion:", ev.id);
        } catch (err) {
          console.warn("⚠️ Error procesando evento:", err.message);
        } finally {
          processingEvents.delete(ev.id);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error general webhook:", error);
  }
});

module.exports = router;
