const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const { webcrypto } = require("crypto");
const fs = require("fs");
const { Pool } = require("pg");
const axios = require("axios");

// Parche crypto
if (!globalThis.crypto) { globalThis.crypto = webcrypto; }

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA = process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
const AGENCY_ROW_ID = "__AGENCY__";

// -----------------------------
// ⚙️ CONFIGURACIÓN DE NÚMERO COMPARTIDO
// -----------------------------
// Si esto es TRUE, todas las locations usan el mismo WhatsApp
const USE_SHARED_NUMBER = true; 
// Este será el ID interno de la sesión "Maestra" que escaneará el QR
const MASTER_SESSION_ID = "master_whatsapp_shared"; 

// 🧠 GESTOR DE SESIONES (MEMORIA)
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
// HELPERS: BD Tokens & Auth
// -----------------------------
async function saveTokens(locationId, tokenData) {
  const sql = `INSERT INTO auth_db (locationid, raw_token) VALUES ($1, $2::jsonb)
    ON CONFLICT (locationid) DO UPDATE SET raw_token = EXCLUDED.raw_token`;
  await pool.query(sql, [locationId, JSON.stringify(tokenData)]);
}

async function getTokens(locationId) {
  const result = await pool.query("SELECT raw_token FROM auth_db WHERE locationid = $1", [locationId]);
  return result.rows[0]?.raw_token || null;
}

