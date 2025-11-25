const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const pino = require("pino");
const { webcrypto } = require("crypto");
const { Pool } = require("pg");
const axios = require("axios");

if (!globalThis.crypto) { globalThis.crypto = webcrypto; }

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA = process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
const AGENCY_ROW_ID = "__AGENCY__";

const sessions = new Map(); 
const botMessageIds = new Set();

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

// --- HELPERS ---

async function deleteSessionData(locationId, slot) {
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);
  if (session && session.sock) { 
      try { 
          session.sock.end(undefined); 
          session.sock.ws.close();
      } catch (e) {} 
  }
  sessions.delete(sessionId);
  try { await pool.query("DELETE FROM baileys_auth WHERE session_id = $1", [sessionId]); } catch (e) {}
  try { await pool.query("DELETE FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slot]); } catch (e) {}
}

async function syncSlotInfo(locationId, slotId, phoneNumber) {
  const check = "SELECT * FROM location_slots WHERE location_id = $1 AND slot_id = $2";
  const res = await pool.query(check, [locationId, slotId]);
  if (res.rows.length === 0) {
    const insert = `INSERT INTO location_slots (location_id, slot_id, phone_number, priority) VALUES ($1, $2, $3, $4)`;
    await pool.query(insert, [locationId, slotId, phoneNumber, slotId]);
  } else {
    const update = "UPDATE location_slots SET phone_number = $1, updated_at = NOW() WHERE location_id = $2 AND slot_id = $3";
    await pool.query(update, [phoneNumber, locationId, slotId]);
  }
}

async function getLocationSlotsConfig(locationId) {
    const sql = "SELECT * FROM location_slots WHERE location_id = $1 ORDER BY priority ASC";
    try {
        const res = await pool.query(sql, [locationId]);
        return res.rows; 
    } catch (e) { return []; }
}

// --- TOKENS ---
async function saveTokens(locationId, tokenData) {
  const sql = `INSERT INTO auth_db (locationid, raw_token) VALUES ($1, $2::jsonb) ON CONFLICT (locationid) DO UPDATE SET raw_token = EXCLUDED.raw_token`;
  await pool.query(sql, [locationId, JSON.stringify(tokenData)]);
}

async function getTokens(locationId) {
  const result = await pool.query("SELECT raw_token FROM auth_db WHERE locationid = $1", [locationId]);
  return result.rows[0]?.raw_token || null;
}

async function forceRefreshToken(locationId) {
  const tokens = await getTokens(locationId);
  if (!tokens) throw new Error(`No hay tokens para ${locationId}`);
  try {
    const body = new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: tokens.locationAccess.refresh_token });
    const refreshRes = await axios.post("https://services.leadconnectorhq.com/oauth/token", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
    const newToken = refreshRes.data;
    await saveTokens(locationId, { ...tokens, locationAccess: newToken });
    return newToken.access_token;
  } catch (e) { throw e; }
}

async function ensureAgencyToken() {
  let tokens = await getTokens(AGENCY_ROW_ID);
  if (!tokens) throw new Error("No hay tokens agencia");
  return tokens.access_token; 
}

async function ensureLocationToken(locationId) {
  const tokens = await getTokens(locationId);
  if (!tokens?.locationAccess) throw new Error(`No hay tokens para ${locationId}`);
  return { accessToken: tokens.locationAccess.access_token, realLocationId: tokens.locationAccess.locationId };
}

async function callGHLWithAgency(config) {
  const accessToken = await ensureAgencyToken();
  return axios({ ...config, headers: { Accept: "application/json", Version: GHL_API_VERSION, Authorization: `Bearer ${accessToken}`, ...(config.headers || {}) } });
}

async function callGHLWithLocation(locationId, config) {
  let tokenData;
  try { tokenData = await ensureLocationToken(locationId); } 
  catch (e) { 
      const newToken = await forceRefreshToken(locationId);
      tokenData = { accessToken: newToken, realLocationId: locationId };
  }
  try {
    return await axios({ ...config, headers: { Accept: "application/json", Version: GHL_API_VERSION, Authorization: `Bearer ${tokenData.accessToken}`, "Location-Id": tokenData.realLocationId, ...(config.headers || {}) } });
  } catch (error) {
    if (error.response?.status === 401) {
      const newAccessToken = await forceRefreshToken(locationId);
      return await axios({ ...config, headers: { Accept: "application/json", Version: GHL_API_VERSION, Authorization: `Bearer ${newAccessToken}`, "Location-Id": tokenData.realLocationId, ...(config.headers || {}) } });
    }
    throw error;
  }
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^\d+]/g, "");
}

