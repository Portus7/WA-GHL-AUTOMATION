const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const { webcrypto } = require("crypto");
const fs = require("fs");
const { Pool } = require("pg");
const axios = require("axios");

// Parche crypto para Baileys
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// -----------------------------
// Config & Estado Global
// -----------------------------
const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA = process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
const AGENCY_ROW_ID = "__AGENCY__";

// 🧠 GESTOR DE SESIONES (MEMORIA)
// Mapa: locationId -> { sock, qr, isConnected }
const sessions = new Map(); 

// -----------------------------
// PostgreSQL
// -----------------------------
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

// -----------------------------
// HELPERS: BD Tokens (GHL)
// -----------------------------
async function saveTokens(locationId, tokenData) {
  const sql = `
    INSERT INTO auth_db (locationid, raw_token)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (locationid) DO UPDATE
    SET raw_token = EXCLUDED.raw_token
  `;
  await pool.query(sql, [locationId, JSON.stringify(tokenData)]);
}

async function getTokens(locationId) {
  const result = await pool.query(
    "SELECT raw_token FROM auth_db WHERE locationid = $1",
    [locationId]
  );
  return result.rows[0]?.raw_token || null;
}

// -----------------------------
// HELPERS: Autenticación GHL
// -----------------------------

// Asegurar token de AGENCIA
async function ensureAgencyToken() {
  let tokens = await getTokens(AGENCY_ROW_ID);
  if (!tokens) throw new Error("No hay tokens de agencia guardados en BD");

  const companyId = tokens.companyId;

  try {
    // Prueba de validez
    await axios.get(
      `https://services.leadconnectorhq.com/companies/${companyId}`,
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
          Version: GHL_API_VERSION,
        },
        params: { limit: 1 },
        timeout: 15000,
      }
    );
    return tokens.access_token;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log("🔄 Token de agencia expirado → refrescando...");
      try {
        const body = new URLSearchParams({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        });

        const refreshRes = await axios.post(
          "https://services.leadconnectorhq.com/oauth/token",
          body.toString(),
          {
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 15000,
          }
        );

        const newTokens = refreshRes.data;
        await saveTokens(AGENCY_ROW_ID, newTokens);
        console.log("✅ Token de agencia refrescado correctamente");
        return newTokens.access_token;
      } catch (e) {
        console.error("❌ Error refrescando token agencia:", e.message);
        throw new Error("No se pudo refrescar el token de agencia");
      }
    }
    throw err;
  }
}

// Asegurar token de LOCATION
async function ensureLocationToken(locationId, contactId) {
  let tokens = await getTokens(locationId);
  if (!tokens) throw new Error(`No hay tokens guardados para ${locationId}`);

  let locationToken = tokens.locationAccess;
  if (!locationToken) throw new Error(`No hay locationAccess para ${locationId}`);

  try {
    // Si hay contactId, probamos acceso para verificar token
    if (contactId) {
      await axios.get(
        `https://services.leadconnectorhq.com/contacts/${contactId}`,
        {
          headers: {
            Authorization: `Bearer ${locationToken.access_token}`,
            Accept: "application/json",
            Version: GHL_API_VERSION,
            "Location-Id": locationToken.locationId,
          },
          timeout: 15000,
        }
      );
    }
    return {
      accessToken: locationToken.access_token,
      realLocationId: locationToken.locationId,
    };

  } catch (err) {
    if (err.response?.status === 401) {
      console.log(`🔄 Token expirado location ${locationId} → refrescando...`);
      try {
        const body = new URLSearchParams({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: locationToken.refresh_token,
        });

        const refreshRes = await axios.post(
          "https://services.leadconnectorhq.com/oauth/token",
          body.toString(),
          {
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 15000,
          }
        );

        const newToken = refreshRes.data;
        // Guardamos manteniendo la estructura original
        await saveTokens(locationId, { ...tokens, locationAccess: newToken });
        console.log(`✅ Token refrescado para location ${locationId}`);

        return {
          accessToken: newToken.access_token,
          realLocationId: newToken.locationId,
        };
      } catch (e) {
        console.error(`❌ Error refrescando token location ${locationId}:`, e.message);
        throw new Error("No se pudo refrescar token location");
      }
    }
    throw err;
  }
}

// Wrappers Axios
async function callGHLWithAgency(config) {
  const accessToken = await ensureAgencyToken();
  const headers = {
    Accept: "application/json",
    Version: GHL_API_VERSION,
    ...(config.headers || {}),
    Authorization: `Bearer ${accessToken}`,
  };
  return axios({ ...config, headers });
}