async function ensureAgencyToken() {
  let tokens = await getTokens(AGENCY_ROW_ID);
  if (!tokens) throw new Error("No hay tokens de agencia guardados");
  const companyId = tokens.companyId;
  try {
    await axios.get(`https://services.leadconnectorhq.com/companies/${companyId}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json", Version: GHL_API_VERSION },
        params: { limit: 1 }, timeout: 15000
    });
    return tokens.access_token;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log("🔄 Token agencia expirado, refrescando...");
      try {
        const body = new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: tokens.refresh_token });
        const refreshRes = await axios.post("https://services.leadconnectorhq.com/oauth/token", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
        await saveTokens(AGENCY_ROW_ID, refreshRes.data);
        return refreshRes.data.access_token;
      } catch (e) { throw new Error("Error refrescando token agencia"); }
    }
    throw err;
  }
}

async function ensureLocationToken(locationId, contactId) {
  let tokens = await getTokens(locationId);
  if (!tokens) throw new Error(`No hay tokens para ${locationId}`);
  let locationToken = tokens.locationAccess;
  
  try {
    if (contactId) {
      await axios.get(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
        headers: { Authorization: `Bearer ${locationToken.access_token}`, Accept: "application/json", Version: GHL_API_VERSION, "Location-Id": locationToken.locationId },
        timeout: 15000
      });
    }
    return { accessToken: locationToken.access_token, realLocationId: locationToken.locationId };
  } catch (err) {
    if (err.response?.status === 401) {
      console.log(`🔄 Token location ${locationId} expirado, refrescando...`);
      try {
        const body = new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: locationToken.refresh_token });
        const refreshRes = await axios.post("https://services.leadconnectorhq.com/oauth/token", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
        await saveTokens(locationId, { ...tokens, locationAccess: refreshRes.data });
        return { accessToken: refreshRes.data.access_token, realLocationId: refreshRes.data.locationId };
      } catch (e) { throw new Error("Error refrescando token location"); }
    }
    throw err;
  }
}

async function callGHLWithAgency(config) {
  const accessToken = await ensureAgencyToken();
  return axios({ ...config, headers: { Accept: "application/json", Version: GHL_API_VERSION, Authorization: `Bearer ${accessToken}`, ...(config.headers || {}) } });
}

async function callGHLWithLocation(locationId, config, contactId) {
  const { accessToken, realLocationId } = await ensureLocationToken(locationId, contactId);
  return axios({ ...config, headers: { Accept: "application/json", Version: GHL_API_VERSION, Authorization: `Bearer ${accessToken}`, "Location-Id": realLocationId, ...(config.headers || {}) } });
}

// -----------------------------
// ROUTING (Fundamental para Shared Number)
// -----------------------------
function normalizePhone(phone) {
  if (!phone) return "";
  const cleaned = phone.replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+")) return `+${cleaned}`;
  return cleaned;
}

function extractPhoneFromJid(jid) { return jid.split("@")[0].split(":")[0]; }

async function saveRouting(phone, locationId, contactId) {
  const normalizedPhone = normalizePhone(phone);
  // Guardamos qué Location habló por última vez con este número
  const sql = `
    INSERT INTO phone_routing (phone, location_id, contact_id, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (phone) DO UPDATE
    SET location_id = EXCLUDED.location_id,
        contact_id = COALESCE(EXCLUDED.contact_id, phone_routing.contact_id),
        updated_at = NOW();
  `;
  try { await pool.query(sql, [normalizedPhone, locationId, contactId]); } 
  catch (e) { console.error("❌ Error guardando routing:", e); }
}

async function getRoutingForPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  const sql = "SELECT location_id, contact_id FROM phone_routing WHERE phone = $1";
  try {
    const res = await pool.query(sql, [normalizedPhone]);
    if (res.rows.length > 0) return { locationId: res.rows[0].location_id, contactId: res.rows[0].contact_id };
    return null;
  } catch (e) { return null; }
}

async function findOrCreateGHLContact(locationId, phone, waName, contactId) {
  const normalizedPhone = normalizePhone(phone);
  if (contactId) {
    try {
      const lookupRes = await callGHLWithLocation(locationId, { method: "GET", url: `https://services.leadconnectorhq.com/contacts/${contactId}` });
      const contact = lookupRes.data.contact || lookupRes.data;
      if (contact?.id) return contact;
    } catch (err) { }
  }
  try {
    const createdRes = await callGHLWithLocation(locationId, {
      method: "POST", url: "https://services.leadconnectorhq.com/contacts/",
      data: { locationId, phone: normalizedPhone, firstName: waName, source: "WhatsApp Baileys" }
    });
    return createdRes.data.contact || createdRes.data;
  } catch (err) {
    const body = err.response?.data;
    if (err.response?.status === 400 && body?.meta?.contactId) return { id: body.meta.contactId, phone: normalizedPhone };
    return null;
  }
}

async function sendMessageToGHLConversation(locationId, contactId, text) {
  try {
    await callGHLWithLocation(locationId, {
      method: "POST", url: "https://services.leadconnectorhq.com/conversations/messages/inbound",
      data: { type: "SMS", contactId, locationId, message: text, direction: "inbound" }
    }, contactId);
    console.log(`📨 Inbound GHL (${locationId}):`, text);
  } catch (err) { console.error("❌ Error enviando Inbound a GHL:", err.message); }
}

// -----------------------------
// 🚀 LÓGICA WHATSAPP (Modificada)
// -----------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Función para enviar mensaje (Lógica "Shared Source")
async function sendWhatsAppMessage(phone, text, requestLocationId) {
  // 1. Determinar qué sesión usar
  let sessionToUse;
  let finalMessage = text;

  if (USE_SHARED_NUMBER) {
    // Si es compartido, SIEMPRE usamos la sesión maestra
    sessionToUse = sessions.get(MASTER_SESSION_ID);
    
    // 2. Agregar la firma (Source) para diferenciar quién mandó
    // Esto hará que en el celular se vea "Hola... "
    if (requestLocationId) {
        finalMessage = `${text}\n\n_source: ${requestLocationId}_`;
    }
  } else {
    // Si NO es compartido, buscamos la sesión específica de esa location
    sessionToUse = sessions.get(requestLocationId);
  }

  if (!sessionToUse || !sessionToUse.isConnected || !sessionToUse.sock) {
    console.error(`⚠️ No se puede enviar. Sesión desconectada. (Shared: ${USE_SHARED_NUMBER})`);
    return;
  }

  const waPhone = normalizePhone(phone);
  const jid = waPhone.replace("+", "") + "@s.whatsapp.net";

  try {
    await sessionToUse.sock.sendMessage(jid, { text: finalMessage });
    console.log(`📤 [Desde: ${requestLocationId}] Enviado a ${waPhone}`);
  } catch (err) {
    console.error(`❌ Error enviando mensaje WA:`, err);
  }
}

async function startWhatsApp(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing && existing.sock) return existing;

  sessions.set(sessionId, { sock: null, qr: null, isConnected: false });
  const currentSession = sessions.get(sessionId);

  console.log(`▶ Iniciando WhatsApp Sesión: ${sessionId}`);

  const { default: makeWASocket, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds, BufferJSON, proto } = await import("@whiskeysockets/baileys");

  // Auth Adapter (Postgres)
  async function usePostgreSQLAuthState(pool, id) {
    const readData = async (key) => {
      try {
        const res = await pool.query("SELECT data FROM baileys_auth WHERE session_id = $1 AND key_id = $2", [id, key]);
        return res.rows.length > 0 ? JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver) : null;
      } catch (e) { return null; }
    };
    const writeData = async (key, data) => {
      try {
        const jsonData = JSON.stringify(data, BufferJSON.replacer);
        const sql = `INSERT INTO baileys_auth (session_id, key_id, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW()) ON CONFLICT (session_id, key_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`;
        await pool.query(sql, [id, key, jsonData]);
      } catch (e) {}
    };
    const removeData = async (key) => { try { await pool.query("DELETE FROM baileys_auth WHERE session_id = $1 AND key_id = $2", [id, key]); } catch (e) {} };
    const creds = (await readData("creds")) || initAuthCreds();
    return {
      state: { creds, keys: {
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
            for (const cat in data) { for (const id in data[cat]) { const val = data[cat][id]; const key = `${cat}-${id}`; if (val) tasks.push(writeData(key, val)); else tasks.push(removeData(key)); } }
            await Promise.all(tasks);
          }
      }}, saveCreds: async () => await writeData("creds", creds)
    };
  }

  const { state, saveCreds } = await usePostgreSQLAuthState(pool, sessionId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
    browser: ["ClicAndApp Shared", "Chrome", "10.0"],
    connectTimeoutMs: 60000,
  });

  currentSession.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { currentSession.qr = qr; currentSession.isConnected = false; console.log(`📌 QR para ${sessionId}`); }
    if (connection === "open") { currentSession.isConnected = true; currentSession.qr = null; console.log(`✅ ${sessionId} CONECTADO`); }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      currentSession.isConnected = false; currentSession.sock = null;
      if (code !== 401 && code !== 403) setTimeout(() => startWhatsApp(sessionId), 3000);
      else sessions.delete(sessionId);
    }
  });

  // 📩 MANEJO DE MENSAJES ENTRANTES (ROUTING INTELIGENTE)
  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0];
    if (!m?.message || m.key.fromMe) return;
    const text = m.message.conversation || m.message.extendedTextMessage?.text;
    if (!text) return;

    const from = m.key.remoteJid;
    const waName = m.pushName || "Usuario";
    const phoneRaw = extractPhoneFromJid(from);
    const phone = normalizePhone(phoneRaw);

    // 1. ¿Quién debe recibir este mensaje?
    // Buscamos en la DB la última location que habló con este número
    const route = await getRoutingForPhone(phone);
    
    // Si encontramos routing, usamos esa location. 
    // Si NO encontramos, podríamos asignarlo a una 'Default Location' (Opcional)
    const targetLocationId = route?.locationId;

    if (!targetLocationId) {
        console.log(`⚠️ Mensaje de ${phone} ignorado: No hay routing previo (nadie le escribió antes).`);
        // AQUÍ PODRÍAS DEFINIR UNA LOCATION "BANDEJA DE ENTRADA GENERAL" SI QUISIERAS
        return; 
    }

    console.log(`📩 Recibido de ${phone} -> Enrutando a Location: ${targetLocationId}`);

    try {
      const contact = await findOrCreateGHLContact(targetLocationId, phone, waName, route.contactId);
      if (contact?.id) {
        // Refrescamos el routing (timestamp update)
        await saveRouting(phone, targetLocationId, contact.id);
        // Enviamos a la location correcta en GHL
        await sendMessageToGHLConversation(targetLocationId, contact.id, text);
      }
    } catch (error) { console.error("❌ Error procesando inbound:", error); }
  });
}

