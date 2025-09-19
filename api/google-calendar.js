const express = require("express");
const { google } = require("googleapis");

const router = express.Router();

// ⚙️ ENV
const OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

const WEBHOOK_URL = process.env.WEBHOOK_URL;

// 🛠️ Helper OAuth2
function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  if (OAUTH_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  }
  return oauth2Client;
}

// 🟢 GET: Login para obtener el refresh_token
router.get("/login", (req, res) => {
  const oauth2Client = getGoogleAuth();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events"],
  });
  res.redirect(url);
});

// 🟢 GET: Callback OAuth2 para obtener y mostrar refresh_token
router.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  const oauth2Client = getGoogleAuth();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log("✅ Tokens recibidos:", tokens);

    if (tokens.refresh_token) {
      console.log("📌 REFRESH_TOKEN (añádelo a .env como GOOGLE_REFRESH_TOKEN):\n", tokens.refresh_token);
    }

    res.send("<h2>✅ Autenticado correctamente</h2><p>Revisa la consola del servidor para copiar tu refresh_token</p>");
  } catch (err) {
    console.error("❌ Error obteniendo tokens:", err.message);
    res.status(500).send("Error en autenticación");
  }
});

// 🟢 GET: Crear canal de notificación (igual que antes)
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

    res.json({
      message: "Canal creado correctamente",
      data: watchResponse.data,
    });
  } catch (error) {
    console.error("❌ Error creando canal:", error);
    res.status(500).json({ error: error.message });
  }
});

// 📨 POST: Webhook que recibe notificaciones de cambios (igual que antes)
router.post("/webhook", async (req, res) => {
  try {
    const state = req.header("X-Goog-Resource-State");
    const resourceId = req.header("X-Goog-Resource-Id");
    const channelId = req.header("X-Goog-Channel-Id");

    console.log("📩 Notificación recibida:");
    console.log("Resource State:", state);
    console.log("Resource ID:", resourceId);
    console.log("Channel ID:", channelId);

    if (state === "sync") {
      console.log("⚪ Canal conectado, primera sincronización");
      return res.status(200).send();
    }

    if (state === "exists" || state === "not_exists") {
      const auth = getGoogleAuth();
      const calendar = google.calendar({ version: "v3", auth });

      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

      const events = await calendar.events.list({
        calendarId: CALENDAR_ID,
        updatedMin: twoMinutesAgo,
        showDeleted: true,
        singleEvents: true,
        orderBy: "updated",
      });

      if (events.data.items.length === 0) {
        console.log("⚪ No hay eventos recientes");
      } else {
        for (const ev of events.data.items) {
          if (ev.status === "cancelled") {
            console.log(`🔴 Eliminado: ${ev.id}`);
          } else if (ev.created === ev.updated) {
            console.log(`🟢 Creado: ${ev.summary || "(sin título)"} (${ev.id})`);
          } else {
            console.log(`📝 Modificado: ${ev.summary || "(sin título)"} (${ev.id})`);
          }
        }
      }
    }

    res.status(200).send();
  } catch (error) {
    console.error("❌ Error procesando notificación:", error);
    res.status(500).send("Error interno");
  }
});

module.exports = router;
