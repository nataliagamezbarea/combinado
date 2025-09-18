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
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// --- Clientes ---
const notion = new Client({ auth: NOTION_API_KEY });

function getGoogleAuth() {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oAuth2Client;
}

// --- Endpoint para crear el canal de watch ---
router.get("/create-watch", async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const response = await calendar.events.watch({
      calendarId: CALENDAR_ID,
      requestBody: {
        id: Math.random().toString(36).substring(2), // ID único
        type: "webhook",
        address: WEBHOOK_URL, // Debe ser HTTPS público
      },
    });

    console.log("✅ Canal de watch creado:", response.data);
    res.json({ ok: true, data: response.data });
  } catch (err) {
    console.error("❌ Error creando watch:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Webhook que recibe las notificaciones ---
router.post("/webhook", async (req, res) => {
  console.log("📩 Webhook recibido desde Google Calendar");
  res.status(200).send();

  const state = req.header("X-Goog-Resource-State");
  console.log("📌 Estado del recurso:", state);

  if (state === "sync") return;
  if (state !== "exists") return;

  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const updatedMin = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const eventsResponse = await calendar.events.list({
      calendarId: CALENDAR_ID,
      maxResults: 1,
      orderBy: "updated",
      updatedMin,
    });

    console.log("📦 Eventos recibidos:", eventsResponse.data.items);

    const lastEvent = eventsResponse.data.items?.[0];
    if (!lastEvent) {
      console.log("⚠️ No hay eventos recientes");
      return;
    }

    const title = lastEvent.summary || "Sin título";
    const start = lastEvent.start?.dateTime || lastEvent.start?.date;
    const end = lastEvent.end?.dateTime || lastEvent.end?.date;

    console.log(`🎯 Último evento: ${title} (${start} → ${end})`);

    await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Nombre: { title: [{ text: { content: title } }] },
        "Fecha de entrega": { date: { start, end } },
      },
    });

    console.log("✅ Página creada en Notion con el último evento");
  } catch (err) {
    console.error("❌ Error procesando webhook:", err.message);
  }
});


module.exports = router;
