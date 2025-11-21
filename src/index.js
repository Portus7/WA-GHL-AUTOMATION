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
// PostgreSQL (misma BD que proyecto 1)
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

// Helpers BD tokens
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
// Helpers tokens: Agencia / Location
// ─────────────────────────────

// Asegurar token de AGENCIA
async function ensureAgencyToken() {
  let tokens = await getTokens(AGENCY_ROW_ID);
  if (!tokens) throw new Error("No hay tokens de agencia guardados en BD");
  console.log("🔐 Tokens agencia en BD:", {
    hasAccessToken: !!tokens.access_token,
    companyId: tokens.companyId,
  });

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
    const status = err.response?.status;

    if (status === 401) {
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
        console.error(
          "❌ Error refrescando token de agencia:",
          e.response?.data || e.message
        );
        throw new Error("No se pudo refrescar el token de agencia");
      }
    }

    console.error(
      "❌ Error verificando token de agencia:",
      status,
      err.response?.data || err.message
    );
    throw err;
  }
}

// Asegurar token de LOCATION
async function ensureLocationToken(locationId, contactId) {
  let tokens = await getTokens(locationId);

  console.log("TOKEEENS", {
    locationIdParam: locationId,
    hasLocationAccess: !!tokens?.locationAccess,
    tokenLocationId: tokens?.locationAccess?.locationId,
    userType: tokens?.locationAccess?.userType,
  });

  if (!tokens) throw new Error(`No hay tokens guardados para la location ${locationId}`);

  let locationToken = tokens.locationAccess;
  if (!locationToken) throw new Error(`No hay locationAccess para ${locationId}`);

  try {

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
    // ❗ SOLO refrescamos si realmente es 401
    if (err.response?.status === 401) {
      console.log(`🔄 Token expirado para location ${locationId} → refrescando...`);

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

        await saveTokens(locationId, {
          ...tokens,
          locationAccess: newToken,
        });

        console.log(`✅ Token refrescado correctamente para location ${locationId}`);

        return {
          accessToken: newToken.access_token,
          realLocationId: newToken.locationId,
        };

      } catch (e) {
        console.error(
          `❌ Error refrescando token para location ${locationId}:`,
          e.response?.data || e.message
        );
        throw new Error("No se pudo refrescar el token de location");
      }
    }

    throw err;
  }
}


// Wrappers axios
async function callGHLWithAgency(config) {
  const accessToken = await ensureAgencyToken();

  const headers = {
    Accept: "application/json",
    Version: GHL_API_VERSION,
    ...(config.headers || {}),
    Authorization: `Bearer ${accessToken}`,
  };

  return axios({
    ...config,
    headers,
  });
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

// DB local de rutas phone -> { locationId, contactId }
//function loadRoutingDb() {
//  try {
//    const raw = fs.readFileSync("./routing.json", "utf8");
//    return JSON.parse(raw);
//  } catch {
//    return {};
//  }
//}

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
async function findOrCreateGHLContact(
  locationId,
  phone,
  waName = "WhatsApp Lead",
  contactId
) {
  const normalizedPhone = normalizePhone(phone);

  // 1) Si tenemos contactId desde el workflow, primero intentamos GET /contacts/{id}
  if (contactId) {
    try {
      const lookupRes = await callGHLWithLocation(locationId, {
        method: "GET",
        url: `https://services.leadconnectorhq.com/contacts/${contactId}`,
        timeout: 15000,
      });

      console.log("✅ Contacto encontrado por contactId:", contactId);
      const contact = lookupRes.data.contact || lookupRes.data;
      if (contact?.id) return contact;
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        console.log(
          `ℹ️ Contacto con id ${contactId} no existe, se creará uno nuevo`
        );
      } else {
        console.error(
          "Error buscando contacto por id:",
          status,
          err.response?.data || err.message
        );
      }
      // sigue al paso 2 (crear)
    }
  } else {
    console.log(
      "ℹ️ No hay contactId en routing, se intentará crear contacto nuevo"
    );
  }

  // 2) crear
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
    console.log("👤 Contacto creado:", created.id);
    return created;
  } catch (err) {
    const statusCode = err.response?.status;
    const body = err.response?.data;
    console.error("Error creando contacto:", statusCode, body || err.message);

    // patrón clásico de GHL: 400 pero con meta.contactId si ya existía
    if (statusCode === 400 && body?.meta?.contactId) {
      console.log(
        "ℹ️ Contacto ya existía (desde error 400):",
        body.meta.contactId
      );
      return { id: body.meta.contactId, phone: normalizedPhone };
    }

    return null;
  }
}

