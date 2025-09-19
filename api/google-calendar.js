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

const notion = new Client({ auth: NOTION_API_KEY });

// ======== UTILS ========
function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  return oauth2Client;
}

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

    const properties = {
      Título: { title: [{ type: "text", text: { content: ev.summary || "Sin título" } }] },
    };
    if (startDate) {
      properties["Fecha de entrega"] = {
        date: endDate ? { start: startDate, end: endDate } : { start: startDate },
      };
    }

    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
    });

    console.log(`🆕 Página Notion creada: ${page.id} para evento ${ev.id}`);
    return page.id;
  } catch (err) {
    console.warn("⚠️ Error creando página en Notion:", err.message || err);
    return null;
  }
}

async function archiveNotionPage(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    if (!page.archived) {
      await notion.pages.update({ page_id: pageId, archived: true });
      console.log(`🗑️ Página archivada en Notion: ${pageId}`);
    }
  } catch (err) {
    console.warn("⚠️ Error archivando página Notion:", err.message || err);
  }
}

// =========================
//    COLA DE EVENTOS
// =========================

const pendingEvents = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || pendingEvents.length === 0) {
    isProcessing = false;
    return;
  }

  isProcessing = true;
  const ev = pendingEvents.shift();
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });

  try {
    // Marcar en Calendar que se está creando
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: ev.id,
      requestBody: {
        extendedProperties: {
          private: { ...(ev.extendedProperties?.private || {}), creating: "true" },
        },
      },
    });

    const pageId = await createNotionPage(ev);

    if (pageId) {
      await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId: ev.id,
        requestBody: {
          extendedProperties: {
            private: { origin: "calendar", notion_page_id: pageId },
          },
        },
      });
      console.log(`🔗 Evento ${ev.id} vinculado a Notion page ${pageId}`);
    }
  } catch (err) {
    console.warn("⚠️ Error procesando evento:", err.message || err);
  } finally {
    isProcessing = false;

    // Si hay más eventos, procesar el siguiente tras 5 segundos
    if (pendingEvents.length > 0) {
      setTimeout(processQueue, 5000);
    }
  }
}

// =========================
//    ENDPOINTS
// =========================

// ⚡ Para evitar duplicados
const recentlyQueued = new Set();

router.post("/webhook", async (req, res) => {
  try {
    const state = req.header("X-Goog-Resource-State");
    if (state === "sync") return res.status(200).send();
    if (state !== "exists" && state !== "not_exists") return res.status(200).send();

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const events = await calendar.events.list({
      calendarId: CALENDAR_ID,
      updatedMin: twoMinutesAgo,
      showDeleted: true,
      singleEvents: true,
      orderBy: "updated",
      maxResults: 10,
    });

    const items = events.data.items || [];
    for (const ev of items) {
      if (ev.status === "cancelled") {
        const notionPageId = ev.extendedProperties?.private?.notion_page_id;
        if (notionPageId) await archiveNotionPage(notionPageId);
        continue;
      }

      if (!ev.extendedProperties?.private?.notion_page_id) {
        if (!recentlyQueued.has(ev.id)) {
          recentlyQueued.add(ev.id);
          pendingEvents.push(ev);
          console.log(`🟢 Añadido a la cola: ${ev.id}`);
          setTimeout(() => recentlyQueued.delete(ev.id), 30_000);
        } else {
          console.log(`⚪ Evento ${ev.id} ignorado (ya en cola recientemente)`);
        }
      }
    }

    // ⚡ Iniciar procesamiento si no está en marcha
    if (!isProcessing && pendingEvents.length > 0) {
      processQueue();
    }

    res.status(200).send();
  } catch (err) {
    console.error("❌ Error en webhook:", err.message || err);
    res.status(500).send("Error interno");
  }
});

module.exports = router;
