const { pool } = require("../config/db");
const { normalizePhone } = require("../helpers/utils");
const { findOrCreateGHLContact, logMessageToGHL } = require("./ghlService");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");

// Estado Global
const sessions = new Map();
const botMessageIds = new Set();
const STORE_FILE = "baileys_store.json";

// Configuración de Directorios para Medios
// Subimos 2 niveles (src/services -> src -> root) y entramos a public
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "https://wa.clicandapp.com";

// Asegurar que exista la carpeta media
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// 🔥 STORE MANUAL
const store = {
    contacts: {},
    bind: (ev) => {
        ev.on('contacts.upsert', (contacts) => {
            for (const contact of contacts) {
                if (contact.id) store.contacts[contact.id] = { ...(store.contacts[contact.id] || {}), ...contact };
                if (contact.lid) store.contacts[contact.lid] = store.contacts[contact.id];
            }
        });
    },
    writeToFile: (filename) => { try { fs.writeFileSync(filename, JSON.stringify(store.contacts)); } catch(e){} },
    readFromFile: (filename) => { try { if(fs.existsSync(filename)) store.contacts = JSON.parse(fs.readFileSync(filename, 'utf-8')); } catch(e){} }
};

store.readFromFile(STORE_FILE);
setInterval(() => store.writeToFile(STORE_FILE), 10_000);

// --- DB HELPERS LOCALES ---

async function deleteSessionData(locationId, slot) {
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);

  // 1. INTENTAR CERRAR SESIÓN EN WHATSAPP (Logout real)
  if (session && session.sock) {
    try {
      // Verificamos si el socket está abierto antes de intentar logout
      if (session.sock.ws && session.sock.ws.isOpen) {
        console.log(`🔌 Cerrando sesión activa de WhatsApp para: ${sessionId}`);
        await session.sock.logout(); // <--- ESTA ES la clave para que desaparezca del celular
      }
    } catch (e) {
      console.warn(`⚠️ No se pudo cerrar sesión limpiamente (posiblemente ya cerrada): ${e.message}`);
    }

    try {
      // Destruir conexiones residuales
      session.sock.end(undefined);
      session.sock.ws.close();
    } catch (e) {}
  }

  // 2. Limpiar Memoria
  sessions.delete(sessionId);

  // 3. Limpiar Base de Datos
  try {
    await pool.query("DELETE FROM baileys_auth WHERE session_id = $1", [sessionId]);
  } catch (e) { console.error("Error DB Auth:", e.message); }
  
  try {
    await pool.query("DELETE FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slot]);
    console.log(`🗑️ Datos eliminados correctamente: ${sessionId}`);
  } catch (e) { console.error("Error DB Slots:", e.message); }
}

