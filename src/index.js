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

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

// --- HELPERS BASE DE DATOS & SESIÓN ---

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
    // Ordenamos por prioridad ASC (1 es más importante que 99)
    const sql = "SELECT * FROM location_slots WHERE location_id = $1 ORDER BY priority ASC";
    try {
        const res = await pool.query(sql, [locationId]);
        return res.rows; 
    } catch (e) { return []; }
}

// --- HELPERS TOKENS GHL ---

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

// Función para enviar mensaje a la conversación de GHL (Inbound u Outbound registrado desde celular)
async function logMessageToGHL(locationId, contactId, text, direction = "inbound") {
  try {
    // Si es inbound (cliente -> bot), url es .../messages/inbound
    // Si es outbound (bot -> cliente), url es .../messages (para que aparezca como enviado)
    // GHL API a veces restringe crear outbound manualmente, así que lo registramos como inbound con nota
    // OJO: GHL V2 suele requerir que los mensajes externos entren por el endpoint de conversation provider.
    // Usaremos el endpoint standard de Inbound Webhook para asegurar que aparezca.
    
    await callGHLWithLocation(locationId, {
      method: "POST", url: "https://services.leadconnectorhq.com/conversations/messages/inbound",
      data: { 
          type: "SMS", 
          contactId, 
          locationId, 
          message: text, 
          direction: "inbound" // Siempre inbound para que GHL lo procese, aunque sea "desde el celular"
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

// Helper Anti-Timeout
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

  // 📩 UPSERT: Mensajes Entrantes Y Salientes desde Celular
  sock.ev.on("messages.upsert", async (msg) => {
    try {
        const m = msg.messages[0];
        if (!m?.message) return;

        // --- DETECTAR SI ES UN MENSAJE ENVIADO DESDE EL CELULAR ---
        const isFromMe = m.key.fromMe; 
        
        const from = m.key.remoteJid;
        if (from === "status@broadcast" || from.includes("@newsletter")) return;
        if (!from.includes("@s.whatsapp.net")) return;

        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        if (!text) return; 

        const clientPhone = normalizePhone(from.split("@")[0]);
        const myJid = sock.user?.id || "";
        const myChannelNumber = normalizePhone(myJid.split(":")[0].split("@")[0]);

        // LOGICA DUAL:
        // Si es FromMe (lo envié yo desde el cel), quiero que aparezca en GHL
        // Si NO es FromMe (es el cliente), proceso normal.

        // 1. Buscar Routing / Contacto en GHL
        const route = await getRoutingForPhone(clientPhone);
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;
        
        // Si yo estoy enviando desde el cel a un numero nuevo, GHL debe crear el contacto
        const contact = await findOrCreateGHLContact(locationId, clientPhone, "Usuario WhatsApp", existingContactId);

        if (!contact?.id) return;

        // 2. Guardar routing (esto mantiene la sesión pegajosa incluso si escribo desde el cel)
        await saveRouting(clientPhone, locationId, contact.id, myChannelNumber);

        // 3. Preparar Texto para GHL
        let messageForGHL = "";
        
        if (isFromMe) {
            // Mensaje saliente desde el celular físico
            messageForGHL = `[Enviado desde Celular/Web]\n${text}\n\nSource: +${myChannelNumber}`;
            console.log(`📱 Sync Mensaje enviado desde Celular (+${myChannelNumber}) -> ${clientPhone}`);
        } else {
            // Mensaje entrante del cliente
            messageForGHL = `${text}\n\nSource: +${myChannelNumber}`;
            console.log(`📩 Inbound Cliente (+${clientPhone}) -> Canal (+${myChannelNumber})`);
        }

        // 4. Enviar a GHL (Todo entra como 'inbound' al endpoint de webhook para que se registre visualmente)
        await logMessageToGHL(locationId, contact.id, messageForGHL);

    } catch (error) { console.error("Upsert Error:", error.message); }
  });
}

// -----------------------------
// ENDPOINTS HTTP
// -----------------------------

app.post("/start-whatsapp", async (req, res) => {
  const { locationId, slot } = req.query;
  if (!locationId || !slot) return res.status(400).json({ error: "Faltan params" });
  try {
    await startWhatsApp(locationId, slot);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error starting" }); }
});

app.get("/qr", (req, res) => {
  const { locationId, slot } = req.query;
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);
  if (!session || !session.qr) return res.status(404).json({ error: "QR no disponible" });
  res.json({ qr: session.qr });
});

app.get("/status", async (req, res) => {
  const { locationId, slot } = req.query;
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);
  
  let extraInfo = {};
  try {
      const dbInfo = await pool.query("SELECT priority, tags FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slot]);
      if (dbInfo.rows.length > 0) extraInfo = dbInfo.rows[0];
  } catch(e) {}

  if (session && session.isConnected) {
      return res.json({ connected: true, myNumber: session.myNumber, priority: extraInfo.priority || 99, tags: extraInfo.tags || [] });
  }
  res.json({ connected: false, priority: extraInfo.priority, tags: extraInfo.tags });
});

// --- WEBHOOK OUTBOUND (CON FALLBACK / CASCADA) ---
app.post("/ghl/webhook", async (req, res) => {
  try {
    const { locationId, phone, message, type } = req.body;
    if (!locationId || !phone || !message) return res.json({ ignored: true });

    if (type === "Outbound" || type === "SMS") {
        const clientPhone = normalizePhone(phone);
        
        // 1. Preparar Lista de Candidatos (DB + Memoria)
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
            for (const [sessId, sess] of sessions.entries()) {
                if (sessId.startsWith(`${locationId}_slot`) && sess.isConnected) {
                    candidates.push({ slot: parseInt(sessId.split("_slot")[1]), priority: 99, tags: [], myNumber: sess.myNumber, session: sess });
                }
            }
        }

        if (candidates.length === 0) return res.status(200).json({ error: "No connected devices" });

        // 2. Ordenar Candidatos por Jerarquía
        // Creamos una lista ordenada de "intentos"
        let priorityList = [];

        // A) Routing Histórico (Sticky) -> Primer intento
        const route = await getRoutingForPhone(clientPhone);
        if (route?.channelNumber) {
            const sticky = candidates.find(c => c.myNumber === route.channelNumber);
            if (sticky) priorityList.push({ ...sticky, reason: "Routing Histórico" });
        }

        // B) Tags -> Segundo intento (Si no había sticky o para tenerlo arriba)
        const tagged = candidates.filter(c => c.tags.includes("#priority"));
        tagged.forEach(c => priorityList.push({ ...c, reason: "Tag #priority" }));

        // C) Prioridad Numérica -> El resto
        candidates.sort((a, b) => a.priority - b.priority); // Ordenar 1, 2, 3...
        candidates.forEach(c => {
            // Evitar duplicados si ya lo agregamos por Sticky o Tag
            if (!priorityList.find(p => p.slot === c.slot)) {
                priorityList.push({ ...c, reason: `Prioridad ${c.priority}` });
            }
        });

        // 3. BUCLE DE ENVÍO (Cascada)
        let sentSuccess = false;
        let usedCandidate = null;

        for (const candidate of priorityList) {
            console.log(`🔄 Intentando enviar con Slot ${candidate.slot} (${candidate.reason})...`);
            
            // Verificar auto-mensaje
            const jid = clientPhone.replace(/\D/g, '') + "@s.whatsapp.net";
            if (clientPhone.includes(candidate.myNumber)) continue; // Saltar si es a mí mismo

            try {
                await waitForSocketOpen(candidate.session.sock);
                await candidate.session.sock.sendMessage(jid, { text: message });
                
                console.log(`✅ Enviado exitosamente por Slot ${candidate.slot}`);
                sentSuccess = true;
                usedCandidate = candidate;
                break; // ¡Éxito! Salimos del bucle
            } catch (e) {
                console.warn(`⚠️ Falló Slot ${candidate.slot}: ${e.message}. Probando siguiente...`);
                // Continúa al siguiente en la lista...
            }
        }

        if (sentSuccess && usedCandidate) {
            await saveRouting(clientPhone, locationId, null, usedCandidate.myNumber);
            return res.json({ ok: true });
        } else {
            console.error("❌ Todos los slots fallaron.");
            return res.status(500).json({ error: "All slots failed" });
        }
    }
    res.json({ ignored: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Internal Error" }); }
});

app.post("/config-slot", async (req, res) => {
  const { locationId, slot, phoneNumber, priority, addTag, removeTag } = req.body;
  if (!locationId) return res.status(400).json({ error: "Faltan datos" });

  try {
    let targetSlot = slot;
    if (!targetSlot && phoneNumber) {
        const normPhone = normalizePhone(phoneNumber);
        const find = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1 AND phone_number = $2", [locationId, normPhone]);
        if (find.rows.length === 0) return res.status(404).json({ error: "Número no encontrado" });
        targetSlot = find.rows[0].slot_id;
    }

    // Intercambio de Prioridad
    if (priority !== undefined) {
        const reqPrio = parseInt(priority);
        const all = await pool.query("SELECT slot_id, priority FROM location_slots WHERE location_id = $1", [locationId]);
        const conflict = all.rows.find(s => s.priority === reqPrio && s.slot_id !== parseInt(targetSlot));
        if (conflict) {
             // Buscar la prioridad actual del target para hacer swap
             const currPrio = all.rows.find(s => s.slot_id === parseInt(targetSlot))?.priority || 99;
             await pool.query("UPDATE location_slots SET priority = $1 WHERE location_id = $2 AND slot_id = $3", [currPrio, locationId, conflict.slot_id]);
        }
    }

    const check = await pool.query("SELECT tags, priority FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, targetSlot]);
    let tags = check.rows[0]?.tags || [];
    if (addTag && !tags.includes(addTag)) tags.push(addTag);
    if (removeTag) tags = tags.filter(t => t !== removeTag);
    
    let finalPrio = priority !== undefined ? parseInt(priority) : check.rows[0]?.priority;

    await pool.query("UPDATE location_slots SET tags = $1::jsonb, priority = $2, updated_at = NOW() WHERE location_id = $3 AND slot_id = $4", [JSON.stringify(tags), finalPrio, locationId, targetSlot]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/remove-slot", async (req, res) => {
    const { locationId, slot } = req.query;
    try { await deleteSessionData(locationId, slot); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const event = req.body;
        if (event.type === "INSTALL") {
          const { locationId, companyId } = event;
          const at = await ensureAgencyToken();
          const ats = await getTokens(AGENCY_ROW_ID);
          const lr = await axios.post("https://services.leadconnectorhq.com/oauth/locationToken", new URLSearchParams({ companyId, locationId }).toString(), { headers: { Authorization: `Bearer ${at}`, Version: GHL_API_VERSION, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
          await saveTokens(locationId, { ...ats, locationAccess: lr.data });
          await callGHLWithAgency({ method: "post", url: "https://services.leadconnectorhq.com/custom-menus/", data: { title: "WhatsApp - Clic&App", url: `${CUSTOM_MENU_URL_WA}?location_id=${locationId}`, showOnCompany: false, showOnLocation: true, showToAllLocations: false, locations: [locationId], openMode: "iframe", userRole: "all", allowCamera: false, allowMicrophone: false } }).catch(() => {});
          return res.json({ ok: true });
        }
        if (event.type === "UNINSTALL") {
            const slots = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1", [event.locationId]);
            for(const r of slots.rows) await deleteSessionData(event.locationId, r.slot_id);
            await pool.query("DELETE FROM auth_db WHERE locationid = $1", [event.locationId]);
            return res.json({ ok: true });
        }
        res.json({ ignored: true });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.get("/config", async (req, res) => { res.json({ max_slots: 3 }); });

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