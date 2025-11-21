// src/index.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const { webcrypto } = require("crypto");
const fs = require("fs");
const { Pool } = require("pg");
const axios = require("axios");

// Parche crypto para Baileys en Node
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// -----------------------------
// Config & estado
// -----------------------------
const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA =
  process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
const AGENCY_ROW_ID = "__AGENCY__";

let isConnected = false;
let sock = null;
let baileysLoaded = false;
let currentQR = null;

// -----------------------------
// PostgreSQL
// -----------------------------
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl:
    process.env.PGSSLMODE === "require"
      ? { rejectUnauthorized: false }
      : false,
});

// Helpers BD tokens (Sin cambios)
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

// ─────────────────────────────
// Helpers tokens: Agencia / Location (Sin cambios)
// ─────────────────────────────
async function ensureAgencyToken() {
  // ... (Tu código original de ensureAgencyToken aquí) ...
  // Para abreviar la respuesta, asumo que este bloque está igual que antes
  let tokens = await getTokens(AGENCY_ROW_ID);
  if (!tokens) throw new Error("No hay tokens de agencia guardados en BD");
  
  // ... lógica de refresh token ...
  // (Manten tu lógica original aquí, está correcta)
  const companyId = tokens.companyId;

  try {
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
      // ... lógica de error 401 ...
      // Manten tu código de refresco aquí
      throw err; 
  }
}

// ... (Manten tus funciones ensureLocationToken, callGHLWithAgency, callGHLWithLocation igual) ...
// (Las omito aquí para ahorrar espacio visual, pero NO las borres de tu archivo)

async function ensureLocationToken(locationId, contactId) {
    // ... Tu código original ...
    // Simulando que el código está aquí
    let tokens = await getTokens(locationId);
    if (!tokens) throw new Error(`No hay tokens para ${locationId}`);
    return { accessToken: tokens.locationAccess.access_token, realLocationId: tokens.locationAccess.locationId };
}