async function saveRouting(clientPhone, locationId, contactId, channelNumber) {
  const normClient = normalizePhone(clientPhone);
  const normChannel = normalizePhone(channelNumber);
  const sql = `INSERT INTO phone_routing (phone, location_id, contact_id, channel_number, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (phone) DO UPDATE SET location_id = EXCLUDED.location_id, contact_id = COALESCE(EXCLUDED.contact_id, phone_routing.contact_id), channel_number = EXCLUDED.channel_number, updated_at = NOW()`;
  try { await pool.query(sql, [normClient, locationId, contactId, normChannel]); } catch (e) { console.error("Routing Error:", e.message); }
}

async function getRoutingForPhone(clientPhone) {
  const normClient = normalizePhone(clientPhone);
  try {
    const res = await pool.query("SELECT location_id, contact_id, channel_number FROM phone_routing WHERE phone = $1", [normClient]);
    if (res.rows.length > 0) return { locationId: res.rows[0].location_id, contactId: res.rows[0].contact_id, channelNumber: res.rows[0].channel_number };
    return null;
  } catch (e) { return null; }
}

// 🔥 HELPER: Resolución Activa de LID a JID
async function getRecipientPhone(remoteJid, sock) {
    // 1. Si ya es un número normal, lo devolvemos limpio
    if (remoteJid.includes("@s.whatsapp.net")) {
        return normalizePhone(remoteJid.split("@")[0]);
    }

    // 2. Si es un LID, le preguntamos a WhatsApp quién es
    if (remoteJid.includes("@lid")) {
        try {
            console.log(`🔍 Consultando a WhatsApp quién es el LID: ${remoteJid}...`);
            
            // Hacemos una query binaria interactiva para pedir el JID real
            const [result] = await sock.onWhatsApp(remoteJid);
            
            if (result && result.jid) {
                const realNumber = normalizePhone(result.jid.split("@")[0]);
                console.log(`✅ WhatsApp respondió: ${remoteJid} ===> ${realNumber}`);
                return realNumber;
            }
        } catch (e) {
            console.error("Error en consulta onWhatsApp:", e.message);
        }
    }
    
    return null;
}

// --- GHL CONTACTS ---
// --- GHL CONTACTS MEJORADO ---
async function findOrCreateGHLContact(locationId, phone, waName, contactId, fromMe) {
  const rawPhone = phone.replace(/\D/g, ''); 
  const phoneWithPlus = `+${rawPhone}`;
  
  // Definimos un nombre por defecto si waName viene vacío
  const safeName = (waName && waName.trim() && !fromMe) ? waName : "Usuario WhatsApp";

  let contact = null;

  // 1. Buscar por ID (si existe)
  if (contactId) {
    try {
      const lookupRes = await callGHLWithLocation(locationId, { method: "GET", url: `https://services.leadconnectorhq.com/contacts/${contactId}` });
      contact = lookupRes.data.contact || lookupRes.data;
    } catch (err) {}
  }

  // 2. Si no, Búsqueda Inteligente (Query)
  if (!contact || !contact.id) {
      try {
          const searchRes = await callGHLWithLocation(locationId, {
              method: "GET", url: "https://services.leadconnectorhq.com/contacts/",
              params: { locationId: locationId, query: rawPhone, limit: 1 }
          });
          if (searchRes.data && searchRes.data.contacts && searchRes.data.contacts.length > 0) {
              const found = searchRes.data.contacts[0];
              const foundPhone = found.phone ? found.phone.replace(/\D/g, '') : "";
              if (foundPhone.includes(rawPhone) || rawPhone.includes(foundPhone)) {
                  contact = found;
              }
          }
      } catch(e) {}
  }

  // 3. Si encontramos el contacto, revisamos si hay que actualizar el nombre
  if (contact && contact.id) {
      //const currentName = ((contact.firstName || "") + " " + (contact.lastName || "")).toLowerCase().trim();
      //const isPlaceholder = currentName === "Usuario WhatsApp" || currentName === "usuario" || currentName === "" || currentName === "null";
      
      console.log(contact.firstName, safeName, "contacto")
      
      // Solo actualizamos si el nombre actual es genérico Y el nuevo nombre es bueno
      if (contact.firstName == "Usuario WhatsApp") {
           console.log(`🔄 Actualizando nombre de contacto ${contact.id}: ${safeName}`);
           try {
               await callGHLWithLocation(locationId, {
                   method: "PUT", url: `https://services.leadconnectorhq.com/contacts/${contact.id}`,
                   data: { firstName: safeName, lastName: "" }
               });
           } catch(e){ console.error("Error actualizando nombre:", e.message); }
      }
      return contact;
  }

  // 4. Crear Contacto Nuevo (Si no existía)
  try {
    const createdRes = await callGHLWithLocation(locationId, {
      method: "POST", url: "https://services.leadconnectorhq.com/contacts/",
      data: { locationId, phone: phoneWithPlus, firstName: safeName, source: "WhatsApp Baileys" }
    });
    return createdRes.data.contact || createdRes.data;
  } catch (err) {
    const body = err.response?.data;
    if (err.response?.status === 400 && body?.meta?.contactId) return { id: body.meta.contactId, phone: phoneWithPlus };
    return null;
  }
}

