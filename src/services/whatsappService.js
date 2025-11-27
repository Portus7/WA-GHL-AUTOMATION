const { pool } = require("../config/db");
const { normalizePhone } = require("../helpers/utils");
const { findOrCreateGHLContact, logMessageToGHL, addTagToContact } = require("./ghlService");
const { parseGHLCommand } = require("../helpers/parser");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types"); 

// Estado Global
const sessions = new Map();
const botMessageIds = new Set();

// Configuración de Directorios para Medios
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "https://wa.clicandapp.com";

if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// --- DB HELPERS LOCALES ---

async function sendButtons(sock, jid, text, buttons) {
    let menu = `${text}\n\n`;
    // Construimos la lista: 1. Opción A, 2. Opción B...
    buttons.forEach((btn, i) => {
        menu += `*${i + 1}.* ${btn.text}\n`;
    });
    menu += `\n_Responde con el número de tu opción._`;

    await sock.sendMessage(jid, { text: menu });
}


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

async function saveRouting(clientPhone, locationId, contactId, channelNumber, message=null) {
  const normClient = normalizePhone(clientPhone);
  const normChannel = normalizePhone(channelNumber);
  const sql = `INSERT INTO phone_routing (phone, location_id, contact_id, channel_number, updated_at, messages_count) VALUES ($1, $2, $3, $4, NOW(), $5) ON CONFLICT (phone) DO UPDATE SET location_id = EXCLUDED.location_id, contact_id = COALESCE(EXCLUDED.contact_id, phone_routing.contact_id), channel_number = EXCLUDED.channel_number, updated_at = NOW(), messages_count = phone_routing.messages_count + 1;`;
  try { await pool.query(sql, [normClient, locationId, contactId, normChannel, message ? message : 1]); } catch (e) { console.error("Routing Error:", e.message); }
}

async function getRoutingForPhone(clientPhone, locationId) {
  const normClient = normalizePhone(clientPhone);
  try {
    const res = await pool.query("SELECT location_id, contact_id, channel_number, messages_count FROM phone_routing WHERE phone = $1 AND location_id = $2", [normClient, locationId]);
    if (res.rows.length > 0) return { locationId: res.rows[0].location_id, contactId: res.rows[0].contact_id, channelNumber: res.rows[0].channel_number, messages: res.rows[0].messages_count };
    return null;
  } catch (e) { return null; }
}

async function getLocationSlotsConfig(locationId, slotId=null) {
    if (slotId) {
        const sql = "SELECT * FROM location_slots WHERE location_id = $1 AND slot_id = $2";
        try { const res = await pool.query(sql, [locationId, slotId]); return res.rows; } catch (e) { console.error("Error fetching slot config:", e); return []; }
    }
    const sql = "SELECT * FROM location_slots WHERE location_id = $1 ORDER BY priority ASC";
    try { const res = await pool.query(sql, [locationId]); return res.rows; } catch (e) { console.error("Error fetching location slots config:", e); return []; }
}

async function sendInteractiveMessage(sock, jid, parsedData) {
    const { title, body, image, buttons } = parsedData;

    let header = { title: title, subtitle: "", hasMediaAttachment: false };

    // Si hay imagen, cambiamos el header
    if (image) {
        header = {
            hasMediaAttachment: true,
            imageMessage: { url: image } // Baileys descarga la URL por ti
        };
    }

    const msgPayload = {
        viewOnceMessage: {
            message: {
                interactiveMessage: {
                    body: { text: body },
                    footer: { text: "Clic&App" }, // Puedes personalizar esto
                    header: header,
                    nativeFlowMessage: {
                        buttons: buttons,
                        messageParamsJson: ""
                    }
                }
            }
        }
    };

    await sock.sendMessage(jid, msgPayload);
}

