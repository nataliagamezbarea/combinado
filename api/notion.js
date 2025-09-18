// notion-to-calendar.js
const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");
const { Client } = require("@notionhq/client");

const router = express.Router();

// Middleware para capturar rawBody
router.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// --- Variables de entorno ---
const VERIFICATION_TOKEN = process.env.NOTION_VERIFICATION_TOKEN;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

// --- Cliente de Notion ---
const notion = new Client({ auth: NOTION_API_KEY });

// --- Google OAuth2 Client ---
function getGoogleAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !REFRESH_TOKEN) {
    throw new Error("Faltan variables de entorno para Google OAuth2");
  }
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oAuth2Client;
}

// --- Función para extraer título de Notion ---
function extractTitleFromPage(page) {
  const props = page.properties || {};
  for (const key in props) {
    if (props[key].type === "title" && Array.isArray(props[key].title) && props[key].title.length > 0) {
      return props[key].title.map((t) => t.plain_text).join(" ");
    }
  }
  return "Sin título";
}

// --- Funciones de fecha ---
function addDaysToDateString(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

function extractDateFromPage(page) {
  const fecha = page.properties?.["Fecha de entrega"]?.date;
  if (!fecha?.start) return null;

  const startRaw = fecha.start;
  const hasTime = startRaw.includes("T");

  if (hasTime) {
    const start = { dateTime: startRaw, timeZone: "UTC" };
    const end = fecha.end ? { dateTime: fecha.end, timeZone: "UTC" } : { dateTime: new Date(Date.parse(startRaw) + 60 * 60 * 1000).toISOString(), timeZone: "UTC" };
    return { start, end };
  } else {
    const start = { date: startRaw };
    const endDate = fecha.end ? fecha.end : addDaysToDateString(startRaw, 1);
    const end = { date: endDate };
    return { start, end };
  }
}

// --- Buscar evento existente ---
async function findCalendarEventByNotionPageId(pageId) {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const events = await calendar.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: `notion_page_id=${pageId}`,
    showDeleted: false,
    maxResults: 1,
    singleEvents: true,
  });
  return events.data.items?.[0] || null;
}

// --- Endpoint principal ---
router.post("/", async (req, res) => {
  try {
    console.log("📩 Webhook recibido:", JSON.stringify(req.body, null, 2));

    // --- Manejo del token de verificación (primer request de Notion) ---
    if (req.body?.verification_token) {
      console.log("🔹 Solicitud de verificación del webhook");
      return res.status(200).send({ verification_token: req.body.verification_token });
    }

    // --- Validación de firma ---
    const signature = req.header("X-Notion-Signature");
    if (!signature) return res.status(400).send("Falta cabecera de firma");
    if (!VERIFICATION_TOKEN) return res.status(500).send("Falta VERIFICATION_TOKEN");

    const computed = crypto.createHmac("sha256", VERIFICATION_TOKEN).update(req.rawBody).digest("hex");
    const expected = `sha256=${computed}`;
    let valid = false;
    try {
      valid = crypto.timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
    } catch {
      valid = false;
    }
    if (!valid) return res.status(403).send("Firma inválida");
    console.log("✅ Firma de Notion validada correctamente");

    // --- Procesamiento de eventos ---
    const { type, entity } = req.body;
    if (!entity || entity.type !== "page") {
      console.log("⚠️ Evento ignorado: no es un page");
      return res.status(200).send();
    }

    const pageId = entity.id;
    const page = await notion.pages.retrieve({ page_id: pageId });
    const title = extractTitleFromPage(page);
    const dateRange = extractDateFromPage(page);
    const { start, end } = dateRange || {};

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const existingEvent = await findCalendarEventByNotionPageId(pageId);

    // --- CREACIÓN ---
    if (type === "page.created" && !existingEvent) {
      const eventBody = {
        summary: title,
        start,
        end,
        extendedProperties: { private: { notion_page_id: pageId, origin: "notion" } },
      };
      const inserted = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: eventBody });
      console.log("✅ Evento creado en Google Calendar:", inserted.data);
      return res.status(200).send();
    }

    // --- ACTUALIZACIÓN ---
    if (type === "page.properties_updated" && existingEvent) {
      const eventBody = {
        summary: title,
        start,
        end,
        extendedProperties: {
          private: { ...(existingEvent.extendedProperties?.private || {}), notion_page_id: pageId, origin: "notion" },
        },
      };
      const patched = await calendar.events.patch({ calendarId: CALENDAR_ID, eventId: existingEvent.id, requestBody: eventBody });
      console.log("📝 Evento actualizado en Google Calendar:", patched.data);
      return res.status(200).send();
    }

    // --- ELIMINACIÓN ---
    if (type === "page.deleted" && existingEvent) {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: existingEvent.id });
      console.log("🗑️ Evento eliminado de Google Calendar:", existingEvent.id);
      return res.status(200).send();
    }

    console.log("⚠️ Evento recibido que no coincide con creación/actualización/eliminación:", JSON.stringify(req.body, null, 2));
    return res.status(200).send();
  } catch (err) {
    console.error("❌ Error en webhook de Notion:", err?.response?.data || err);
    return res.status(500).send("Error interno");
  }
});

module.exports = router;