async function callGHLWithLocation(locationId, config, contactId) {
    // ... Tu código original ...
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
// Helpers generales
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

// -----------------------------
// Routing en DB
// -----------------------------
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
    console.log("💾 Routing guardado en DB:", normalizedPhone);
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
// GHL helpers (multi-location)
// -----------------------------
// ... (Manten findOrCreateGHLContact, sendMessageToGHLConversation igual) ...
async function findOrCreateGHLContact(locationId, phone, waName, contactId) {
    // Tu logica original
    return { id: "contact_dummy", phone: phone }; // Placeholder para validación
}

async function sendMessageToGHLConversation(locationId, contactId, text) {
    // Tu logica original
}


// -----------------------------
// WhatsApp / Baileys
// -----------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

async function sendWhatsAppMessage(phone, text) {
  if (!sock || !isConnected) {
    console.error("⚠️ WhatsApp no está conectado.");
    return;
  }
  const waPhone = normalizePhone(phone);
  const jid = waPhone.replace("+", "") + "@s.whatsapp.net";
  try {
    await sock.sendMessage(jid, { text });
    console.log(`📤 WhatsApp enviado a ${waPhone}: ${text}`);
  } catch (err) {
    console.error("Error enviando mensaje de WhatsApp:", err);
  }
}

// 🔴 AQUÍ ESTÁ EL CAMBIO IMPORTANTE 🔴
async function startWhatsApp() {
  if (baileysLoaded && sock) return;

  baileysLoaded = true;

  // 1. Importamos TODO lo necesario aquí dentro
  const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    initAuthCreds, // <--- FALTABA ESTO
    BufferJSON,    // <--- FALTABA ESTO
    proto          // <--- FALTABA ESTO
  } = await import("@whiskeysockets/baileys");

  // 2. Definimos el Helper AQUI DENTRO para que pueda ver BufferJSON, proto, etc.
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
      } catch (e) {
        console.error(`❌ Error leyendo auth key ${key}:`, e.message);
        return null;
      }
    };

    const writeData = async (key, data) => {
      try {
        const jsonData = JSON.stringify(data, BufferJSON.replacer);
        const sql = `
          INSERT INTO baileys_auth (session_id, key_id, data, updated_at)
          VALUES ($1, $2, $3::jsonb, NOW())
          ON CONFLICT (session_id, key_id) 
          DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
        `;
        await pool.query(sql, [sessionId, key, jsonData]);
      } catch (e) {
        console.error(`❌ Error escribiendo auth key ${key}:`, e.message);
      }
    };

    const removeData = async (key) => {
      try {
        await pool.query(
          "DELETE FROM baileys_auth WHERE session_id = $1 AND key_id = $2",
          [sessionId, key]
        );
      } catch (e) {
        console.error(`❌ Error borrando auth key ${key}:`, e.message);
      }
    };

    const creds = (await readData("creds")) || initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const data = {};
            await Promise.all(
              ids.map(async (id) => {
                let value = await readData(`${type}-${id}`);
                if (type === "app-state-sync-key" && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                if (value) data[id] = value;
              })
            );
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
      saveCreds: async () => {
        await writeData("creds", creds);
      },
    };
  }

  // 3. Iniciar lógica
  const { version } = await fetchLatestBaileysVersion();
  console.log("▶ Usando versión WA:", version);

  const SESSION_ID = "session_default"; 
  const { state, saveCreds } = await usePostgreSQLAuthState(pool, SESSION_ID);

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    browser: ["ClicAndApp", "Chrome", "10.0"],
    connectTimeoutMs: 60000, 
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📌 Escanea este QR con WhatsApp:\n");
      qrcodeTerminal.generate(qr, { small: true });
      currentQR = qr;
      isConnected = false;
    }

    if (connection === "open") {
      console.log(`✅ WhatsApp conectado [Sesión: ${SESSION_ID}]`);
      isConnected = true;
      currentQR = null;
      const waId = sock?.user?.id || null;
      if (waId) console.log("📞 Número conectado:", waId.split("@")[0].split(":")[0]);
    }
    
    if (connection === "close") {
       isConnected = false;
       currentQR = null;
       const statusCode = lastDisconnect?.error?.output?.statusCode;
       console.log("❌ Conexión cerrada:", statusCode);
       
       if (statusCode === 440) {
         // Sesión inválida, borrar credenciales
         console.log("⚠️ Sesión inválida, reiniciando...");
       }

       console.log("🔁 Reintentando...");
       sock = null;
       baileysLoaded = false;
       setTimeout(startWhatsApp, 3000);
    }
  });

  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0];
    if (!m?.message || m.key.fromMe) return;

    const from = m.key.remoteJid;
    const text = m.message.conversation || m.message.extendedTextMessage?.text;
    const waName = m.pushName || "WhatsApp Lead";
    const phoneRaw = extractPhoneFromJid(from);
    const phone = normalizePhone(phoneRaw);

    console.log("📩 Recibido de", waName, "(", phone, "):", text);

    const route = await getRoutingForPhone(phone);
    const locationId = route?.locationId || process.env.DEFAULT_LOCATION_ID;

    if (!locationId) {
        console.warn("⚠️ Sin locationId para:", phone);
        return;
    }

    const contact = await findOrCreateGHLContact(locationId, phone, waName, route?.contactId);
    if (contact?.id) {
        await saveRouting(phone, locationId, contact.id);
        await sendMessageToGHLConversation(locationId, contact.id, text);
    }
  });
}

if (process.env.AUTO_START_WHATSAPP === "true") {
  startWhatsApp().catch(console.error);
}

// ... (Resto de endpoints HTTP igual) ...
app.post("/ghl/app-webhook", async (req, res) => {
    // Tu logica original
    res.json({ok: true});
});
app.post("/ghl/webhook", async (req, res) => {
    // Tu logica original
    res.json({ok: true});
});
app.post("/start-whatsapp", async (req, res) => {
  try {
    await startWhatsApp();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo iniciar WhatsApp" });
  }
});
app.get("/qr", (req, res) => {
  if (!currentQR) return res.status(404).json({ error: "QR no disponible" });
  res.json({ qr: currentQR });
});
app.get("/status", (req, res) => res.json({ status: "ok", whatsappConnected: isConnected }));

app.listen(PORT, () =>
  console.log(`API WhatsApp escuchando en http://localhost:${PORT}`)
);