// -----------------------------
// ENDPOINTS HTTP
// -----------------------------

// 1. Start Connection
app.post("/start-whatsapp", async (req, res) => {
  const { locationId } = req.query;
  
  if (USE_SHARED_NUMBER) {
      // Si es compartido, solo permitimos iniciar la sesión MAESTRA
      // Puedes proteger esto con una clave o solo permitirlo si locationId es 'admin'
      console.log(`🔄 Solicitud de conexión desde ${locationId}, iniciando Master Session...`);
      await startWhatsApp(MASTER_SESSION_ID);
      return res.json({ success: true, mode: "SHARED", masterSession: MASTER_SESSION_ID });
  }

  // Modo clásico (Multi-tenant)
  if (!locationId) return res.status(400).json({ error: "Falta locationId" });
  await startWhatsApp(locationId);
  res.json({ success: true });
});

// 2. Get QR
app.get("/qr", (req, res) => {
  const { locationId } = req.query;
  
  // Si es compartido, siempre devolvemos el QR de la Master Session
  const targetSession = USE_SHARED_NUMBER ? MASTER_SESSION_ID : locationId;
  
  const session = sessions.get(targetSession);
  if (!session || !session.qr) return res.status(404).json({ error: "QR no disponible" });
  res.json({ qr: session.qr });
});

