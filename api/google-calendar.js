// calendar-to-notion-oauth.js
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

// ======== Cliente Notion & util ========
const notion = new Client({ auth: NOTION_API_KEY });
const processingEvents = new Set();

function checkRequiredEnv() {
  const missing = [];
  if (!OAUTH_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!OAUTH_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!OAUTH_REFRESH_TOKEN) missing.push("GOOGLE_REFRESH_TOKEN");
  if (!CALENDAR_ID) missing.push("GOOGLE_CALENDAR_ID");
  if (!NOTION_API_KEY) missing.push("NOTION_API_KEY");
  if (!NOTION_DATABASE_ID) missing.push("NOTION_DATABASE_ID");
  if (!WEBHOOK_URL) missing.push("WEBHOOK_URL");

  if (missing.length) {
    const errMsg = `Faltan variables de entorno: ${missing.join(", ")}`;
    console.warn("⚠️ " + errMsg);
    throw new Error(errMsg);
  }
}

function getGoogleAuth() {
  // OAuth2 client con refresh_token
  const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  return oauth2Client;
}

function isAllDayEvent(ev) {
  return !!(ev.start?.date && !ev.start?.dateTime);
}

function formatAllDayDates(start, end) {
  const startDate = start; // YYYY-MM-DD
  let endDate = end;
  if (endDate) {
    // Google Calendar usa end.date como exclusivo; restamos 1 día para Notion
    const d = new Date(endDate);
    d.setDate(d.getDate() - 1);
    endDate = d.toISOString().split("T")[0];
  }
  return { startDate, endDate };
}

// --- Crear página en Notion (con parent.database_id correctamente incluido) ---
async function createNotionPage(ev) {
  try {
    let startDate, endDate;
    if (isAllDayEvent(ev)) {
      ({ startDate, endDate } = formatAllDayDates(ev.start.date, ev.end?.date));
    } else {
      startDate = ev.start?.dateTime;
      endDate = ev.end?.dateTime || null;
    }

    // Construir propiedades sin incluir undefined
    const properties = {
      Título: {
        title: [{ type: "text", text: { content: ev.summary || "Sin título" } }],
      },
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

    console.log(`🆕 Notion page created: ${page.id} for event ${ev.id}`);
    return page.id;
  } catch (err) {
    console.warn("⚠️ Error creando página en Notion:", err.message || err);
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
    console.warn("⚠️ Error archivando página en Notion:", error.message || error);
  }
}

async function isPageArchived(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    return page.archived;
  } catch (error) {
    console.warn("⚠️ Error verificando página archivada:", error.message || error);
    return false;
  }
}

// =========================
//    ENDPOINTS
// =========================

// Crear canal (watch)
router.get("/create-watch", async (req, res) => {
  try {
    checkRequiredEnv();
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
    checkRequiredEnv();

    const state = req.header("X-Goog-Resource-State");
    const resourceId = req.header("X-Goog-Resource-Id");
    const channelId = req.header("X-Goog-Channel-Id");

    console.log("📩 Notificación recibida:");
    console.log("  Resource State:", state);
    console.log("  Resource ID:", resourceId);
    console.log("  Channel ID:", channelId);

    if (state === "sync") {
      console.log("⚪ Primera sincronización (sync) - no procesamos eventos ahora.");
      return res.status(200).send();
    }

    // Solo procesar si es 'exists' o 'not_exists'
    if (state !== "exists" && state !== "not_exists") {
      console.log("⚪ Estado no procesable por este webhook:", state);
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
      maxResults: 20,
    });

    const items = events.data.items || [];
    if (items.length === 0) {
      console.log("⚪ No hay eventos recientes (según updatedMin).");
      return res.status(200).send();
    }

    for (const ev of items) {
      if (!ev.id) continue;
      if (processingEvents.has(ev.id)) continue;
      processingEvents.add(ev.id);

      try {
        if (ev.status === "cancelled") {
          const notionPageId = ev.extendedProperties?.private?.notion_page_id;
          if (notionPageId) {
            await archiveNotionPage(notionPageId);
          } else {
            console.log(`🔴 Evento cancelado ${ev.id} (sin notion_page_id).`);
          }
          continue;
        }

        const origin = ev.extendedProperties?.private?.origin;
        const notionPageId = ev.extendedProperties?.private?.notion_page_id;

        // Si origin === 'calendar' y no hay notionPageId, ignorar (previene loop)
        if (origin === "calendar" && !notionPageId) {
          console.log(`⚪ Ignorado evento ${ev.id} con origin=calendar y sin notion_page_id`);
          continue;
        }

        // Si existe notionPageId, actualizar la página
        if (notionPageId) {
          const archived = await isPageArchived(notionPageId);
          if (archived) {
            console.log(`⚪ Página Notion ${notionPageId} ya archivada — ignoro.`);
            continue;
          }

          let startDate, endDate;
          if (isAllDayEvent(ev)) {
            ({ startDate, endDate } = formatAllDayDates(ev.start.date, ev.end?.date));
          } else {
            startDate = ev.start?.dateTime;
            endDate = ev.end?.dateTime || null;
          }

          const updateProps = {
            Título: { title: [{ type: "text", text: { content: ev.summary || "Sin título" } }] },
          };
          if (startDate) {
            updateProps["Fecha de entrega"] = {
              date: endDate ? { start: startDate, end: endDate } : { start: startDate },
            };
          }

          await notion.pages.update({
            page_id: notionPageId,
            properties: updateProps,
          });

          console.log(`📝 Actualizada página Notion ${notionPageId} ← evento ${ev.id}`);
        }

        // Marcar evento con origin: "calendar" para evitar loops
        await calendar.events.patch({
          calendarId: CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: {
              private: { ...(ev.extendedProperties?.private || {}), origin: "calendar" },
            },
          },
        });

        // Si no había notionPageId, crear página nueva y vincularla
        if (!notionPageId) {
          const newPageId = await createNotionPage(ev);
          if (!newPageId) {
            console.warn(`⚠️ No se creó página Notion para evento ${ev.id}`);
          } else {
            await calendar.events.patch({
              calendarId: CALENDAR_ID,
              eventId: ev.id,
              requestBody: {
                extendedProperties: {
                  private: { origin: "calendar", notion_page_id: newPageId },
                },
              },
            });
            console.log(`🔗 Evento ${ev.id} vinculado a Notion page ${newPageId}`);
          }
        }
      } catch (err) {
        console.warn("⚠️ Error procesando evento:", err?.message || err);
      } finally {
        processingEvents.delete(ev.id);
      }
    }

    res.status(200).send();
  } catch (error) {
    console.error("❌ Error en webhook:", error?.response?.data || error?.message || error);
    res.status(500).send("Error interno");
  }
});

module.exports = router;
