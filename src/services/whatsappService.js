const { pool } = require("../config/db");
const { normalizePhone } = require("../helpers/utils");
const { findOrCreateGHLContact, logMessageToGHL } = require("./ghlService");
const pino = require("pino");

// Estado en memoria
const sessions = new Map();
const botMessageIds = new Set();

// DB Helpers locales para WA
async function deleteSessionData(locationId, slot) {
  const sessionId = `${locationId}_slot${slot}`;
  const session = sessions.get(sessionId);
  if (session && session.sock) { 
      try { session.sock.end(undefined); session.sock.ws.close(); } catch (e) {} 
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
    const sql = "SELECT * FROM location_slots WHERE location_id = $1 ORDER BY priority ASC";
    try { const res = await pool.query(sql, [locationId]); return res.rows; } catch (e) { return []; }
}

// Helper LID Resolution
async function getRecipientPhone(remoteJid, sock) {
    if (remoteJid.includes("@s.whatsapp.net")) return normalizePhone(remoteJid.split("@")[0]);
    if (remoteJid.includes("@lid")) {
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

// --- START WHATSAPP ---
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
    // ... (Lógica Auth IDÉNTICA a tu código anterior para leer/escribir en DB) ...
    // Para ahorrar espacio aquí, asumo que copias la función usePostgreSQLAuthState completa
    // que ya tenías en el index.js
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
                    // Nota: Importar proto si es necesario para deserializar
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
        if (!m?.message) return;
        if (botMessageIds.has(m.key.id)) return; 

        const from = m.key.remoteJid.includes("@s.whatsapp.net") ? m.key.remoteJid : m.key.remoteJidAlt;

        if (!from || from.includes("status@") || from.includes("@newsletter")) return;

        const clientPhone = normalizePhone(from.split("@")[0]);
        
        const myJid = sock.user?.id || "";
        const myChannelNumber = normalizePhone(myJid.split(":")[0].split("@")[0]);
        const isFromMe = m.key.fromMe;
        const waName = m.pushName || "";

        const route = await getRoutingForPhone(clientPhone);
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;
        
        const contact = await findOrCreateGHLContact(locationId, clientPhone, waName, existingContactId);

        if (!contact?.id) return;

        await saveRouting(clientPhone, locationId, contact.id, myChannelNumber);

        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        if (!text) return;

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