async function callGHLWithLocation(locationId, config, contactId) {
  const { accessToken, realLocationId } = await ensureLocationToken(locationId, contactId);
  const headers = {
    Accept: "application/json",
    Version: GHL_API_VERSION,
    ...(config.headers || {}),
    Authorization: `Bearer ${accessToken}`,
    "Location-Id": realLocationId,
  };
  return axios({ ...config, headers });
}

// -----------------------------
// HELPERS: Routing y Utilidades
// -----------------------------
function normalizePhone(phone) {
  if (!phone) return "";
  const cleaned = phone.replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+")) return `+${cleaned}`;
  return cleaned;
}

function extractPhoneFromJid(jid) {
  return jid.split("@")[0].split(":")[0];
}

async function saveRouting(phone, locationId, contactId) {
  const normalizedPhone = normalizePhone(phone);
  const sql = `
    INSERT INTO phone_routing (phone, location_id, contact_id, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (phone) DO UPDATE
    SET location_id = EXCLUDED.location_id,
        contact_id = COALESCE(EXCLUDED.contact_id, phone_routing.contact_id),
        updated_at = NOW();
  `;
  try {
    await pool.query(sql, [normalizedPhone, locationId, contactId]);
  } catch (e) {
    console.error("❌ Error guardando routing:", e);
  }
}

async function getRoutingForPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  const sql = "SELECT location_id, contact_id FROM phone_routing WHERE phone = $1";
  try {
    const res = await pool.query(sql, [normalizedPhone]);
    if (res.rows.length > 0) {
      return {
        locationId: res.rows[0].location_id,
        contactId: res.rows[0].contact_id
      };
    }
    return null;
  } catch (e) {
    console.error("❌ Error leyendo routing:", e);
    return null;
  }
}

// -----------------------------
// HELPERS: Lógica de Contactos GHL
// -----------------------------
async function findOrCreateGHLContact(locationId, phone, waName, contactId) {
  const normalizedPhone = normalizePhone(phone);

  // 1. Intentar buscar por ID si lo tenemos
  if (contactId) {
    try {
      const lookupRes = await callGHLWithLocation(locationId, {
        method: "GET",
        url: `https://services.leadconnectorhq.com/contacts/${contactId}`,
        timeout: 15000,
      });
      const contact = lookupRes.data.contact || lookupRes.data;
      if (contact?.id) {
        console.log("✅ Contacto existente validado:", contactId);
        return contact;
      }
    } catch (err) {
      if (err.response?.status !== 404) {
        console.error("Error buscando contacto:", err.message);
      }
      // Si es 404, continuamos para crear
    }
  }

  // 2. Crear nuevo o buscar por teléfono (GHL maneja duplicados en POST devolviendo 400+meta)
  try {
    const createdRes = await callGHLWithLocation(locationId, {
      method: "POST",
      url: "https://services.leadconnectorhq.com/contacts/",
      data: {
        locationId,
        phone: normalizedPhone,
        firstName: waName,
        source: "WhatsApp Baileys",
      },
      timeout: 15000,
    });
    const created = createdRes.data.contact || createdRes.data;
    console.log("👤 Nuevo Contacto creado:", created.id);
    return created;
  } catch (err) {
    const statusCode = err.response?.status;
    const body = err.response?.data;

    // Manejo de duplicados GHL (Error 400 con meta.contactId)
    if (statusCode === 400 && body?.meta?.contactId) {
      console.log("ℹ️ Contacto ya existía (recuperado de error 400):", body.meta.contactId);
      return { id: body.meta.contactId, phone: normalizedPhone };
    }
    console.error("❌ Error creando contacto GHL:", statusCode, body || err.message);
    return null;
  }
}

async function sendMessageToGHLConversation(locationId, contactId, text) {
  try {
    await callGHLWithLocation(
      locationId,
      {
        method: "POST",
        url: "https://services.leadconnectorhq.com/conversations/messages/inbound",
        data: {
          type: "SMS",
          contactId,
          locationId,
          message: text,
          direction: "inbound",
        },
        timeout: 15000,
      },
      contactId
    );
    console.log(`📨 Inbound enviado a GHL (Contact: ${contactId})`);
  } catch (err) {
    console.error("❌ Error enviando Inbound a GHL:", err.message);
  }
}

