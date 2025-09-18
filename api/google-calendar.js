// calendar-to-notion-oauth-robust.js
const express = require("express");
const { google } = require("googleapis");
const { Client } = require("@notionhq/client");

const router = express.Router();

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const notion = new Client({ auth: NOTION_API_KEY });
const processingEvents = new Set();

// --- Autenticación OAuth2 ---
function getGoogleAuth() {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oAuth2Client;
}

// --- Helpers de fechas ---
function isAllDayEvent(ev) {
  return !!(ev.start?.date && !ev.start?.dateTime);
}

function formatAllDayDates(start, end) {
  const startDate = start; // "YYYY-MM-DD"
  let endDate = end;

  if (endDate) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - 1); // end.date es exclusivo en Google → restamos 1 día
    endDate = d.toISOString().split("T")[0]; // "YYYY-MM-DD"
  }

  return { startDate, endDate };
}

// --- Buscar página en Notion por título + fecha (fallback por título) ---
async function findNotionPage(ev) {
  try {
    const title = ev.summary || "Sin título";
    let startDate;

    if (isAllDayEvent(ev)) {
      ({ startDate } = formatAllDayDates(ev.start.date, ev.end?.date));
    } else {
      startDate = ev.start?.dateTime; // ISO datetime
    }

    // Primero intentamos título + fecha exacta
    const filters = [{ property: "Título", title: { equals: title } }];
    if (startDate) {
      filters.push({ property: "Fecha de entrega", date: { equals: startDate } });
    }

    try {
      const q = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: { and: filters },
        page_size: 1,
      });

      if (q.results && q.results.length > 0) {
        const pageId = q.results[0].id;
        // si la página estaba archivada, la desarchivamos
        if (q.results[0].archived) {
          await notion.pages.update({ page_id: pageId, archived: false });
        }
        return pageId;
      }
    } catch (errQuery) {
      // Si falla (por ejemplo propiedades no existen), lo registramos y fallamos al siguiente fallback
      console.warn("⚠️ Error al query Notion (título+fecha):", errQuery.message);
    }

    // Fallback: buscar solo por título (puede producir falsos positivos pero evita duplicados en muchos casos)
    try {
      const q2 = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: { property: "Título", title: { equals: title } },
        page_size: 1,
      });
      if (q2.results && q2.results.length > 0) {
        const pageId = q2.results[0].id;
        if (q2.results[0].archived) {
          await notion.pages.update({ page_id: pageId, archived: false });
        }
        return pageId;
      }
    } catch (errQuery2) {
      console.warn("⚠️ Error al query Notion (título):", errQuery2.message);
    }

    return null;
  } catch (err) {
    console.warn("⚠️ findNotionPage error:", err.message);
    return null;
  }
}