async function logMessageToGHL(locationId, contactId, text, direction) {
  try {
    let url = "https://services.leadconnectorhq.com/conversations/messages"; 
    if (direction === "inbound") url = "https://services.leadconnectorhq.com/conversations/messages/inbound";

    await callGHLWithLocation(locationId, {
      method: "POST", url: url,
      data: { type: "SMS", contactId, locationId, message: text, direction: direction }
    });
    console.log(`✅ GHL Sync [${direction}]: ${text.substring(0, 15)}...`);
  } catch (err) { console.error(`❌ GHL Log Error:`, err.message); }
}

// -----------------------------
// LÓGICA WHATSAPP
// -----------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

async function waitForSocketOpen(sock) {
    if (sock.ws.isOpen) return;
    return new Promise((resolve, reject) => {
        let retries = 0;
        const interval = setInterval(() => {
            if (sock.ws.isOpen) { clearInterval(interval); resolve(); }
            if (retries++ > 20) { clearInterval(interval); reject(new Error("Socket failed to open")); }
        }, 200);
    });
}

async function startWhatsApp(locationId, slotId) {
  const sessionId = `${locationId}_slot${slotId}`; 
  const existing = sessions.get(sessionId);
  if (existing && existing.sock && existing.isConnected) return existing;

  const sessionData = { sock: null, qr: null, isConnected: false, myNumber: null };
  sessions.set(sessionId, sessionData);

  console.log(`▶ Iniciando: ${sessionId}`);

  const baileys = await import("@whiskeysockets/baileys");
  const { default: makeWASocket, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds } = baileys;

  async function usePostgreSQLAuthState(pool, id) {
    const { BufferJSON, proto } = await import("@whiskeysockets/baileys");
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
    defaultQueryTimeoutMs: 0, 
    keepAliveIntervalMs: 10000,
    syncFullHistory: false, 
    generateHighQualityLinkPreview: false, 
    retryRequestDelayMs: 500
  });

  sessionData.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { sessionData.qr = qr; sessionData.isConnected = false; console.log(`📌 QR: ${sessionId}`); }
    
    if (connection === "open") { 
        sessionData.isConnected = true; 
        sessionData.qr = null; 
        const myJid = sock.user?.id;
        const myPhone = myJid ? normalizePhone(myJid.split(":")[0]) : "Desconocido";
        sessionData.myNumber = myPhone;
        console.log(`✅ CONECTADO: ${sessionId} (${myPhone})`); 
        syncSlotInfo(locationId, slotId, myPhone).catch(console.error);
    }
    
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      sessionData.isConnected = false; sessionData.sock = null;
      if (code !== 401 && code !== 403 && code !== 440) {
          setTimeout(() => startWhatsApp(locationId, slotId), 3000);
      } else {
          if (sessions.get(sessionId) === sessionData) sessions.delete(sessionId);
      }
    }
  });

  sock.ev.on("messages.upsert", async (msg) => {
    try {
        const m = msg.messages[0];
        console.log(msg.messages[0])
        if (!m?.message) return;
        if (botMessageIds.has(m.key.id)) return; 

        const from = m.key.remoteJid.includes("@s.whatsapp.net") ? m.key.remoteJid : m.key.remoteJidAlt;

        clientPhone = normalizePhone(from.split("@")[0]);
        // 🔥 TRADUCCIÓN DE LID A TELÉFONO (Usando API de WhatsApp)
        //const clientPhone = await getRecipientPhone(from, sock); // Pasamos 'sock'
        
        //if (!clientPhone) {
             // Filtros de basura silenciosa
        //     if (from.includes("@lid")) console.warn("LID no traducible, ignorando.");
        //     return;
        //}

        if (from === "status@broadcast" || from.includes("@newsletter")) return;

        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        if (!text) return; 

        const myJid = sock.user?.id || "";
        const myChannelNumber = normalizePhone(myJid.split(":")[0].split("@")[0]);
        const isFromMe = m.key.fromMe;
        const waName = m.pushName || "";

        console.log(`📩 PROCESANDO: ${clientPhone} (FromMe: ${isFromMe})`);

        const route = await getRoutingForPhone(clientPhone);
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;
        
        const contact = await findOrCreateGHLContact(locationId, clientPhone, waName, existingContactId, isFromMe);

        if (!contact?.id) return;

        await saveRouting(clientPhone, locationId, contact.id, myChannelNumber);

        let messageForGHL = "";
        let direction = "inbound";

        if (isFromMe) {
            messageForGHL = `${text}\n\n[Enviado desde otro dispositivo]\nSource: +${myChannelNumber}`;
            direction = "outbound"; 
        } else {
            messageForGHL = `${text}\n\nSource: +${myChannelNumber}`;
            direction = "inbound"; 
        }

        await logMessageToGHL(locationId, contact.id, messageForGHL, direction);

    } catch (error) { console.error("Upsert Error:", error.message); }
  });
}

