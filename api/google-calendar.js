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
  console.log("📩 Webhook recibido de Google Calendar!");
  console.log("Headers:", req.headers);

  const state = req.header("X-Goog-Resource-State");
  console.log("X-Goog-Resource-State:", state);

  if (state === "sync") {
    console.log("Sync event recibido, ignorando...");
    return res.status(200).send();
  }

  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    // Listar todos los eventos
    const eventsResponse = await calendar.events.list({
      calendarId: CALENDAR_ID,
      singleEvents: true,
      maxResults: 50,
      showDeleted: true, // Incluye eventos cancelados
      orderBy: "updated", // Opcional: los más recientes primero
    });

    const events = eventsResponse.data.items;

    if (!events || events.length === 0) {
      console.log("No hay eventos para mostrar.");
      return res.status(200).send();
    }

    // Mostrar todos los eventos
    console.log("🎯 Todos los eventos:");
    events.forEach((evento, index) => {
      console.log(`${index + 1}. Título: ${evento.summary}`);
      console.log(`   Estado: ${evento.status}`);
      console.log(`   Creado: ${evento.created}`);
      console.log(`   Actualizado: ${evento.updated}`);
      console.log(`   Link: ${evento.htmlLink}`);
      console.log("   ---------------------------");
    });

    // Identificar el último modificado
    const ultimoEvento = events.reduce((prev, current) => {
      return new Date(prev.updated) > new Date(current.updated) ? prev : current;
    });

    console.log("🎯 Último evento modificado:");
    console.log("Título:", ultimoEvento.summary);
    console.log("Estado:", ultimoEvento.status);
    console.log("Actualizado:", ultimoEvento.updated);
    console.log("Link:", ultimoEvento.htmlLink);

    res.status(200).send();
  } catch (err) {
    console.error("❌ Error listando eventos:", err);
    res.status(500).send();
  }
});

module.exports = router;