// 3. Status
app.get("/status", (req, res) => {
  const { locationId } = req.query;
  const targetSession = USE_SHARED_NUMBER ? MASTER_SESSION_ID : locationId;

  const session = sessions.get(targetSession);
  if (session && session.isConnected) return res.json({ connected: true });
  res.json({ connected: false });
});

// 4. Webhook GHL (Salientes)
app.post("/ghl/webhook", async (req, res) => {
  try {
    const { locationId, phone, message, type } = req.body;
    if (!locationId || !phone || !message) return res.json({ ignored: true });

    if (type === "Outbound" || type === "SMS") {
      // Guardamos routing para saber que ESTA location le escribió a este número
      // (Importante para que la respuesta del cliente vuelva a esta location)
      await saveRouting(phone, locationId, null); 

      // Enviamos (La función internamente decide si usa Master o individual)
      await sendWhatsAppMessage(phone, message, locationId);
      return res.json({ ok: true });
    }
    res.json({ ignored: true });
  } catch (err) { console.error("❌ Error Webhook:", err); res.status(500).json({ error: "Error" }); }
});

// 5. App Webhook (Install)
app.post("/ghl/app-webhook", async (req, res) => {
  try {
    const event = req.body;
    if (event.type === "INSTALL") {
      const { locationId, companyId } = event;
      console.log(`🔔 Install en ${locationId}`);

      const agencyToken = await ensureAgencyToken();
      const agencyTokens = await getTokens(AGENCY_ROW_ID);

      let locTokenRes;
      try {
        locTokenRes = await axios.post("https://services.leadconnectorhq.com/oauth/locationToken", 
           new URLSearchParams({ companyId, locationId }).toString(), 
           { headers: { Authorization: `Bearer ${agencyToken}`, Version: GHL_API_VERSION, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } }
        );
      } catch(e) { return res.status(500).json({ error: "Token Fail" }); }

      await saveTokens(locationId, { ...agencyTokens, locationAccess: locTokenRes.data });

      // Crear menú con la URL apuntando al backend
      // NOTA: En modo compartido, el usuario NO necesita escanear QR individualmente.
      // Pero le damos el link para que vea el estado "Conectado".
      try {
         await callGHLWithAgency({
          method: "post", url: "https://services.leadconnectorhq.com/custom-menus/",
          data: {
            title: "WhatsApp - Clic&App",
            url: `${CUSTOM_MENU_URL_WA}?location_id=${locationId}`, 
            icon: { name: "whatsapp", fontFamily: "fab" },
            showOnCompany: false, showOnLocation: true, showToAllLocations: false, locations: [locationId],
            openMode: "iframe", userRole: "all", allowCamera: false, allowMicrophone: false
          },
        });
      } catch(e) {}

      return res.json({ ok: true });
    }
    res.json({ ignored: true });
  } catch (e) { res.status(500).json({ error: "Error" }); }
});

async function restoreSessions() {
  console.log("🔄 Restaurando...");
  try {
    const res = await pool.query("SELECT DISTINCT session_id FROM baileys_auth");
    for (const row of res.rows) {
      startWhatsApp(row.session_id).catch(console.error);
    }
    // En modo compartido, aseguramos que la master session arranque aunque no esté en DB aún
    if (USE_SHARED_NUMBER) {
        setTimeout(() => startWhatsApp(MASTER_SESSION_ID), 2000);
    }
  } catch (e) { console.error(e); }
}

app.listen(PORT, async () => {
  console.log(`API escuchando en puerto ${PORT} (SHARED_NUMBER: ${USE_SHARED_NUMBER})`);
  await restoreSessions();
});