// --- Crear página en Notion (primero verifica si ya existe con findNotionPage) ---
async function createNotionPage(ev) {
  try {
    // si ya existe, devolvemos su id en lugar de crear otra
    const existing = await findNotionPage(ev);
    if (existing) {
      console.log("⏳ Página Notion encontrada (no se crea):", existing);
      return existing;
    }

    let startDate, endDate;

    if (isAllDayEvent(ev)) {
      ({ startDate, endDate } = formatAllDayDates(ev.start.date, ev.end?.date));
    } else {
      startDate = ev.start?.dateTime;
      endDate = ev.end?.dateTime || null;
    }

    const properties = {
      Título: {
        title: [{ type: "text", text: { content: ev.summary || "Sin título" } }],
      },
    };

    if (startDate) {
      properties["Fecha de entrega"] = {
        date: {
          start: startDate,
          end: endDate,
        },
      };
    }

    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
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

// --- Webhook que recibe notificaciones de cambios en el calendario ---
router.post("/webhook", async (req, res) => {
  try {
    const state = req.header("X-Goog-Resource-State");
    console.log("📩 Webhook recibido → state:", state);

    // responder rápido
    res.status(200).send();

    if (state === "sync") return;
    if (state !== "exists" && state !== "not_exists") return; // solo procesar cambios / borrados

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    // Solo eventos actualizados recientemente (evita sobrecarga). Ajusta a 2-5min si lo necesitas.
    const updatedMin = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const events = await calendar.events.list({
      calendarId: CALENDAR_ID,
      orderBy: "updated",
      updatedMin,
      singleEvents: true,
      showDeleted: true,
      maxResults: 20,
    });

    console.log(`🔎 Encontrados ${events.data.items?.length || 0} eventos actualizados desde ${updatedMin}`);

    for (const ev of events.data.items || []) {
      // proteger contra procesamientos concurrentes dentro de la misma instancia
      if (processingEvents.has(ev.id)) continue;
      processingEvents.add(ev.id);

      try {
        // Si el evento fue borrado / cancelado
        if (ev.status === "cancelled") {
          const notionPageId = ev.extendedProperties?.private?.notion_page_id;
          if (notionPageId) {
            await archiveNotionPage(notionPageId);
            // Si queremos también borrar la relación del evento, podríamos quitar notion_page_id aquí.
          }
          continue;
        }

        const origin = ev.extendedProperties?.private?.origin;
        let notionPageId = ev.extendedProperties?.private?.notion_page_id;

        // Si el evento ya tiene notion_page_id y origin=calendar, lo actualizamos normalmente
        // Si no tiene notion_page_id, intentamos localizar una página existente en Notion (previene duplicados en all-day)
        if (!notionPageId) {
          const foundPageId = await findNotionPage(ev);
          if (foundPageId) {
            // enlazamos el evento al pageId encontrado para evitar creación duplicada
            try {
              await calendar.events.patch({
                calendarId: CALENDAR_ID,
                eventId: ev.id,
                requestBody: {
                  extendedProperties: {
                    private: { ...(ev.extendedProperties?.private || {}), origin: "calendar", notion_page_id: foundPageId },
                  },
                },
              });
              notionPageId = foundPageId;
              console.log("🔗 Evento vinculado a página existente en Notion:", foundPageId);
            } catch (errPatch) {
              console.warn("⚠️ No se pudo parchear evento con notion_page_id (pero seguiremos):", errPatch.message);
              // si falla el patch, seguimos: la búsqueda nos evita crear duplicados inmediatos porque createNotionPage vuelve a consultar
              notionPageId = foundPageId;
            }
          }
        }

        // Si ya existe una página vinculada → actualizarla (si no está archivada)
        if (notionPageId) {
          const archived = await isPageArchived(notionPageId);
          if (!archived) {
            let startDate, endDate;
            if (isAllDayEvent(ev)) {
              ({ startDate, endDate } = formatAllDayDates(ev.start.date, ev.end?.date));
            } else {
              startDate = ev.start?.dateTime;
              endDate = ev.end?.dateTime || null;
            }

            try {
              await notion.pages.update({
                page_id: notionPageId,
                properties: {
                  Título: { title: [{ type: "text", text: { content: ev.summary || "Sin título" } }] },
                  "Fecha de entrega": startDate ? { date: { start: startDate, end: endDate } } : undefined,
                },
              });
              console.log("♻️ Página Notion actualizada:", notionPageId);
            } catch (errUpdate) {
              console.warn("⚠️ Error actualizando página Notion:", errUpdate.message);
            }
          } else {
            console.log("⏸️ Página vinculada está archivada, ignorando:", notionPageId);
          }
          // Aun así nos aseguramos de que origin esté marcado
          try {
            await calendar.events.patch({
              calendarId: CALENDAR_ID,
              eventId: ev.id,
              requestBody: {
                extendedProperties: {
                  private: { ...(ev.extendedProperties?.private || {}), origin: "calendar" },
                },
              },
            });
          } catch (errPatchOrigin) {
            console.warn("⚠️ No se pudo parchear origin (continuamos):", errPatchOrigin.message);
          }
          continue;
        }

        // Si no hay notionPageId todavía → proceder a crear (createNotionPage tiene su propia búsqueda interna)
        // Marcar origin=calendar lo antes posible para reducir carreras
        try {
          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: ev.id,
            requestBody: {
              extendedProperties: { private: { ...(ev.extendedProperties?.private || {}), origin: "calendar" } },
            },
          });
        } catch (errPatch) {
          console.warn("⚠️ No se pudo parchear origin antes de crear (continuamos):", errPatch.message);
        }

        // Crear página (createNotionPage llamará a findNotionPage y devolverá existente si aparece durante la carrera)
        const newPageId = await createNotionPage(ev);
        if (!newPageId) {
          console.warn("⚠️ No se creó página Notion para evento:", ev.id);
          continue;
        }

        // Guardar notion_page_id en el evento para vincularlos
        try {
          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: ev.id,
            requestBody: {
              extendedProperties: { private: { origin: "calendar", notion_page_id: newPageId } },
            },
          });
        } catch (errPatch2) {
          console.warn("⚠️ No se pudo parchear notion_page_id en el evento (pero la página existe):", errPatch2.message);
        }

        console.log("🆕 Página creada y vinculada a evento Calendar:", newPageId);
      } catch (err) {
        console.warn("⚠️ Error procesando evento:", err.message);
      } finally {
        processingEvents.delete(ev.id);
      }
    }
  } catch (error) {
    console.error("❌ Error en webhook:", error?.response?.data || error.message || error);
  }
});

// Export router
module.exports = router;
