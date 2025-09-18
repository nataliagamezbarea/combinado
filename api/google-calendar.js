// calendar-to-notion.js
const express = require("express");
const { google } = require("googleapis");
const { Client } = require("@notionhq/client");

const router = express.Router();

const OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const notion = new Client({ auth: NOTION_API_KEY });
const processingEvents = new Set();

// --- Autenticación Google OAuth2 ---
function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  return oauth2Client;
}

// --- Utilidades ---
function isAllDayEvent(ev) {
  return !!(ev.start?.date && !ev.start?.dateTime);
}

function formatAllDayDates(start, end) {
  const startDate = start;
  let endDate = end;

  if (endDate) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - 1); // end.date es exclusivo
    endDate = d.toISOString().split("T")[0];
  }

  return { startDate, endDate };
}

// --- Notion ---
async function createNotionPage(ev) {
  try {
    let startDate, endDate;

    if (isAllDayEvent(ev)) {
      ({ startDate, endDate } = formatAllDayDates(ev.start.date, ev.end?.date));
    } else {
      startDate = ev.start?.dateTime;
      endDate = ev.end?.dateTime || null;
    }

    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Título: {
          title: [{ type: "text", text: { content: ev.summary || "Sin título" } }],
        },
        "Fecha de entrega": startDate ? { date: { start: startDate, end: endDate } } : undefined,
      },
    });

    return page.id;
  } catch (err) {
    console.warn("⚠️ Error creando página en Notion:", err.message);
    return null;
  }
}

async function archiveNotionPage(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    if (page.archived) return;
    await notion.pages.update({ page_id: pageId, archived: true });
    console.log(`🗑️ Página archivada en Notion: ${pageId}`);
  } catch (error) {
    console.warn("⚠️ Error archivando página en Notion:", error.message);
  }
}

async function isPageArchived(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    return page.archived;
  } catch (error) {
    console.warn("⚠️ Error verificando página archivada:", error.message);
    return false;
  }
}

// --- Endpoint GET para iniciar un canal de watch ---
router.get("/create-watch", async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const watchId = `watch-${Date.now()}`;

    const response = await calendar.events.watch({
      calendarId: CALENDAR_ID,
      requestBody: {
        id: watchId,
        type: "web_hook",
        address: WEBHOOK_URL,
      },
    });

    console.log("✅ Watch iniciado:", response.data);
    res.status(200).json({ message: "Watch iniciado", data: response.data });
  } catch (error) {
    console.error("❌ Error creando watch:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// --- Endpoint POST Webhook ---
router.post("/webhook", async (req, res) => {
  try {
    const state = req.header("X-Goog-Resource-State");
    const channelId = req.header("X-Goog-Channel-Id");
    const resourceId = req.header("X-Goog-Resource-Id");

    console.log("📩 Webhook recibido", { state, channelId, resourceId });

    // Responder inmediatamente
    res.status(200).send();

    // Ignorar el webhook inicial de sincronización
    if (state === "sync") return;

    // Solo procesar si hay cambios reales
    if (state !== "exists" && state !== "not_exists") return;

    // Evitar reprocesar el mismo recurso varias veces
    if (processingEvents.has(resourceId)) {
      console.log("⏳ Ya se está procesando este recurso, se ignora");
      return;
    }
    processingEvents.add(resourceId);

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    // Buscar solo eventos actualizados en los últimos 2 minutos
    const updatedMin = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      updatedMin,
      singleEvents: true,
      showDeleted: true,
      maxResults: 10,
      orderBy: "updated",
    });

    const events = response.data.items || [];
    console.log(`🔍 Eventos recientes: ${events.length}`);

    if (events.length === 0) {
      processingEvents.delete(resourceId);
      return;
    }

    for (const ev of events) {
      try {
        if (ev.status === "cancelled") {
          const notionPageId = ev.extendedProperties?.private?.notion_page_id;
          if (notionPageId) await archiveNotionPage(notionPageId);
          continue;
        }

        let notionPageId = ev.extendedProperties?.private?.notion_page_id;

        if (notionPageId) {
          const archived = await isPageArchived(notionPageId);
          if (!archived) {
            let startDate, endDate;

            if (isAllDayEvent(ev)) {
              ({ startDate, endDate } = formatAllDayDates(ev.start.date, ev.end?.date));
            } else {
              startDate = ev.start?.dateTime;
              endDate = ev.end?.dateTime || null;
            }

            await notion.pages.update({
              page_id: notionPageId,
              properties: {
                Título: {
                  title: [{ type: "text", text: { content: ev.summary || "Sin título" } }],
                },
                "Fecha de entrega": startDate ? { date: { start: startDate, end: endDate } } : undefined,
              },
            });
            console.log("♻️ Página actualizada:", notionPageId);
          }
        } else {
          const newPageId = await createNotionPage(ev);
          if (newPageId) {
            await calendar.events.patch({
              calendarId: CALENDAR_ID,
              eventId: ev.id,
              requestBody: {
                extendedProperties: {
                  private: { origin: "calendar", notion_page_id: newPageId },
                },
              },
            });
            console.log("🆕 Página creada y vinculada:", newPageId);
          }
        }
      } catch (err) {
        console.warn("⚠️ Error procesando evento:", err.message);
      }
    }

    processingEvents.delete(resourceId);
  } catch (error) {
    console.error("❌ Error en webhook:", error?.response?.data || error.message || error);
    res.status(500).send("Error interno");
  }
});

module.exports = router;
