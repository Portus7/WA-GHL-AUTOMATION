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

// 🧠 GESTOR DE SESIONES
const sessions = new Map(); 
// 🧠 CACHÉ ANTI-ECO (IDs de mensajes enviados por el bot para ignorarlos en el upsert)
const botMessageIds = new Set();

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
// HELPERS
// -----------------------------

async function deleteSessionData(locationId, slot) {
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);
  if (session && session.sock) { try { session.sock.end(undefined); } catch (e) {} }
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
  console.log(`🔄 Refrescando token forzado para: ${locationId}`);
  const tokens = await getTokens(locationId);
  if (!tokens) throw new Error(`No hay tokens para ${locationId}`);
  try {
    const body = new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: tokens.locationAccess.refresh_token });
    const refreshRes = await axios.post("https://services.leadconnectorhq.com/oauth/token", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
    const newToken = refreshRes.data;
    await saveTokens(locationId, { ...tokens, locationAccess: newToken });
    return newToken.access_token;
  } catch (e) { console.error(`❌ Error refrescando token: ${e.message}`); throw e; }
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
      console.warn(`⚠️ [AXIOS] 401 Detectado. Refrescando...`);
      const newAccessToken = await forceRefreshToken(locationId);
      return await axios({ ...config, headers: { Accept: "application/json", Version: GHL_API_VERSION, Authorization: `Bearer ${newAccessToken}`, "Location-Id": tokenData.realLocationId, ...(config.headers || {}) } });
    }
    throw error;
  }
}

// --- ROUTING ---
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

// --- GHL CONTACTS ---
async function findOrCreateGHLContact(locationId, phone, waName, contactId) {
  const p = "+" + normalizePhone(phone); 
  if (contactId) {
    try {
      const lookupRes = await callGHLWithLocation(locationId, { method: "GET", url: `https://services.leadconnectorhq.com/contacts/${contactId}` });
      const contact = lookupRes.data.contact || lookupRes.data;
      if (contact?.id) return contact;
    } catch (err) {}
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
    console.error("❌ Error creando contacto:", err.message);
    return null;
  }
}

async function logMessageToGHL(locationId, contactId, text) {
  try {
    await callGHLWithLocation(locationId, {
      method: "POST", url: "https://services.leadconnectorhq.com/conversations/messages/inbound",
      data: { 
          type: "SMS", 
          contactId, 
          locationId, 
          message: text, 
          direction: "inbound" 
      }
    });
  } catch (err) { console.error("GHL Log Error:", err.message); }
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
  if (existing && existing.sock) return existing;

  sessions.set(sessionId, { sock: null, qr: null, isConnected: false, myNumber: null });
  const currentSession = sessions.get(sessionId);

  console.log(`▶ Iniciando WhatsApp: ${sessionId}`);

  const { default: makeWASocket, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds } = await import("@whiskeysockets/baileys");

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

  currentSession.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) { currentSession.qr = qr; currentSession.isConnected = false; console.log(`📌 QR: ${sessionId}`); }
    
    if (connection === "open") { 
        currentSession.isConnected = true; 
        currentSession.qr = null; 
        const myJid = sock.user?.id;
        const myPhone = myJid ? normalizePhone(myJid.split(":")[0]) : "Desconocido";
        currentSession.myNumber = myPhone;
        console.log(`✅ CONECTADO: ${sessionId} (${myPhone})`); 
        syncSlotInfo(locationId, slotId, myPhone).catch(console.error);
    }
    
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      currentSession.isConnected = false; currentSession.sock = null;
      if (code !== 401 && code !== 403 && code !== 440) setTimeout(() => startWhatsApp(locationId, slotId), 3000);
      else sessions.delete(sessionId);
    }
  });

  // 📩 UPSERT: Mensajes Entrantes Y Salientes (desde Celular)
  sock.ev.on("messages.upsert", async (msg) => {
    try {
        const m = msg.messages[0];
        if (!m?.message) return;

        // 🛑 ANTI-ECO: Si el mensaje está en caché, es del bot (GHL)
        if (botMessageIds.has(m.key.id)) {
            return; // Lo ignoramos para no duplicar
        }

        const from = m.key.remoteJid;
        // Ignorar estados y newsletters
        if (from === "status@broadcast" || from.includes("@newsletter")) return;
        if (!from.includes("@s.whatsapp.net")) return;

        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        if (!text) return; 

        const clientPhone = normalizePhone(from.split("@")[0]);
        const myJid = sock.user?.id || "";
        const myChannelNumber = normalizePhone(myJid.split(":")[0].split("@")[0]);
        
        // Detectar si es mensaje enviado DESDE EL CELULAR FÍSICO (o Web)
        const isFromMe = m.key.fromMe;

        // Logica Contacto
        const route = await getRoutingForPhone(clientPhone);
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;
        const contact = await findOrCreateGHLContact(locationId, clientPhone, "Usuario WhatsApp", existingContactId);

        if (!contact?.id) return;

        await saveRouting(clientPhone, locationId, contact.id, myChannelNumber);

        let messageForGHL = "";
        
        if (isFromMe) {
            // ES UN MENSAJE SALIENTE MANUAL (Celular/Web)
            // Agregamos el tag para diferenciarlo
            messageForGHL = `${text}\n\n[Enviado desde otro dispositivo]\nSource: +${myChannelNumber}`;
            console.log(`📱 Sync Celular -> GHL (+${clientPhone})`);
        } else {
            // ES UN MENSAJE ENTRANTE DEL CLIENTE
            messageForGHL = `${text}\n\nSource: +${myChannelNumber}`;
            console.log(`📩 Inbound Cliente -> GHL (+${clientPhone})`);
        }

        await logMessageToGHL(locationId, contact.id, messageForGHL);

    } catch (error) { console.error("Upsert Error:", error.message); }
  });
}