async function syncSlotInfo(locationId, slotId, phoneNumber) {
  // 1. Verificar si el slot ya existe
  const check = "SELECT * FROM location_slots WHERE location_id = $1 AND slot_id = $2";
  const res = await pool.query(check, [locationId, slotId]);

  if (res.rows.length === 0) {
    // 🔥 LÓGICA DE COLA: Asignar al final de la lista
    // Buscamos cuál es la prioridad más alta que existe actualmente para esta agencia
    const prioQuery = "SELECT COALESCE(MAX(priority), 0) as max_priority FROM location_slots WHERE location_id = $1";
    const prioRes = await pool.query(prioQuery, [locationId]);
    
    // La nueva prioridad será la máxima actual + 1. 
    // (Si no hay nadie, max es 0, así que el nuevo será 1).
    const nextPriority = parseInt(prioRes.rows[0].max_priority) + 1;

    const insert = `INSERT INTO location_slots (location_id, slot_id, phone_number, priority) VALUES ($1, $2, $3, $4)`;
    await pool.query(insert, [locationId, slotId, phoneNumber, nextPriority]);
    
    console.log(`🆕 Slot ${slotId} registrado con Prioridad ${nextPriority}`);
  } else {
    // Si ya existe, solo actualizamos el número, NO tocamos la prioridad
    const update = "UPDATE location_slots SET phone_number = $1, updated_at = NOW() WHERE location_id = $2 AND slot_id = $3";
    await pool.query(update, [phoneNumber, locationId, slotId]);
  }
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

async function getLocationSlotsConfig(locationId) {
    // 🔥 CLAVE: ORDER BY priority ASC (Menor número = Mayor prioridad)
    const sql = "SELECT * FROM location_slots WHERE location_id = $1 ORDER BY priority ASC";
    try {
        const res = await pool.query(sql, [locationId]);
        return res.rows; 
    } catch (e) { return []; }
}

// 🔥 HELPER: Descargar y Guardar Media
async function downloadAndSaveMedia(message, type) {
    try {
        const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
        
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            { },
            { 
                logger: pino({ level: 'silent' }),
                reuploadRequest: (msg) => new Promise((resolve) => resolve(msg)) 
            }
        );
        
        let ext = "bin";
        let mimeType = "";

        if (type === 'imageMessage') mimeType = message.message.imageMessage.mimetype;
        else if (type === 'videoMessage') mimeType = message.message.videoMessage.mimetype;
        else if (type === 'audioMessage') mimeType = message.message.audioMessage.mimetype;
        else if (type === 'documentMessage') mimeType = message.message.documentMessage.mimetype;
        
        if(mimeType) ext = mime.extension(mimeType) || "bin";

        const filename = `${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
        const filepath = path.join(MEDIA_DIR, filename);
        
        fs.writeFileSync(filepath, buffer);
        
        // Retornamos la URL pública que GHL podrá descargar
        return `${API_PUBLIC_URL}/media/${filename}`;
    } catch (e) {
        console.error("Error descargando media:", e);
        return null;
    }
}

// 🔥 HELPER JID: Recuperé la versión robusta que maneja LIDs
async function getRecipientPhone(remoteJid, sock) {
    if (remoteJid.includes("@s.whatsapp.net")) return normalizePhone(remoteJid.split("@")[0]);
    
    if (remoteJid.includes("@lid")) {
        // 1. Buscar en Store Manual
        const cached = store.contacts[remoteJid];
        if (cached && cached.id) return normalizePhone(cached.id.split("@")[0]);

        // 2. Fallback API
        try {
            const [result] = await sock.onWhatsApp(remoteJid);
            if (result && result.jid) return normalizePhone(result.jid.split("@")[0]);
        } catch (e) {}
    }
    return null;
}

async function waitForSocketOpen(sock) {
    if (sock.ws.isOpen) return;
    return new Promise((resolve, reject) => {
        let retries = 0;
        const interval = setInterval(() => {
            if (sock.ws.isOpen) { clearInterval(interval); resolve(); }
            if (retries++ > 20) { clearInterval(interval); reject(new Error("Socket timeout")); }
        }, 200);
    });
}

// --- MAIN START FUNCTION ---
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
    const { BufferJSON } = await import("@whiskeysockets/baileys");
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
    const creds = (await readData("creds")) || initAuthCreds();
    return {
        state: { creds, keys: {
            get: async (type, ids) => {
                const data = {};
                await Promise.all(ids.map(async (id) => {
                    let value = await readData(`${type}-${id}`);
                    if (value) data[id] = value;
                }));
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const cat in data) { for (const id in data[cat]) { const val = data[cat][id]; const key = `${cat}-${id}`; if (val) tasks.push(writeData(key, val)); } }
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

  // 🔥 VINCULAR STORE MANUAL
  store.bind(sock.ev);

  sessionData.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { sessionData.qr = qr; sessionData.isConnected = false; console.log(`📌 QR: ${sessionId}`); }
    
    if (connection === "open") { 
        sessionData.isConnected = true; 
        sessionData.qr = null; 
        const rawId = sock.user?.id;
        const myPhone = rawId ? normalizePhone(rawId.split(":")[0]) : "Desconocido";
        sessionData.myNumber = myPhone;
        console.log(`✅ CONECTADO: ${sessionId} (${myPhone})`); 
        syncSlotInfo(locationId, slotId, myPhone).catch(console.error);
    }
    
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      sessionData.isConnected = false; sessionData.sock = null;
      if (code !== 401 && code !== 403 && code !== 440) setTimeout(() => startWhatsApp(locationId, slotId), 3000);
      else sessions.delete(sessionId);
    }
  });

  // 📩 UPSERT VITAMINADO (Soporte Media + Replies + LIDs)
  sock.ev.on("messages.upsert", async (msg) => {
    try {
        const m = msg.messages[0];
        if (!m?.message) return;
        if (botMessageIds.has(m.key.id)) return; 

        const from = m.key.remoteJid.includes("@s.whatsapp.net") ? m.key.remoteJid : m.key.remoteJidAlt;

        if (!from || from.includes("status@") || from.includes("@newsletter")) return;

        const clientPhone = normalizePhone(from.split("@")[0]);

        // 2. DETECCIÓN DE CONTENIDO (Texto + Media)
        const msgType = Object.keys(m.message)[0];
        let text = "";
        let attachments = [];

        // Extraer Texto
        if (msgType === 'conversation') text = m.message.conversation;
        else if (msgType === 'extendedTextMessage') text = m.message.extendedTextMessage.text;
        else if (msgType === 'imageMessage') text = m.message.imageMessage.caption || "";
        else if (msgType === 'videoMessage') text = m.message.videoMessage.caption || "";
        else if (msgType === 'documentMessage') text = m.message.documentMessage.caption || "";

        // Extraer Media
        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(msgType)) {
            const url = await downloadAndSaveMedia(m, msgType);
            if (url) attachments.push(url);
            if (!text) text = `[Archivo Adjunto: ${msgType}]`;
        }

        if (!text && attachments.length === 0) return;

        // 3. DETECCIÓN DE RESPUESTA (Quoted Message)
        const contextInfo = m.message[msgType]?.contextInfo || m.message.extendedTextMessage?.contextInfo;
        if (contextInfo && contextInfo.quotedMessage) {
            let quotedText = "";
            const qMsg = contextInfo.quotedMessage;
            if (qMsg.conversation) quotedText = qMsg.conversation;
            else if (qMsg.extendedTextMessage) quotedText = qMsg.extendedTextMessage.text;
            else if (qMsg.imageMessage) quotedText = "[Imagen]";
            
            // Formato visual para GHL
            if (quotedText) {
                text = `> En respuesta a: "${quotedText.substring(0, 50)}..."\n\n${text}`;
            }
        }

        const myId = sock.user?.id;
        const myChannelNumber = myId ? normalizePhone(myId.split(":")[0]) : "";
        const isFromMe = m.key.fromMe;
        const waName = m.pushName || "Usuario WhatsApp";

        // Routing
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

        // 4. Enviar a GHL con attachments
        await logMessageToGHL(locationId, contact.id, messageForGHL, direction, attachments);

    } catch (error) { console.error("Upsert Error:", error.message); }
  });
}

module.exports = {
    sessions,
    botMessageIds,
    startWhatsApp,
    deleteSessionData,
    saveRouting,
    getRoutingForPhone,
    getLocationSlotsConfig,
    waitForSocketOpen
};