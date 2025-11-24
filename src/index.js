const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const pino = require("pino");
const { webcrypto } = require("crypto");
const { Pool } = require("pg");
const axios = require("axios");

// Parche crypto
if (!globalThis.crypto) { globalThis.crypto = webcrypto; }

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA = process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
const AGENCY_ROW_ID = "__AGENCY__";

// 🧠 GESTOR DE SESIONES
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
// HELPERS
// -----------------------------

async function deleteSessionData(locationId, slot) {
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);

  if (session && session.sock) {
    try { session.sock.end(undefined); } catch (e) {}
  }

  sessions.delete(sessionId);

  try {
    await pool.query("DELETE FROM baileys_auth WHERE session_id = $1", [sessionId]);
  } catch (e) { console.error("Error DB delete auth:", e); }
  
  try {
    await pool.query("DELETE FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slot]);
    console.log(`🗑️ Datos eliminados: ${sessionId}`);
  } catch (e) { console.error("Error DB delete slot:", e); }
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

// --- GHL TOKENS ---
async function saveTokens(locationId, tokenData) {
  const sql = `INSERT INTO auth_db (locationid, raw_token) VALUES ($1, $2::jsonb) ON CONFLICT (locationid) DO UPDATE SET raw_token = EXCLUDED.raw_token`;
  await pool.query(sql, [locationId, JSON.stringify(tokenData)]);
}

async function getTokens(locationId) {
  const result = await pool.query("SELECT raw_token FROM auth_db WHERE locationid = $1", [locationId]);
  return result.rows[0]?.raw_token || null;
}

async function ensureAgencyToken() {
  let tokens = await getTokens(AGENCY_ROW_ID);
  if (!tokens) throw new Error("No hay tokens de agencia");
  try {
    await axios.get(`https://services.leadconnectorhq.com/companies/${tokens.companyId}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json", Version: GHL_API_VERSION },
        params: { limit: 1 }, timeout: 10000
    });
    return tokens.access_token;
  } catch (err) {
    if (err.response?.status === 401) {
      const body = new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      const refreshRes = await axios.post("https://services.leadconnectorhq.com/oauth/token", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
      await saveTokens(AGENCY_ROW_ID, refreshRes.data);
      return refreshRes.data.access_token;
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
        timeout: 10000
      });
    }
    return { accessToken: locationToken.access_token, realLocationId: locationToken.locationId };
  } catch (err) {
    if (err.response?.status === 401) {
      const body = new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: locationToken.refresh_token });
      const refreshRes = await axios.post("https://services.leadconnectorhq.com/oauth/token", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
      await saveTokens(locationId, { ...tokens, locationAccess: refreshRes.data });
      return { accessToken: refreshRes.data.access_token, realLocationId: refreshRes.data.locationId };
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

// --- ROUTING ---
function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^\d+]/g, "");
}

async function saveRouting(clientPhone, locationId, contactId, channelNumber) {
  const normClient = normalizePhone(clientPhone);
  const normChannel = normalizePhone(channelNumber); 
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
  catch (e) { console.error("Routing Error:", e.message); }
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
            channelNumber: res.rows[0].channel_number 
        };
    }
    return null;
  } catch (e) { return null; }
}

async function findOrCreateGHLContact(locationId, phone, waName, contactId) {
  const p = "+" + normalizePhone(phone); 
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
  } catch (err) { console.error("GHL Inbound Error:", err.message); }
}

// -----------------------------
// LÓGICA WHATSAPP (Optimized)
// -----------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

async function startWhatsApp(locationId, slotId) {
  const sessionId = `${locationId}_slot${slotId}`; 
  const existing = sessions.get(sessionId);
  if (existing && existing.sock) return existing;

  sessions.set(sessionId, { sock: null, qr: null, isConnected: false, myNumber: null });
  const currentSession = sessions.get(sessionId);

  console.log(`▶ Iniciando WhatsApp: ${sessionId}`);

  const { default: makeWASocket, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds } = await import("@whiskeysockets/baileys");

  // Auth Postgres
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

  // 🔥 CONFIGURACIÓN ANTI-TIMEOUT 🔥
  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
    browser: [`ClicAndApp Slot ${slotId}`, "Chrome", "10.0"],
    
    // Optimizaciones Críticas
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0, // 0 = Desactivar timeout por query (evita error 408 en sync)
    keepAliveIntervalMs: 10000,
    syncFullHistory: false, // NO descargar historial completo (Vital para velocidad)
    generateHighQualityLinkPreview: false, // Ahorra recursos
    retryRequestDelayMs: 500
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
        const myJid = sock.user?.id;
        const myPhone = myJid ? normalizePhone(myJid.split(":")[0]) : "Desconocido";
        currentSession.myNumber = myPhone;
        console.log(`✅ CONECTADO: ${sessionId} (${myPhone})`); 
        syncSlotInfo(locationId, slotId, myPhone).catch(console.error);
    }
    
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      currentSession.isConnected = false; 
      currentSession.sock = null;
      currentSession.myNumber = null;
      
      // Reconectar si no fue Logout (401) ni Conflict (440 por usarlo en otro lado)
      if (code !== 401 && code !== 403 && code !== 440) {
          setTimeout(() => startWhatsApp(locationId, slotId), 3000);
      } else {
          console.log(`⚠️ Sesión ${sessionId} cerrada permanentemente.`);
          sessions.delete(sessionId);
      }
    }
  });

// 📩 INBOUND (Mensajes Entrantes)
  sock.ev.on("messages.upsert", async (msg) => {
    try {
        const m = msg.messages[0];
        if (!m?.message || m.key.fromMe) return;

        const from = m.key.remoteJid;

        // --- 🛑 FILTROS DE BASURA (CRÍTICO) ---
        // 1. Ignorar Estados (Stories)
        if (from === "status@broadcast") return;
        
        // 2. Ignorar Grupos (Si solo quieres chats 1 a 1)
        if (from.includes("@g.us")) return;

        // 3. Ignorar Canales/Newsletters
        if (from.includes("@newsletter")) return;
        
        // 4. Ignorar mensajes de sistema (protocolo)
        if (from.includes("@s.whatsapp.net") === false) return;
        // ---------------------------------------

        // Extraer texto (soportando texto simple y extendido)
        const text = m.message.conversation || 
                     m.message.extendedTextMessage?.text || 
                     m.message.imageMessage?.caption || 
                     m.message.videoMessage?.caption;

        if (!text) return; // Si es solo una foto sin texto o sticker, lo ignoramos por ahora

        const waName = m.pushName || "Usuario WhatsApp";
        const clientPhone = normalizePhone(from.split("@")[0]);
        
        // Detectar mi propio número (Canal Receptor) de forma segura
        // Baileys a veces devuelve "ID:AGENTE@s.whatsapp.net", limpiamos todo
        const myJid = sock.user?.id || "";
        const myChannelNumber = normalizePhone(myJid.split(":")[0].split("@")[0]);

        console.log(`📩 [${locationId} | Slot ${slotId}] Mensaje real de +${clientPhone}: "${text.substring(0, 20)}..."`);

        // 1. Routing: Guardamos que este cliente habló con ESTE location por ESTE canal
        const route = await getRoutingForPhone(clientPhone);
        
        // Si ya existe routing con otra location, lo respetamos? 
        // En tu caso Multi-Slot para UNA location, el locationId siempre es el mismo,
        // lo que cambia es el channelNumber (tu número).
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;

        const contact = await findOrCreateGHLContact(locationId, clientPhone, waName, existingContactId);

        if (contact?.id) {
            await saveRouting(clientPhone, locationId, contact.id, myChannelNumber);

            // 2. Modificar mensaje para GHL: Agregar Source para que sepas a qué numero escribieron
            const messageWithSource = `${text}\n\nSource: +${myChannelNumber}`;
            
            await sendMessageToGHLConversation(locationId, contact.id, messageWithSource);
        }
    } catch (error) { 
        console.error("❌ Error procesando inbound:", error.message); 
    }
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
      return res.json({ 
          connected: true, 
          myNumber: session.myNumber,
          priority: extraInfo.priority || 99,
          tags: extraInfo.tags || [] 
      });
  }
  res.json({ connected: false, priority: extraInfo.priority, tags: extraInfo.tags });
});

// 🔧 HELPER: Esperar a que el socket esté listo (Anti-Timeout)
async function waitForSocketOpen(sock) {
    if (sock.ws.isOpen) return;
    return new Promise((resolve, reject) => {
        let retries = 0;
        const interval = setInterval(() => {
            if (sock.ws.isOpen) {
                clearInterval(interval);
                resolve();
            }
            if (retries++ > 20) { // Esperar máx 4 seg
                clearInterval(interval);
                reject(new Error("Socket failed to open in time"));
            }
        }, 200);
    });
}

app.post("/ghl/webhook", async (req, res) => {
  try {
    const { locationId, phone, message, type } = req.body;
    if (!locationId || !phone || !message) return res.json({ ignored: true });

    if (type === "Outbound" || type === "SMS") {
        const clientPhone = normalizePhone(phone);
        const dbConfigs = await getLocationSlotsConfig(locationId);
        
        const availableCandidates = dbConfigs.map(conf => {
            const sess = sessions.get(`${locationId}_slot${conf.slot_id}`);
            return {
                slot: conf.slot_id,
                priority: conf.priority,
                tags: conf.tags || [],
                myNumber: conf.phone_number, 
                session: sess
            };
        }).filter(c => c.session && c.session.isConnected);

        if (availableCandidates.length === 0) return res.json({ error: "No connected devices" });

        let selectedCandidate = null;
        
        // 1. Routing
        const route = await getRoutingForPhone(clientPhone);
        if (route?.channelNumber) selectedCandidate = availableCandidates.find(c => c.myNumber === route.channelNumber);
        
        // 2. Tags
        if (!selectedCandidate) selectedCandidate = availableCandidates.find(c => c.tags.includes("#priority"));
        
        // 3. Priority
        if (!selectedCandidate) selectedCandidate = availableCandidates[0];

        const sessionToUse = selectedCandidate.session;
        const jid = clientPhone + "@s.whatsapp.net";

        // 🔥 INTENTO ROBUSTO DE ENVÍO 🔥
        try {
            await waitForSocketOpen(sessionToUse.sock); // Esperar a que esté listo
            await sessionToUse.sock.sendMessage(jid, { text: message });
        } catch (e) {
            console.warn(`⚠️ Primer intento falló (${e.message}). Reintentando en 1s...`);
            await new Promise(r => setTimeout(r, 1000));
            await sessionToUse.sock.sendMessage(jid, { text: message }); 
        }

        await saveRouting(clientPhone, locationId, null, selectedCandidate.myNumber);
        return res.json({ ok: true });
    }
    res.json({ ignored: true });
  } catch (err) { 
      console.error(err); 
      res.status(500).json({ error: "Error interno" }); 
  }
});

app.post("/config-slot", async (req, res) => {
  const { locationId, slot, phoneNumber, priority, addTag, removeTag } = req.body;
  if (!locationId || (!slot && !phoneNumber)) return res.status(400).json({ error: "Faltan datos" });

  try {
    let targetSlot = slot;
    if (!targetSlot && phoneNumber) {
        const normPhone = normalizePhone(phoneNumber);
        const find = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1 AND phone_number = $2", [locationId, normPhone]);
        if (find.rows.length === 0) return res.status(404).json({ error: "Número no encontrado" });
        targetSlot = find.rows[0].slot_id;
    }

    const check = await pool.query("SELECT tags, priority FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, targetSlot]);
    let currentTags = check.rows[0]?.tags || [];
    let currentPriority = check.rows[0]?.priority || 99;

    if (addTag && !currentTags.includes(addTag)) currentTags.push(addTag);
    if (removeTag) currentTags = currentTags.filter(t => t !== removeTag);
    if (priority !== undefined) currentPriority = parseInt(priority);

    const update = `UPDATE location_slots SET tags = $1::jsonb, priority = $2, updated_at = NOW() WHERE location_id = $3 AND slot_id = $4`;
    await pool.query(update, [JSON.stringify(currentTags), currentPriority, locationId, targetSlot]);

    res.json({ success: true, slot: targetSlot, tags: currentTags, priority: currentPriority });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/remove-slot", async (req, res) => {
    const { locationId, slot } = req.query;
    if (!locationId || !slot) return res.status(400).json({ error: "Faltan datos" });
    try {
        await deleteSessionData(locationId, slot);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. Install / Uninstall Webhook
app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const event = req.body;
        const { type, locationId, companyId } = event;

        if (type === "INSTALL") {
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

           await callGHLWithAgency({
              method: "post", url: "https://services.leadconnectorhq.com/custom-menus/",
              data: {
                title: "WhatsApp - Clic&App",
                url: `${CUSTOM_MENU_URL_WA}?location_id=${locationId}`, 
                showOnCompany: false, showOnLocation: true, showToAllLocations: false, locations: [locationId],
                openMode: "iframe", userRole: "all", allowCamera: false, allowMicrophone: false
              },
            }).catch(() => {});
          return res.json({ ok: true });
        }

        // 🚨 EVENTO UNINSTALL AGREGADO
        if (type === "UNINSTALL") {
            console.log(`🗑️ UNINSTALL: ${locationId}`);
            const activeSlots = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1", [locationId]);
            for(const row of activeSlots.rows) {
                await deleteSessionData(locationId, row.slot_id);
            }
            await pool.query("DELETE FROM auth_db WHERE locationid = $1", [locationId]);
            return res.json({ ok: true });
        }

        res.json({ ignored: true });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.get("/config", async (req, res) => { res.json({ max_slots: 3 }); });

async function restoreSessions() {
  console.log("🔄 Restaurando sesiones...");
  try {
    const res = await pool.query("SELECT DISTINCT session_id FROM baileys_auth");
    for (const row of res.rows) {
      const parts = row.session_id.split("_slot");
      if (parts.length === 2) {
          startWhatsApp(parts[0], parts[1]).catch(console.error);
      }
    }
  } catch (e) { console.error(e); }
}

app.listen(PORT, async () => {
  console.log(`API Multi-Slot escuchando en puerto ${PORT}`);
  await restoreSessions();
});