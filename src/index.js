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

// CONFIG: Cuántos números permitimos por sub-agencia
const MAX_SLOTS = 3;

// 🧠 GESTOR DE SESIONES (MEMORIA)
// Clave: "locationId_slotId" (ej: loc123_1)
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
// ROUTING INTELIGENTE (Multicanal)
// -----------------------------
function normalizePhone(phone) {
  if (!phone) return "";
  const cleaned = phone.replace(/[^\d+]/g, "");
  // Asegurar formato internacional sin + para comparaciones internas o con + para DB
  return cleaned; 
}

function formatJid(phone) {
  return normalizePhone(phone) + "@s.whatsapp.net";
}

// Guardamos: Cliente, Location y POR QUÉ canal (número propio) se hablaron
async function saveRouting(clientPhone, locationId, contactId, channelNumber) {
  const normClient = normalizePhone(clientPhone);
  const normChannel = normalizePhone(channelNumber); // El numero de whatsapp de la agencia

  const sql = `
    INSERT INTO phone_routing (phone, location_id, contact_id, channel_number, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (phone) DO UPDATE
    SET location_id = EXCLUDED.location_id,
        contact_id = COALESCE(EXCLUDED.contact_id, phone_routing.contact_id),
        channel_number = EXCLUDED.channel_number,
        updated_at = NOW();
  `;
  try { await pool.query(sql, [normClient, locationId, contactId, normChannel]); } 
  catch (e) { console.error("❌ Error guardando routing:", e); }
}

async function getRoutingForPhone(clientPhone) {
  const normClient = normalizePhone(clientPhone);
  const sql = "SELECT location_id, contact_id, channel_number FROM phone_routing WHERE phone = $1";
  try {
    const res = await pool.query(sql, [normClient]);
    if (res.rows.length > 0) {
        return { 
            locationId: res.rows[0].location_id, 
            contactId: res.rows[0].contact_id,
            channelNumber: res.rows[0].channel_number // El último número de agencia usado
        };
    }
    return null;
  } catch (e) { return null; }
}

async function findOrCreateGHLContact(locationId, phone, waName, contactId) {
  const p = "+" + normalizePhone(phone); // GHL requiere +
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
      data: { locationId, phone: p, firstName: waName, source: "WhatsApp Baileys" }
    });
    return createdRes.data.contact || createdRes.data;
  } catch (err) {
    const body = err.response?.data;
    if (err.response?.status === 400 && body?.meta?.contactId) return { id: body.meta.contactId, phone: p };
    return null;
  }
}

async function sendMessageToGHLConversation(locationId, contactId, text) {
  try {
    await callGHLWithLocation(locationId, {
      method: "POST", url: "https://services.leadconnectorhq.com/conversations/messages/inbound",
      data: { type: "SMS", contactId, locationId, message: text, direction: "inbound" }
    }, contactId);
  } catch (err) { console.error("❌ Error enviando Inbound a GHL:", err.message); }
}

// -----------------------------
// LÓGICA WHATSAPP (Multi-Slot)
// -----------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

async function startWhatsApp(locationId, slotId) {
  const sessionId = `${locationId}_slot${slotId}`; // ID Único: loc123_slot1
  
  const existing = sessions.get(sessionId);
  if (existing && existing.sock) return existing;

  sessions.set(sessionId, { sock: null, qr: null, isConnected: false, myNumber: null });
  const currentSession = sessions.get(sessionId);

  console.log(`▶ Iniciando WhatsApp: ${locationId} (Slot ${slotId})`);

  const { default: makeWASocket, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds, BufferJSON, proto } = await import("@whiskeysockets/baileys");

  // Auth con Postgres
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
    browser: [`ClicAndApp Slot ${slotId}`, "Chrome", "10.0"],
    connectTimeoutMs: 60000,
  });

  currentSession.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) { 
        currentSession.qr = qr; 
        currentSession.isConnected = false; 
        currentSession.myNumber = null;
        console.log(`📌 QR Generado: ${sessionId}`); 
    }
    
    if (connection === "open") { 
        currentSession.isConnected = true; 
        currentSession.qr = null; 
        // Extraer número propio conectado
        const myJid = sock.user?.id;
        const myPhone = myJid ? normalizePhone(myJid.split(":")[0]) : "Desconocido";
        currentSession.myNumber = myPhone;
        
        console.log(`✅ ${sessionId} CONECTADO: +${myPhone}`); 
    }
    
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      currentSession.isConnected = false; 
      currentSession.sock = null;
      currentSession.myNumber = null;
      console.log(`❌ Desconectado ${sessionId} (${code})`);
      
      if (code !== 401 && code !== 403) setTimeout(() => startWhatsApp(locationId, slotId), 3000);
      else sessions.delete(sessionId);
    }
  });

  // 📩 INBOUND (Mensajes Entrantes)
  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0];
    if (!m?.message || m.key.fromMe) return;
    const text = m.message.conversation || m.message.extendedTextMessage?.text;
    if (!text) return;

    const from = m.key.remoteJid;
    const waName = m.pushName || "Usuario";
    const clientPhone = normalizePhone(from.split("@")[0]);
    
    // Detectar mi propio número (Canal Receptor)
    const myJid = sock.user?.id;
    const myChannelNumber = myJid ? normalizePhone(myJid.split(":")[0]) : "Desconocido";

    console.log(`📩 [${locationId} | Slot ${slotId}] Recibido de +${clientPhone} al canal +${myChannelNumber}`);

    try {
        // 1. Routing: Guardamos que este cliente habló con ESTE location por ESTE canal
        const route = await getRoutingForPhone(clientPhone);
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;

        const contact = await findOrCreateGHLContact(locationId, clientPhone, waName, existingContactId);

        if (contact?.id) {
            await saveRouting(clientPhone, locationId, contact.id, myChannelNumber);

            // 2. Modificar mensaje para GHL: Agregar Source
            const messageWithSource = `${text}\n\nSource: +${myChannelNumber}`;
            
            await sendMessageToGHLConversation(locationId, contact.id, messageWithSource);
        }
    } catch (error) { console.error("❌ Error inbound:", error); }
  });
}

