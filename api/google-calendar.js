const express = require("express");
const { google } = require("googleapis");
const { Client } = require("@notionhq/client");

const router = express.Router();

// ======== ENV ========
const OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// ======== CLIENTES ========
const notion = new Client({ auth: NOTION_API_KEY });
const processingEvents = new Set();

// Crear cliente OAuth2 ya autenticado con refresh_token
function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  return oauth2Client;
}

// =========================
//    FUNCIONES AUXILIARES
// =========================

function isAllDayEvent(ev) {
  return !!(ev.start?.date && !ev.start?.dateTime);
}

function formatAllDayDates(start, end) {
  const startDate = start;
  let endDate = end;

  if (endDate) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - 1);
    endDate = d.toISOString().split("T")[0];
  }

  return { startDate, endDate };
}

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
        "Fecha de entrega": startDate
          ? {
              date: {
                start: startDate,
                end: endDate,
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

// =========================
//    ENDPOINTS
// =========================

// Crear canal (watch)
router.get("/create-watch", async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const channelId = `channel-${Date.now()}`;

    const watchResponse = await calendar.events.watch({
      calendarId: CALENDAR_ID,
      requestBody: {
        id: channelId,
        type: "web_hook",
        address: WEBHOOK_URL,
      },
    });

    console.log("✅ Canal creado:", watchResponse.data);
    res.json({ message: "Canal creado correctamente", data: watchResponse.data });
  } catch (error) {
    console.error("❌ Error creando canal:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Webhook (solo ejecuta lógica cuando hay cambios reales)
router.post("/webhook", async (req, res) => {
  try {
    const state = req.header("X-Goog-Resource-State");

    console.log("📩 Notificación recibida:", state);

    if (state === "sync") {
      console.log("⚪ Primera sincronización");
      return res.status(200).send();
    }

    if (state !== "exists" && state !== "not_exists") {
      return res.status(200).send();
    }

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    // Buscar eventos actualizados en los últimos 2 minutos
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const events = await calendar.events.list({
      calendarId: CALENDAR_ID,
      updatedMin: twoMinutesAgo,
      showDeleted: true,
      singleEvents: true,
      orderBy: "updated",
      maxResults: 10,
    });

    for (const ev of events.data.items || []) {
      if (processingEvents.has(ev.id)) continue;
      processingEvents.add(ev.id);

      try {
        if (ev.status === "cancelled") {
          const notionPageId = ev.extendedProperties?.private?.notion_page_id;
          if (notionPageId) await archiveNotionPage(notionPageId);
          continue;
        }

        const origin = ev.extendedProperties?.private?.origin;
        const notionPageId = ev.extendedProperties?.private?.notion_page_id;

        if (origin === "calendar" && !notionPageId) continue;

        // Actualizar página existente
        if (notionPageId) {
          const archived = await isPageArchived(notionPageId);
          if (archived) continue;

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
              Título: { title: [{ type: "text", text: { content: ev.summary || "Sin título" } }] },
              "Fecha de entrega": startDate ? { date: { start: startDate, end: endDate } } : undefined,
            },
          });
        }

        // Marcar evento con origin:calendar
        await calendar.events.patch({
          calendarId: CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: { private: { ...(ev.extendedProperties?.private || {}), origin: "calendar" } },
          },
        });

        // Crear página nueva si no existía
        if (!notionPageId) {
          const newPageId = await createNotionPage(ev);
          if (!newPageId) continue;

          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: ev.id,
            requestBody: {
              extendedProperties: { private: { origin: "calendar", notion_page_id: newPageId } },
            },
          });

          console.log("🆕 Página creada y vinculada a evento Calendar:", newPageId);
        }
      } catch (err) {
        console.warn("⚠️ Error procesando evento:", err.message);
      } finally {
        processingEvents.delete(ev.id);
      }
    }

    res.status(200).send();
  } catch (error) {
    console.error("❌ Error en webhook:", error);
    res.status(500).send("Error interno");
  }
});

module.exports = router;