// -----------------------------
// ENDPOINTS HTTP
// -----------------------------

app.post("/start-whatsapp", async (req, res) => {
  const { locationId, slot } = req.query;
  try { await startWhatsApp(locationId, slot); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ error: "Error" }); }
});

app.get("/qr", (req, res) => {
  const { locationId, slot } = req.query;
  const sess = sessions.get(`${locationId}_slot${slot}`);
  if (!sess || !sess.qr) return res.status(404).json({ error: "No QR" });
  res.json({ qr: sess.qr });
});

app.get("/status", async (req, res) => {
  const { locationId, slot } = req.query;
  const sess = sessions.get(`${locationId}_slot${slot}`);
  let extra = {};
  try { 
      const r = await pool.query("SELECT priority, tags FROM location_slots WHERE location_id=$1 AND slot_id=$2", [locationId, slot]);
      if (r.rows.length) extra = r.rows[0];
  } catch(e){}
  if (sess && sess.isConnected) return res.json({ connected: true, myNumber: sess.myNumber, priority: extra.priority||99, tags: extra.tags||[] });
  res.json({ connected: false, priority: extra.priority, tags: extra.tags });
});

app.post("/ghl/webhook", async (req, res) => {
  try {
    const { locationId, phone, message, type } = req.body;
    if (!locationId || !phone || !message) return res.json({ ignored: true });

    if (message.includes("[Enviado desde otro dispositivo]")) return res.json({ ignored: true });

    if (type === "Outbound" || type === "SMS") {
        const clientPhone = normalizePhone(phone);
        let dbConfigs = await getLocationSlotsConfig(locationId);
        
        let availableCandidates = dbConfigs.map(conf => ({
            slot: conf.slot_id,
            priority: conf.priority,
            tags: conf.tags || [],
            myNumber: conf.phone_number, 
            session: sessions.get(`${locationId}_slot${conf.slot_id}`)
        })).filter(c => c.session && c.session.isConnected);

        if (availableCandidates.length === 0) {
             for (const [sid, s] of sessions.entries()) {
                if (sid.startsWith(`${locationId}_slot`) && s.isConnected) 
                    availableCandidates.push({ slot: parseInt(sid.split("_slot")[1]), priority: 99, myNumber: s.myNumber, session: s });
             }
             availableCandidates.sort((a,b) => a.slot - b.slot);
        }

        if (availableCandidates.length === 0) return res.status(200).json({ error: "No connected devices" });

        let selectedCandidate = availableCandidates[0];
        const sessionToUse = selectedCandidate.session;
        const jid = clientPhone.replace(/\D/g, '') + "@s.whatsapp.net";

        console.log(`🚀 Enviando con Slot ${selectedCandidate.slot} -> ${jid}`);

        try {
            await waitForSocketOpen(sessionToUse.sock);
            const sent = await sessionToUse.sock.sendMessage(jid, { text: message });
            
            if (sent?.key?.id) {
                botMessageIds.add(sent.key.id);
                setTimeout(() => botMessageIds.delete(sent.key.id), 15000);
            }

            console.log(`✅ Enviado.`);
            await saveRouting(clientPhone, locationId, null, selectedCandidate.myNumber);
            return res.json({ ok: true });

        } catch (e) { return res.status(500).json({ error: "Send failed" }); }
    }
    res.json({ ignored: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Error" }); }
});

app.post("/config-slot", async (req, res) => {
  const { locationId, slot, phoneNumber, priority, addTag, removeTag } = req.body;
  if (!locationId) return res.status(400).json({ error: "Faltan datos" });
  try {
    let targetSlot = slot;
    if(!targetSlot && phoneNumber) {
        const norm = normalizePhone(phoneNumber);
        const r = await pool.query("SELECT slot_id FROM location_slots WHERE location_id=$1 AND phone_number=$2", [locationId, norm]);
        if(r.rows.length) targetSlot = r.rows[0].slot_id;
    }
    if(priority !== undefined) {
        const p = parseInt(priority);
        const all = await pool.query("SELECT slot_id, priority FROM location_slots WHERE location_id=$1", [locationId]);
        const conflict = all.rows.find(x => x.priority === p && x.slot_id != targetSlot);
        if(conflict) await pool.query("UPDATE location_slots SET priority=$1 WHERE location_id=$2 AND slot_id=$3", [99, locationId, conflict.slot_id]);
    }
    const chk = await pool.query("SELECT tags, priority FROM location_slots WHERE location_id=$1 AND slot_id=$2", [locationId, targetSlot]);
    let t = chk.rows[0]?.tags || [];
    if(addTag && !t.includes(addTag)) t.push(addTag);
    if(removeTag) t = t.filter(x => x !== removeTag);
    const finalP = priority !== undefined ? parseInt(priority) : chk.rows[0]?.priority;
    await pool.query("UPDATE location_slots SET tags=$1::jsonb, priority=$2 WHERE location_id=$3 AND slot_id=$4", [JSON.stringify(t), finalP, locationId, targetSlot]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/remove-slot", async (req, res) => {
    try { await deleteSessionData(req.query.locationId, req.query.slot); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const evt = req.body;
        if (evt.type === "INSTALL") {
             const at = await ensureAgencyToken();
             const ats = await getTokens(AGENCY_ROW_ID);
             const lr = await axios.post("https://services.leadconnectorhq.com/oauth/locationToken", new URLSearchParams({ companyId: evt.companyId, locationId: evt.locationId }).toString(), { headers: { Authorization: `Bearer ${at}`, Version: GHL_API_VERSION, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
             await saveTokens(evt.locationId, { ...ats, locationAccess: lr.data });
             await callGHLWithAgency({ method: "post", url: "https://services.leadconnectorhq.com/custom-menus/", data: { title: "WhatsApp - Clic&App", url: `${CUSTOM_MENU_URL_WA}?location_id=${evt.locationId}`, showOnCompany: false, showOnLocation: true, showToAllLocations: false, locations: [evt.locationId], openMode: "iframe", userRole: "all", allowCamera: false, allowMicrophone: false } }).catch(() => {});
             return res.json({ ok: true });
        }
        if (evt.type === "UNINSTALL") {
            const slots = await pool.query("SELECT slot_id FROM location_slots WHERE location_id=$1", [evt.locationId]);
            for(const r of slots.rows) await deleteSessionData(evt.locationId, r.slot_id);
            await pool.query("DELETE FROM auth_db WHERE locationid=$1", [evt.locationId]);
            return res.json({ ok: true });
        }
        res.json({ ignored: true });
    } catch (e) { res.status(500).json({error: "Error"}); }
});

app.get("/config", (req, res) => res.json({ max_slots: 3 }));

async function restoreSessions() {
  try {
    const res = await pool.query("SELECT DISTINCT session_id FROM baileys_auth");
    for (const row of res.rows) {
      const parts = row.session_id.split("_slot");
      if (parts.length === 2) startWhatsApp(parts[0], parts[1]).catch(console.error);
    }
  } catch (e) { console.error(e); }
}

app.listen(PORT, async () => { console.log(`API OK ${PORT}`); await restoreSessions(); });