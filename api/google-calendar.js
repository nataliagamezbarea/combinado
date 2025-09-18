const express = require("express");
const { google } = require("googleapis");
const { Client } = require("@notionhq/client");

const router = express.Router();

// --- Variables de entorno ---
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// --- Cliente de Notion ---
const notion = new Client({ auth: NOTION_API_KEY });
const processingEvents = new Set();

// --- Autenticación OAuth2 ---
function getGoogleAuth() {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oAuth2Client;
}

// --- Crear página en Notion ---
async function createNotionPage(ev) {
  try {
    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Título: {
          title: [
            {
              type: "text",
              text: { content: ev.summary || "Sin título" },
            },
          ],
        },
        "Fecha de entrega":
          ev.start?.dateTime || ev.start?.date
            ? {
                date: {
                  start: ev.start.dateTime || ev.start.date,
                  end: ev.end?.dateTime || ev.end?.date || null,
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

// --- Webhook ---
router.post("/webhook", async (req, res) => {
  try {
    const state = req.header("X-Goog-Resource-State");
    if (state === "sync") return res.status(200).send();

    if (state === "exists" || state === "not_exists") {
      const auth = getGoogleAuth();
      const calendar = google.calendar({ version: "v3", auth });

      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const events = await calendar.events.list({
        calendarId: CALENDAR_ID,
        updatedMin: twoMinutesAgo,
        showDeleted: true,
        singleEvents: true,
      });

      for (const ev of events.data.items || []) {
        if (processingEvents.has(ev.id)) continue;
        processingEvents.add(ev.id);

        try {
          if (ev.status === "cancelled") continue;

          const origin = ev.extendedProperties?.private?.origin;
          const notionPageId = ev.extendedProperties?.private?.notion_page_id;

          if (notionPageId) {
            console.log("⏩ Evento ya vinculado con Notion:", notionPageId);
            continue;
          }

          if (origin === "calendar") {
            console.log("⏩ Evento con origin=calendar → ignorado");
            continue;
          }

          // 1) marcar origin=calendar
          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: ev.id,
            requestBody: {
              extendedProperties: {
                private: {
                  ...(ev.extendedProperties?.private || {}),
                  origin: "calendar",
                },
              },
            },
          });

          // 2) crear página en Notion
          const newPageId = await createNotionPage(ev);
          if (!newPageId) continue;

          // 3) guardar notion_page_id
          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: ev.id,
            requestBody: {
              extendedProperties: {
                private: {
                  origin: "calendar",
                  notion_page_id: newPageId,
                },
              },
            },
          });

          console.log("🆕 Página creada y vinculada a evento Calendar:", newPageId);
        } catch (err) {
          console.warn("⚠️ Error procesando evento:", err.message);
        } finally {
          processingEvents.delete(ev.id);
        }
      }
    }

    res.status(200).send();
  } catch (error) {
    console.error("❌ Error general webhook:", error);
    res.status(500).send("Error interno");
  }
});

module.exports = router;
