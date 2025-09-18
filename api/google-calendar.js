// test-calendar.js
require("dotenv").config();
const { google } = require("googleapis");

// --- Variables de entorno ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

async function main() {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !CALENDAR_ID) {
      throw new Error("⚠️ Faltan variables de entorno");
    }

    // Autenticación con Google
    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

    const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

    // Obtener últimos eventos
    const eventsResponse = await calendar.events.list({
      calendarId: CALENDAR_ID,
      maxResults: 10,
      singleEvents: true,
      orderBy: "updated",
    });

    const events = eventsResponse.data.items || [];

    console.log("📅 Eventos obtenidos:");
    if (events.length === 0) {
      console.log("⚠️ No hay eventos en este calendario");
      return;
    }

    events.forEach((event, i) => {
      const title = event.summary || "Sin título";
      const start = event.start?.dateTime || event.start?.date;
      const end = event.end?.dateTime || event.end?.date;
      console.log(`${i + 1}. ${title} (${start} → ${end}) | id=${event.id}`);
    });
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

main();