// -----------------------------
// Lógica WhatsApp Multi-Tenant
// -----------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Helper para enviar mensajes salientes
async function sendWhatsAppMessage(phone, text, locationId) {
  const session = sessions.get(locationId);
  if (!session || !session.isConnected || !session.sock) {
    console.error(`⚠️ WhatsApp no conectado para location ${locationId}`);
    return;
  }
  const waPhone = normalizePhone(phone);
  const jid = waPhone.replace("+", "") + "@s.whatsapp.net";

  try {
    await session.sock.sendMessage(jid, { text });
    console.log(`📤 [${locationId}] Enviado a ${waPhone}: ${text}`);
  } catch (err) {
    console.error(`❌ Error enviando mensaje WA en ${locationId}:`, err);
  }
}

// Función Principal: Iniciar WhatsApp para una Location
async function startWhatsApp(locationId) {
  // Si ya existe y tiene socket, retornar
  const existing = sessions.get(locationId);
  if (existing && existing.sock) return existing;

  // Inicializar estado
  sessions.set(locationId, { sock: null, qr: null, isConnected: false });
  const currentSession = sessions.get(locationId);

  console.log(`▶ Iniciando proceso WhatsApp para: ${locationId}`);

  // Import Dinámico de Baileys
  const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    initAuthCreds,
    BufferJSON,
    proto
  } = await import("@whiskeysockets/baileys");

  // --- Adaptador Auth PostgreSQL (Scope Local) ---
  async function usePostgreSQLAuthState(pool, sessionId) {
    const readData = async (key) => {
      try {
        const res = await pool.query(
          "SELECT data FROM baileys_auth WHERE session_id = $1 AND key_id = $2",
          [sessionId, key]
        );
        if (res.rows.length > 0) {
          return JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver);
        }
        return null;
      } catch (e) { return null; }
    };

    const writeData = async (key, data) => {
      try {
        const jsonData = JSON.stringify(data, BufferJSON.replacer);
        const sql = `
          INSERT INTO baileys_auth (session_id, key_id, data, updated_at)
          VALUES ($1, $2, $3::jsonb, NOW())
          ON CONFLICT (session_id, key_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
        `;
        await pool.query(sql, [sessionId, key, jsonData]);
      } catch (e) {}
    };

    const removeData = async (key) => {
      try {
        await pool.query("DELETE FROM baileys_auth WHERE session_id = $1 AND key_id = $2", [sessionId, key]);
      } catch (e) {}
    };

    const creds = (await readData("creds")) || initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const data = {};
            await Promise.all(ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              if (value) data[id] = value;
            }));
            return data;
          },
          set: async (data) => {
            const tasks = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const key = `${category}-${id}`;
                if (value) tasks.push(writeData(key, value));
                else tasks.push(removeData(key));
              }
            }
            await Promise.all(tasks);
          },
        },
      },
      saveCreds: async () => await writeData("creds", creds),
    };
  }
  // ------------------------------------------------

  const { state, saveCreds } = await usePostgreSQLAuthState(pool, locationId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    browser: ["ClicAndApp", "Chrome", "10.0"],
    connectTimeoutMs: 60000,
  });

  currentSession.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`📌 QR Generado para ${locationId}`);
      currentSession.qr = qr;
      currentSession.isConnected = false;
    }

    if (connection === "open") {
      console.log(`✅ ${locationId} CONECTADO`);
      currentSession.isConnected = true;
      currentSession.qr = null;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ ${locationId} Desconectado. Code: ${statusCode}`);
      
      currentSession.isConnected = false;
      currentSession.qr = null;
      currentSession.sock = null;

      // Reconexión automática (excepto logout 401/403)
      if (statusCode !== 401 && statusCode !== 403) {
        setTimeout(() => startWhatsApp(locationId), 3000);
      } else {
        console.log(`⚠️ Sesión ${locationId} cerrada permanentemente.`);
        sessions.delete(locationId);
      }
    }
  });

  // Manejo de Mensajes Entrantes
  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0];
    if (!m?.message || m.key.fromMe) return;

    const text = m.message.conversation || m.message.extendedTextMessage?.text;
    if (!text) return;

    const from = m.key.remoteJid;
    const waName = m.pushName || "WhatsApp Lead";
    const phoneRaw = extractPhoneFromJid(from);
    const phone = normalizePhone(phoneRaw);

    console.log(`📩 [${locationId}] ${waName} (${phone}): ${text}`);

    try {
      // Verificar si ya tenemos un contacto guardado en routing
      const route = await getRoutingForPhone(phone);
      // Si el mensaje entra por esta sesión, priorizamos esta location
      const existingContactId = (route?.locationId === locationId) ? route.contactId : null;

      const contact = await findOrCreateGHLContact(locationId, phone, waName, existingContactId);

      if (contact?.id) {
        // Actualizar routing y enviar mensaje a GHL
        await saveRouting(phone, locationId, contact.id);
        await sendMessageToGHLConversation(locationId, contact.id, text);
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje entrante:", error);
    }
  });
}

// -----------------------------
// ENDPOINTS HTTP
// -----------------------------

// 1. Iniciar conexión (Front solicita QR)
app.post("/start-whatsapp", async (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: "Falta locationId" });

  try {
    await startWhatsApp(locationId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno al iniciar" });
  }
});

// 2. Obtener QR (Polling del Front)
app.get("/qr", (req, res) => {
  const locationId = req.query.locationId;
  const session = sessions.get(locationId);
  if (!session || !session.qr) {
    return res.status(404).json({ error: "QR no disponible" });
  }
  res.json({ qr: session.qr });
});

// 3. Estado de conexión
app.get("/status", (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.json({ connected: false });

  const session = sessions.get(locationId);
  if (session && session.isConnected) {
    return res.json({ connected: true });
  }
  res.json({ connected: false });
});

// 4. Webhook GHL (Mensajes Salientes / Outbound)
app.post("/ghl/webhook", async (req, res) => {
  try {
    const { locationId, phone, message, type } = req.body;

    if (!locationId || !phone || !message) {
      return res.status(200).json({ ignored: true });
    }

    if (type === "Outbound" || type === "SMS") {
      await sendWhatsAppMessage(phone, message, locationId);
      return res.json({ ok: true });
    }
    res.json({ ignored: true });
  } catch (err) {
    console.error("❌ Error en webhook GHL:", err);
    res.status(500).json({ error: "Error procesando webhook" });
  }
});

// 5. Webhook APP Marketplace (Evento INSTALL)
app.post("/ghl/app-webhook", async (req, res) => {
  try {
    const event = req.body;
    const { type, locationId, companyId } = event;

    if (type === "INSTALL") {
      console.log(`🔔 App Install: Location ${locationId}`);
      
      // Obtener token Agencia
      const agencyAccessToken = await ensureAgencyToken();
      const agencyTokens = await getTokens(AGENCY_ROW_ID);

      // Obtener token Location
      const locBody = new URLSearchParams({ companyId, locationId });
      const locTokenRes = await axios.post(
        "https://services.leadconnectorhq.com/oauth/locationToken",
        locBody.toString(),
        {
          headers: {
            Authorization: `Bearer ${agencyAccessToken}`,
            Version: GHL_API_VERSION,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
          }
        }
      );

      // Guardar todo
      await saveTokens(locationId, {
        ...agencyTokens,
        locationAccess: locTokenRes.data,
      });

      // Crear Custom Menu
      try {
         await callGHLWithAgency({
          method: "post",
          url: "https://services.leadconnectorhq.com/custom-menus/",
          data: {
            title: "WhatsApp - Clic&App",
            url: CUSTOM_MENU_URL_WA,
            icon: { name: "whatsapp", fontFamily: "fab" },
            showOnCompany: false,
            showOnLocation: true,
            locations: [locationId],
            openMode: "iframe",
            userRole: "all",
          },
        });
        console.log("✅ Custom Menu creado");
      } catch(e) { console.error("⚠️ Error creando menu", e.message); }

      return res.json({ ok: true });
    }
    
    res.json({ ignored: true });
  } catch (e) {
    console.error("❌ Error en app-webhook:", e);
    res.status(500).json({ error: "Internal Error" });
  }
});

// -----------------------------
// INICIO: Restauración de Sesiones y Server
// -----------------------------
async function restoreSessions() {
  console.log("🔄 Restaurando sesiones previas...");
  try {
    const res = await pool.query("SELECT DISTINCT session_id FROM baileys_auth");
    for (const row of res.rows) {
      const locId = row.session_id;
      console.log(`♻️ Restaurando sesión para: ${locId}`);
      // No usamos await para iniciar en paralelo
      startWhatsApp(locId).catch(e => console.error(`❌ Error restaurando ${locId}:`, e));
    }
  } catch (e) {
    console.error("❌ Error crítico restaurando sesiones:", e);
  }
}

app.listen(PORT, async () => {
  console.log(`API escuchando en puerto ${PORT}`);
  await restoreSessions();
});