// -----------------------------
// ENDPOINTS HTTP
// -----------------------------

// 1. Start Connection (Por Slot)
app.post("/start-whatsapp", async (req, res) => {
  const { locationId, slot } = req.query;
  if (!locationId || !slot) return res.status(400).json({ error: "Faltan params" });
  
  try {
    await startWhatsApp(locationId, slot);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error starting" }); }
});

// 2. QR (Por Slot)
app.get("/qr", (req, res) => {
  const { locationId, slot } = req.query;
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);
  if (!session || !session.qr) return res.status(404).json({ error: "QR no disponible" });
  res.json({ qr: session.qr });
});

// 3. Status (Por Slot)
app.get("/status", (req, res) => {
  const { locationId, slot } = req.query;
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);
  
  if (session && session.isConnected) {
      return res.json({ connected: true, myNumber: session.myNumber });
  }
  res.json({ connected: false });
});

// 4. Webhook GHL (Outbound Routing Inteligente)
app.post("/ghl/webhook", async (req, res) => {
  try {
    const { locationId, phone, message, type } = req.body;
    if (!locationId || !phone || !message) return res.json({ ignored: true });

    if (type === "Outbound" || type === "SMS") {
        const clientPhone = normalizePhone(phone);

        // 1. Buscamos en DB: ¿Por qué número me habló este cliente la última vez?
        const route = await getRoutingForPhone(clientPhone);
        let targetChannel = route?.channelNumber; // Ej: 595952112

        // 2. Buscar qué Slot tiene ese número conectado
        let sessionToUse = null;
        let foundSlot = 0;

        // Si tenemos un canal previo, buscamos qué slot lo tiene
        if (targetChannel) {
            for (let i = 1; i <= MAX_SLOTS; i++) {
                const sId = `${locationId}_slot${i}`;
                const sess = sessions.get(sId);
                if (sess && sess.isConnected && sess.myNumber === targetChannel) {
                    sessionToUse = sess;
                    foundSlot = i;
                    break;
                }
            }
        }

        // 3. Fallback: Si no hay historia o el slot está desconectado, usar el Slot 1 (o cualquiera conectado)
        if (!sessionToUse) {
            console.log(`⚠️ No se encontró canal previo (${targetChannel}) para ${clientPhone}, buscando default...`);
            for (let i = 1; i <= MAX_SLOTS; i++) {
                const sId = `${locationId}_slot${i}`;
                const sess = sessions.get(sId);
                if (sess && sess.isConnected) {
                    sessionToUse = sess;
                    foundSlot = i;
                    targetChannel = sess.myNumber; // Actualizamos para guardar en routing
                    break;
                }
            }
        }

        if (!sessionToUse) {
            console.error(`❌ No hay ningún WhatsApp conectado para ${locationId}`);
            return res.json({ error: "No WhatsApp connected" });
        }

        // 4. Enviar
        const jid = clientPhone + "@s.whatsapp.net";
        await sessionToUse.sock.sendMessage(jid, { text: message });
        console.log(`📤 Outbound [${locationId}] a +${clientPhone} vía Slot ${foundSlot} (+${sessionToUse.myNumber})`);

        // 5. Actualizar Routing (Para mantener la conversación en este canal)
        await saveRouting(clientPhone, locationId, null, sessionToUse.myNumber);

        return res.json({ ok: true });
    }
    res.json({ ignored: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Error" }); }
});

// 5. Install Webhook (Menu Creator)
app.post("/ghl/app-webhook", async (req, res) => {
    // ... (Mismo código de instalación de siempre)
    // Solo asegúrate de que la URL del menú siga siendo la misma
    // Tu frontend manejará los slots, el backend solo necesita locationId
    try {
        const event = req.body;
        if (event.type === "INSTALL") {
          const { locationId, companyId } = event;
          // ... (Tokens Logic) ...
          // ...
          // Menu creation:
           await callGHLWithAgency({
              method: "post", url: "https://services.leadconnectorhq.com/custom-menus/",
              data: {
                title: "WhatsApp - Clic&App",
                url: `${CUSTOM_MENU_URL_WA}?location_id=${locationId}`, 
                // ... resto de config
                showOnCompany: false, showOnLocation: true, showToAllLocations: false, locations: [locationId],
                openMode: "iframe", userRole: "all", allowCamera: false, allowMicrophone: false
              },
            });
          return res.json({ ok: true });
        }
        res.json({ ignored: true });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

// Restaurar Sesiones (Loop por slots)
async function restoreSessions() {
  console.log("🔄 Restaurando sesiones...");
  try {
    const res = await pool.query("SELECT DISTINCT session_id FROM baileys_auth");
    for (const row of res.rows) {
      // session_id ahora es "loc123_slot1"
      // Necesitamos parsearlo para llamar a startWhatsApp
      const parts = row.session_id.split("_slot");
      if (parts.length === 2) {
          const locId = parts[0];
          const slotId = parts[1];
          startWhatsApp(locId, slotId).catch(console.error);
      }
    }
  } catch (e) { console.error(e); }
}

app.listen(PORT, async () => {
  console.log(`API Multi-Slot escuchando en puerto ${PORT}`);
  await restoreSessions();
});