// -----------------------------
// ENDPOINTS
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

    if (type === "Outbound" || type === "SMS") {
        const clientPhone = normalizePhone(phone);
        let dbConfigs = await getLocationSlotsConfig(locationId);
        
        let candidates = dbConfigs.map(conf => ({
            slot: conf.slot_id,
            priority: conf.priority,
            tags: conf.tags || [],
            myNumber: conf.phone_number, 
            session: sessions.get(`${locationId}_slot${conf.slot_id}`)
        })).filter(c => c.session && c.session.isConnected);

        if (candidates.length === 0) {
             // Fallback Memoria
             for (const [sid, s] of sessions.entries()) {
                if (sid.startsWith(`${locationId}_slot`) && s.isConnected) 
                    candidates.push({ slot: parseInt(sid.split("_slot")[1]), priority: 99, tags: [], myNumber: s.myNumber, session: s });
             }
        }

        if (candidates.length === 0) return res.json({ error: "No connected devices" });

        // ORDENAR CANDIDATOS PARA CASCADA (Fallback)
        // 1. Routing, 2. Tags, 3. Prioridad
        let attempts = [];
        const route = await getRoutingForPhone(clientPhone);
        if (route?.channelNumber) {
            const sticky = candidates.find(c => c.myNumber === route.channelNumber);
            if (sticky) attempts.push(sticky);
        }
        
        const tagged = candidates.filter(c => c.tags.includes("#priority"));
        attempts.push(...tagged);
        
        candidates.sort((a, b) => a.priority - b.priority);
        attempts.push(...candidates);

        // Eliminar duplicados en la lista de intentos
        attempts = [...new Set(attempts)];

        // --- INTENTO DE ENVÍO EN CASCADA ---
        let success = false;
        let finalNumber = null;

        const jid = clientPhone.replace(/\D/g, '') + "@s.whatsapp.net";

        for (const cand of attempts) {
            // No enviarse a uno mismo
            if (clientPhone.includes(cand.myNumber)) continue;

            console.log(`🚀 Probando Slot ${cand.slot} (+${cand.myNumber})...`);
            try {
                await waitForSocketOpen(cand.session.sock);
                const sent = await cand.session.sock.sendMessage(jid, { text: message });
                
                // AGREGAR ID AL CACHÉ ANTI-ECO
                if (sent?.key?.id) {
                    botMessageIds.add(sent.key.id);
                    setTimeout(() => botMessageIds.delete(sent.key.id), 10000);
                }

                success = true;
                finalNumber = cand.myNumber;
                console.log("✅ Enviado.");
                break; // Éxito, salir del bucle
            } catch (e) {
                console.warn(`⚠️ Falló Slot ${cand.slot}: ${e.message}. Intentando siguiente...`);
            }
        }

        if (success) {
            await saveRouting(clientPhone, locationId, null, finalNumber);
            return res.json({ ok: true });
        } else {
            console.error("❌ Todos los slots fallaron.");
            return res.status(500).json({ error: "Send failed" });
        }
    }
    res.json({ ignored: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Error" }); }
});

app.post("/config-slot", async (req, res) => {
  // ... (Mismo código de configuración anterior) ...
  // Para brevedad, usa el mismo bloque que ya tenías funcionando
  // Solo asegúrate de incluir el endpoint completo aquí
  const { locationId, slot, phoneNumber, priority, addTag, removeTag } = req.body;
  try {
    // Lógica completa de config...
    // (Copia y pega tu bloque funcional aquí)
    let targetSlot = slot;
    if(!targetSlot && phoneNumber) {
        const norm = normalizePhone(phoneNumber);
        const r = await pool.query("SELECT slot_id FROM location_slots WHERE location_id=$1 AND phone_number=$2", [locationId, norm]);
        if(r.rows.length) targetSlot = r.rows[0].slot_id;
    }
    // Exchange Logic
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
    // ... (Mismo código install/uninstall) ...
    try {
        const evt = req.body;
        if (evt.type === "INSTALL") {
             // Lógica Install
             const at = await ensureAgencyToken();
             // ...
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