async function sendMessageToGHLConversation(locationId, contactId, text) {
  try {
    const res = await callGHLWithLocation(
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

    console.log("📨 Mensaje INBOUND creado en GHL:", res.data);
  } catch (err) {
    console.error(
      "Error GHL (inbound):",
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

async function sendMessageToGHLConversationOutbound(locationId, contactId, text) {
  try {
    const res = await callGHLWithLocation(locationId, {
      method: "POST",
      url: "https://services.leadconnectorhq.com/conversations/messages",
      data: {
        type: "SMS",
        contactId,
        locationId,
        message: text,
        direction: "outbound",
      },
      timeout: 15000,
    });

    console.log("📤 Mensaje OUTBOUND registrado en GHL:", res.data);
    return res.data;
  } catch (err) {
    console.error(
      "Error GHL (outbound):",
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

// -----------------------------
// WhatsApp / Baileys
// -----------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

async function sendWhatsAppMessage(phone, text) {
  if (!sock || !isConnected) {
    console.error("⚠️ WhatsApp no está conectado, no se puede enviar mensaje.");
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

// -----------------------------
// Helper: Baileys en PostgreSQL
// -----------------------------
async function usePostgreSQLAuthState(pool, sessionId) {
  // 1. Helper para leer de BD
  const readData = async (key) => {
    try {
      const res = await pool.query(
        "SELECT data FROM baileys_auth WHERE session_id = $1 AND key_id = $2",
        [sessionId, key]
      );
      if (res.rows.length > 0) {
        // Usamos BufferJSON.reviver para restaurar Buffers desde el JSON
        return JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver);
      }
      return null;
    } catch (e) {
      console.error(`❌ Error leyendo auth key ${key}:`, e.message);
      return null;
    }
  };

  // 2. Helper para escribir en BD
  const writeData = async (key, data) => {
    try {
      // Usamos BufferJSON.replacer para guardar Buffers como JSON
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

  // 3. Helper para borrar de BD
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

  // 4. Cargar creds iniciales
  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              // La key se guarda como "sender-key-123", "app-state-sync-1", etc.
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) {
                data[id] = value;
              }
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
              if (value) {
                tasks.push(writeData(key, value));
              } else {
                tasks.push(removeData(key));
              }
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

// -----------------------------
// WhatsApp / Baileys
// -----------------------------
// ... (código express app anterior se mantiene igual)

async function startWhatsApp() {
  if (baileysLoaded && sock) return;

  baileysLoaded = true;

  const { version } = await fetchLatestBaileysVersion();
  console.log("▶ Usando versión WA:", version);

  // 📌 NOMBRE DE SESIÓN (Permite tener varios números cambiando esto)
  const SESSION_ID = "session_default"; 

  // 📌 Usamos nuestra nueva autenticación en DB
  const { state, saveCreds } = await usePostgreSQLAuthState(pool, SESSION_ID);

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }), // 'silent' limpia la consola, usa 'info' para debug
    auth: {
        creds: state.creds,
        // Cachear keys hace que sea más rápido y no sature la DB
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    browser: ["ClicAndApp", "Chrome", "10.0"],
    // Opcional: Aumentar timeout para evitar desconexiones en servidores lentos
    connectTimeoutMs: 60000, 
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    // ... (El resto de tu lógica de conexión se mantiene IGUAL) ...
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
      // ...
    }
    
    if (connection === "close") {
        // ... (Tu lógica de reconexión existente)
       isConnected = false;
       currentQR = null;
       // etc...
       console.log("🔁 Reintentando...");
       sock = null;
       baileysLoaded = false;
       setTimeout(startWhatsApp, 3000);
    }
  });

  // ... (Tu lógica de messages.upsert se mantiene IGUAL) ...
  sock.ev.on("messages.upsert", async (msg) => {
     // ... todo tu código de mensajes ...
  });
}

if (process.env.AUTO_START_WHATSAPP === "true") {
  startWhatsApp().catch(console.error);
}

// -----------------------------
// ENDPOINTS HTTP
// -----------------------------

// 1) Webhook de la APP del Marketplace (INSTALL / etc.)
app.post("/ghl/app-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("🔔 App Webhook recibido:", event);

    const { type, locationId, companyId } = event;

    console.log(
      "Se ejecutó /ghl/app-webhook",
      "locationid:",
      locationId,
      "companyid:",
      companyId
    );

    if (type !== "INSTALL") {
      console.log("ℹ️ Evento no manejado (tipo distinto de INSTALL).");
      return res.status(200).json({ ignored: true });
    }

    if (!locationId || !companyId) {
      console.warn("⚠️ Webhook INSTALL sin locationId o companyId, se ignora.");
      return res.status(200).json({ ignored: true });
    }

    // 1) Asegurar token de agencia
    const agencyAccessToken = await ensureAgencyToken();

    // Volver a leer tokens de agencia (pueden haberse refrescado)
    const agencyTokens = await getTokens(AGENCY_ROW_ID);

    if (!agencyTokens || !agencyTokens.access_token) {
      console.error(
        "❌ No hay tokens de agencia guardados en BD (fila __AGENCY__)."
      );
      return res.status(200).json({ ok: false, reason: "no_agency_token" });
    }

    // 2) Pedir token de Location
    try {
      const locBody = new URLSearchParams({
        companyId,
        locationId,
      });

      const locTokenRes = await axios.post(
        "https://services.leadconnectorhq.com/oauth/locationToken",
        locBody.toString(),
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Bearer ${agencyAccessToken}`,
            Version: GHL_API_VERSION,
          },
          timeout: 15000,
        }
      );

      const locationTokens = locTokenRes.data;
      console.log("🔑 Tokens Location obtenidos para:", locationId);

      // 3) Guardar combinando agencyTokens + locationAccess
      await saveTokens(locationId, {
        ...agencyTokens,
        locationAccess: locationTokens,
      });

      // 4) Crear Custom Menu SOLO para esta Location
      try {
        const bodyMenu = {
          title: "WhatsApp - Clic&App",
          url: CUSTOM_MENU_URL_WA,
          icon: { name: "whatsapp", fontFamily: "fab" },

          showOnCompany: false,
          showOnLocation: true,

          showToAllLocations: false,
          locations: [locationId],

          openMode: "iframe",
          userRole: "all",
          allowCamera: false,
          allowMicrophone: false,
        };

        const createMenuRes = await callGHLWithAgency({
          method: "post",
          url: "https://services.leadconnectorhq.com/custom-menus/",
          data: bodyMenu,
          timeout: 15000,
        });

        console.log(
          "✅ Custom Menu creado para location:",
          locationId,
          createMenuRes.data
        );
      } catch (e) {
        console.error(
          "❌ Error creando Custom Menu en webhook INSTALL:",
          e.response?.status,
          e.response?.data || e.message
        );
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error(
        "❌ Error obteniendo token de Location en webhook INSTALL:",
        e.response?.status,
        e.response?.data || e.message
      );
      return res
        .status(200)
        .json({ ok: false, error: "location_token_failed" });
    }
  } catch (e) {
    console.error("❌ Error general en /ghl/app-webhook:", e);
    return res.status(500).json({ error: `Error interno en app webhook` });
  }
});

// 2) Webhook de workflow de GHL -> enviar a WhatsApp
app.post("/ghl/webhook", async (req, res) => {
  try {
    console.log("📩 Webhook GHL recibido:", req.body);

    const { userId, contactId, locationId, phone, message, type } = req.body;

    if (!contactId || !phone || !message || !locationId) {
      console.warn("⚠️ Webhook incompleto");
      return res.status(200).json({ ignored: true });
    }

    // Guardar routing phone -> location/contact
    saveRouting(phone, locationId, contactId);

    await sendWhatsAppMessage(phone, message);

    // Opcional: registrar OUTBOUND también en GHL
    // await sendMessageToGHLConversationOutbound(locationId, contactId, message);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error en webhook /ghl/webhook:", err);
    res.status(500).json({ error: "Error interno en webhook" });
  }
});

// 3) Otros endpoints
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
  if (!currentQR) {
    return res.status(404).json({ error: "QR no disponible aún" });
  }
  res.json({ qr: currentQR });
});

app.get("/status", (req, res) => {
  res.json({ status: "ok", whatsappConnected: isConnected });
});

app.listen(PORT, () =>
  console.log(`API WhatsApp escuchando en http://localhost:${PORT}`)
);