// 🔥 HELPER: Descargar y Guardar Media
async function downloadAndSaveMedia(message, type) {
    try {
        const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: (msg) => new Promise((resolve) => resolve(msg)) }
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
        return `${API_PUBLIC_URL}/media/${filename}`;
    } catch (e) {
        console.error("Error descargando media:", e);
        return null;
    }
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

  sock.ev.on("messages.upsert", async (msg) => {
    try {
        const m = msg.messages[0];
        if (!m?.message) return;
        if (botMessageIds.has(m.key.id)) return; 

        const from = m.key.remoteJid.includes("@s.whatsapp.net") ? m.key.remoteJid : m.key.remoteJidAlt;

        // Filtros básicos para no procesar basura
        if (!from || from.includes("status@") || from.includes("@newsletter")) return;

        // 1. DETECCIÓN DE TIPO DE MENSAJE (Texto vs Media)
        const msgType = Object.keys(m.message)[0];
        let text = "";
        let attachments = [];

        // Extraer Texto
        if (msgType === 'conversation') text = m.message.conversation;
        else if (msgType === 'extendedTextMessage') text = m.message.extendedTextMessage.text;
        else if (msgType === 'imageMessage') text = m.message.imageMessage.caption || "";
        else if (msgType === 'videoMessage') text = m.message.videoMessage.caption || "";
        else if (msgType === 'documentMessage') text = m.message.documentMessage.caption || "";

        // Extraer Media (Descargar)
        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(msgType)) {
            const url = await downloadAndSaveMedia(m, msgType);
            if(url) attachments.push(url);
            if(!text) text = `[Archivo: ${msgType}]`;
        }

        // 2. DETECCIÓN DE RESPUESTA (Quoted) - Opcional, mejora la visualización
        const contextInfo = m.message[msgType]?.contextInfo || m.message.extendedTextMessage?.contextInfo;
        if (contextInfo && contextInfo.quotedMessage) {
             let qText = "";
             const q = contextInfo.quotedMessage;
             if (q.conversation) qText = q.conversation;
             else if (q.extendedTextMessage) qText = q.extendedTextMessage.text;
             else if (q.imageMessage) qText = "[Imagen]";
             else qText = "[Archivo]";
             
             if (qText) text = `> En respuesta a: "${qText.substring(0, 50)}..."\n\n${text}`;
        }

        // Si no hay nada útil, salir
        if (!text && attachments.length === 0) return;

        const clientPhone = normalizePhone(from.split("@")[0]);
        const myId = sock.user?.id;
        const myChannelNumber = myId ? normalizePhone(myId.split(":")[0]) : "";
        const isFromMe = m.key.fromMe;
        const waName = m.pushName || "Usuario WhatsApp";
        let promo = false
        console.log(`📩 PROCESANDO: ${clientPhone} (FromMe: ${isFromMe})`);

        const route = await getRoutingForPhone(clientPhone, locationId);
        const messageNumber = route?.messages ?? 1;
        console.log("Nro de mensajes: ",messageNumber, "ROUTE: ", route)
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;
        const contact = await findOrCreateGHLContact(locationId, clientPhone, waName, existingContactId, isFromMe);

        if (!contact?.id) return;

        const slotInfo = getLocationSlotsConfig(locationId, slotId);
        await saveRouting(clientPhone, locationId, contact.id, myChannelNumber, messageNumber);
        

        let messageForGHL = "";
        let direction = "inbound";

        if (isFromMe) {
            messageForGHL = `${text}\n\n[Enviado desde otro dispositivo]\nSource: +${myChannelNumber}`;
            direction = "outbound"; 
            await addTagToContact(locationId, contact.id, "another device");
        } else {
            if (messageNumber === 1) {
                promo = true;
            }
            messageForGHL = `${text}\n\nSource: +${myChannelNumber}`;
            direction = "inbound"; 
        }

        // 🔥 Enviar con attachments
        await logMessageToGHL(locationId, contact.id, messageForGHL, direction, attachments);
        if (promo) {
            const isSelectingOption = ["1", "2", "3"].includes(text.trim());
            console.log(`🤖 Enviando Botones PROMO a +${clientPhone}`);
            const buttons = [
                { id: 'promo_yes', text: 'Ver Ofertas' },
                { id: 'promo_no', text: 'No me interesa' },
                { id: 'agent', text: 'Hablar con Humano' }
            ];
            await sendButtons(sock, from, `¡Hola ${waName}! Vimos que te interesan nuestras promos.`, buttons);
        }
            
    } catch (error) { console.error("Upsert Error:", error.message); }
  });
}

async function sendInteractiveMessage(sock, jid, parsedData) {
    const { title, body, image, buttons } = parsedData;

    let header = { title: title, subtitle: "", hasMediaAttachment: false };
    
    if (image) {
        header = {
            hasMediaAttachment: true,
            imageMessage: { url: image }
        };
    }

    const msgPayload = {
        viewOnceMessage: {
            message: {
                interactiveMessage: {
                    body: { text: body },
                    footer: { text: "Clic&App" }, 
                    header: header,
                    nativeFlowMessage: {
                        buttons: buttons,
                        messageParamsJson: ""
                    }
                }
            }
        }
    };

    await sock.sendMessage(jid, msgPayload);
}

module.exports = {
    sessions,
    botMessageIds,
    startWhatsApp,
    deleteSessionData,
    saveRouting,
    getRoutingForPhone,
    getLocationSlotsConfig,
    waitForSocketOpen,
    sendButtons,
    parseGHLCommand, 
    sendInteractiveMessage
};