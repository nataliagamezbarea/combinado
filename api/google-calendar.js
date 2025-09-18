// calendar-to-notion.js
const express = require("express");
const { google } = require("googleapis");
const { Client } = require("@notionhq/client");

const router = express.Router();

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const notion = new Client({ auth: NOTION_API_KEY });
const processingEvents = new Set();

// --- Google OAuth2 Client ---
function getGoogleAuth() {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oAuth2Client;
}

// --- Funciones auxiliares ---
function isAllDayEvent(ev) {
  return !!(ev.start?.date && !ev.start?.dateTime);
}

function formatAllDayDates(start, end) {
  const startDate = start;
  let endDate = end;

  if (endDate) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - 1); // restar un día porque end.date es exclusivo
    endDate = d.toISOString().split("T")[0];
  }

  return { startDate, endDate };
}

// /login
router.get("/login", (req, res) => {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });
  res.redirect(authUrl);
});

// /callback
// /callback
router.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log("Tokens obtenidos:", tokens);

    if (tokens.refresh_token) {
      console.log(`REFRESH_TOKEN=${tokens.refresh_token}`);
      res.send(`
        <h1>Tokens generados</h1>
        <p><strong>REFRESH_TOKEN:</strong> ${tokens.refresh_token}</p>
        <pre>${JSON.stringify(tokens, null, 2)}</pre>
      `);
    } else {
      console.log("No se recibió refresh token. Asegúrate de usar access_type: 'offline'.");
      res.send(`
        <h1>Error</h1>
        <p>No se recibió <strong>refresh token</strong>. Asegúrate de usar <code>access_type: 'offline'</code>.</p>
        <pre>${JSON.stringify(tokens, null, 2)}</pre>
      `);
    }

  } catch (error) {
    console.error("Error obteniendo tokens:", error);
    res.status(500).send(`<h1>Error obteniendo tokens</h1><p>${error.message}</p>`);
  }
});



// --- Endpoint GET para crear un watch en Google Calendar ---
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

// --- Funciones para Notion ---
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

// --- Webhook que recibe notificaciones de cambios en el calendario ---
router.post("/webhook", async (req, res) => {
  try {
    const state = req.header("X-Goog-Resource-State");
    if (state === "sync") return res.status(200).send();

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    // Obtenemos solo los últimos eventos modificados
    const events = await calendar.events.list({
      calendarId: CALENDAR_ID,
      orderBy: "updated",
      singleEvents: true,
      showDeleted: true,
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

        // --- Actualizar página existente ---
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

        // Marcar evento como origin: "calendar"
        await calendar.events.patch({
          calendarId: CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: { private: { ...(ev.extendedProperties?.private || {}), origin: "calendar" } },
          },
        });

        // --- Crear página nueva si no existía ---
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
