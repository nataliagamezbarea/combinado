// calendar-to-notion-min.js
const express = require("express");
const { google } = require("googleapis");

const router = express.Router();

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // Debe ser HTTPS y público

// --- Google OAuth2 Client ---
function getGoogleAuth() {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oAuth2Client;
}

// --- Crear watch en Google Calendar ---
router.get("/create-watch", async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const watchId = "calendar-to-notion-watch"; // ID fijo

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

// --- Endpoint para recibir notificaciones de Google Calendar ---
router.post("/webhook", async (req, res) => {
  console.log("📩 Webhook recibido!");
  const state = req.header("X-Goog-Resource-State");
  const resourceId = req.header("X-Goog-Resource-Id");
  const resourceUri = req.header("X-Goog-Resource-Uri");

  if (state === "sync") return res.status(200).send();

  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    if (resourceId && resourceUri) {
      const url = new URL(resourceUri);
      const pathSegments = url.pathname.split("/");
      const eventId = pathSegments[pathSegments.length - 1];

      if (eventId) {
        const eventResponse = await calendar.events.get({
          calendarId: CALENDAR_ID,
          eventId,
          showDeleted: true,
        });

        const event = eventResponse.data;
        console.log(event.status === "cancelled" ? "⚠️ Evento cancelado" : "🎯 Evento modificado", event.summary);
        console.log("Creado:", event.created, "Actualizado:", event.updated, "Link:", event.htmlLink);
        return res.status(200).send();
      }
    }

    // Fallback
    const eventsResponse = await calendar.events.list({
      calendarId: CALENDAR_ID,
      singleEvents: true,
      showDeleted: true,
      maxResults: 10,
      orderBy: "updated",
    });

    const events = eventsResponse.data.items || [];
    if (events.length === 0) return res.status(200).send();

    events.forEach((evento, i) => {
      console.log(`${i + 1}. ${evento.summary} (${evento.status}) - ${evento.updated}`);
    });

    res.status(200).send();
  } catch (err) {
    console.error("❌ Error obteniendo eventos:", err);
    res.status(500).send();
  }
});

module.exports = router;
