const { pool } = require("../config/db");
const { normalizePhone, sleep } = require("../helpers/utils");
const { parseGHLCommand } = require("../helpers/parser");
const { getTenantConfig } = require("./tenantService");
const { initFunction } = require("buttons-warpper");
const { prepareWAMessageMedia } = require("@whiskeysockets/baileys");
const pino = require("pino");

// ✅ IMPORTANTE: Importamos el nuevo manejador de mensajes
const { handleIncomingMessage } = require("./messageHandler");

// Estado Global
const sessions = new Map();
const botMessageIds = new Map(); // Usamos Map para guardar ID -> Timestamp

// Constantes
const SUPPORT_LOC_ID = "__SYSTEM_SUPPORT__";
const SUPPORT_SLOT_ID = "1";

// Configuración de limpieza de memoria (Optimizada)
// Antes: 1 hora. Ahora: 5 minutos para mantener la memoria ligera.
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const MAX_INACTIVITY = 24 * 60 * 60 * 1000; // 24 horas de inactividad

let io; // Variable para guardar la instancia de Socket.io

// 👇 Función para recibir la instancia desde index.js
const setSocket = (socketIo) => {
    io = socketIo;
};

// --- GARBAGE COLLECTOR (Limpieza de RAM y IDs) ---
setInterval(() => {
    console.log("🧹 Ejecutando limpieza del sistema...");
    const now = Date.now();

    // 1. Limpiar sesiones inactivas
    sessions.forEach(async (session, sessionId) => {
        if (session.isConnected && session.lastActivity && (now - session.lastActivity > MAX_INACTIVITY)) {
            console.log(`💤 Hibernando sesión inactiva por >24h: ${sessionId}`);
            try {
                session.sock.end(undefined);
                session.isConnected = false;
                sessions.delete(sessionId);
            } catch (e) {
                console.error(`Error hibernando ${sessionId}:`, e);
            }
        }
    });

    // 2. Limpiar cache de IDs de mensajes (Evitar consumo infinito de RAM)
    const ID_TTL = 5 * 60 * 1000; // 5 minutos

    if (botMessageIds.size > 0) {
        for (const [id, timestamp] of botMessageIds.entries()) {
            if (now - timestamp > ID_TTL) {
                botMessageIds.delete(id);
            }
        }
    }

    // Seguridad extra: Si por algún ataque masivo supera 50k, limpiamos agresivamente
    if (botMessageIds.size > 50000) {
        console.warn("⚠️ Cache de IDs saturado, limpieza forzada.");
        botMessageIds.clear();
    }

}, CLEANUP_INTERVAL);


// --- HELPERS DE MENSAJERÍA ---

async function sendButtons(sock, jid, text, buttons) {
    let menu = `${text}\n\n`;
    buttons.forEach((btn, i) => {
        menu += `*${i + 1}.* ${btn.text}\n`;
    });
    menu += `\n_Responde con el número de tu opción._`;
    await sock.sendMessage(jid, { text: menu });
}

async function sendInteractiveMessage(sock, jid, parsedData) {
    const { title, body, image, buttons, footer } = parsedData;

    try {
        if (typeof sock.sendInteractiveMessage !== 'function') {
            throw new Error("Método sendInteractiveMessage no soportado/disponible");
        }

        const payload = {
            text: body,
            footer: "Clic&App",
            interactiveButtons: buttons
        };

        if (image) {
            try {
                const media = await prepareWAMessageMedia(
                    { image: { url: image } },
                    { upload: sock.waUploadToServer }
                );
                payload.header = {
                    hasMediaAttachment: true,
                    imageMessage: media.imageMessage
                };
            } catch (err) {
                console.warn("⚠️ Falló carga de imagen para botón, enviando sin imagen.");
                payload.header = { title: title || "Aviso", hasMediaAttachment: false };
            }
        } else if (title) {
            payload.header = { title: title, hasMediaAttachment: false };
        }

        const msg = await sock.sendInteractiveMessage(jid, payload);
        if (msg?.key?.id) botMessageIds.set(msg.key.id, Date.now());

        return msg;

    } catch (e) {
        console.warn(`⚠️ Fallo envío interactivo a ${jid}. Aplicando Fallback a Texto.`);

        let menuText = `*${title || "Opciones"}*\n\n${body}\n`;
        if (image) menuText += `_(Imagen adjunta omitida en modo texto)_\n`;

        buttons.forEach((btn, i) => {
            let label = "Opción";
            try {
                const params = JSON.parse(btn.buttonParamsJson);
                label = params.display_text || params.displayText || "Opción";
            } catch (err) { }
            menuText += `\n*${i + 1}.* ${label}`;
        });

        menuText += `\n\n_${footer || "Responde con el número de tu opción."}_`;

        const fallbackMsg = await sock.sendMessage(jid, { text: menuText });
        if (fallbackMsg?.key?.id) botMessageIds.set(fallbackMsg.key.id, Date.now());
        return fallbackMsg;
    }
}

// --- GESTIÓN DE SESIONES ---

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

async function deleteSessionData(locationId, slot, shouldDeleteSlot = false) {
    const sessionId = `${locationId}_slot${slot}`;
    const session = sessions.get(sessionId);

    if (session) {
        session.isDestroying = true;
        if (session.sock) {
            try {
                if (session.isConnected) {
                    console.log(`🚪 Cerrando sesión en WhatsApp para ${sessionId}...`);
                    await session.sock.logout();
                }
            } catch (e) {
                console.warn(`⚠️ Error logout WA: ${e.message}`);
            } finally {
                try {
                    session.sock.end(undefined);
                    if (session.sock.ws) session.sock.ws.close();
                } catch (ignore) { }
            }
        }
    }

    sessions.delete(sessionId);

    try {
        await pool.query("DELETE FROM baileys_auth WHERE session_id = $1", [sessionId]);
        console.log(`🗑️ Credenciales eliminadas: ${sessionId}`);
    } catch (e) { console.error("Error borrando auth DB:", e.message); }

    try {
        if (shouldDeleteSlot) {
            await pool.query("DELETE FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slot]);
        } else {
            await pool.query("UPDATE location_slots SET phone_number = NULL WHERE location_id = $1 AND slot_id = $2", [locationId, slot]);
        }
    } catch (e) { console.error("Error gestionando slot DB:", e.message); }
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

async function saveRouting(clientPhone, locationId, contactId, channelNumber, message = null) {
    if (locationId === SUPPORT_LOC_ID) return;
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

async function getLocationSlotsConfig(locationId, slotId = null) {
    if (slotId) {
        const sql = "SELECT * FROM location_slots WHERE location_id = $1 AND slot_id = $2";
        try { const res = await pool.query(sql, [locationId, slotId]); return res.rows; } catch (e) { return []; }
    }
    const sql = "SELECT * FROM location_slots WHERE location_id = $1 ORDER BY priority ASC";
    try { const res = await pool.query(sql, [locationId]); return res.rows; } catch (e) { return []; }
}

async function sendSupportAlert(message, targetPhoneOverride = null) {
    try {
        const targetPhone = targetPhoneOverride || process.env.SUPPORT_ALERT_RECIPIENT;
        if (!targetPhone) return;
        await sleep(8000);
        const sessionId = `${SUPPORT_LOC_ID}_slot${SUPPORT_SLOT_ID}`;
        const session = sessions.get(sessionId);
        if (session && session.isConnected && session.sock) {
            const jid = targetPhone.replace(/\D/g, "") + "@s.whatsapp.net";
            let realJid = jid;
            try {
                const [result] = await session.sock.onWhatsApp(jid);
                if (result?.exists) realJid = result.jid;
            } catch (err) { }
            await session.sock.sendMessage(realJid, { text: `🤖 *SISTEMA DE ALERTAS*\n\n${message}` });
        }
    } catch (e) { console.warn("Error alerta soporte:", e.message); }
}

// 🆕 Obtener listado de grupos donde participa el bot
async function getGroups(locationId, slotId) {
    const session = sessions.get(`${locationId}_slot${slotId}`);
    if (!session || !session.sock) throw new Error("Sesión no conectada");

    try {
        const groups = await session.sock.groupFetchAllParticipating();
        return Object.values(groups).map(g => ({
            id: g.id,
            subject: g.subject,
            participants: g.participants.length
        }));
    } catch (e) {
        console.error("Error fetching groups:", e);
        return [];
    }
}

async function syncGroupMembers(locationId, slotId, groupJid) {
    const session = sessions.get(`${locationId}_slot${slotId}`);
    if (!session || !session.sock) throw new Error("Sesión no conectada");

    const { findOrCreateGHLContact, addTagToContact } = require("./ghlService");

    try {
        const metadata = await session.sock.groupMetadata(groupJid);
        const groupName = metadata.subject;

        // Limpieza de mis propios IDs para evitar auto-agregarse
        const myRawId = session.sock.user?.id || "";
        const myLidRaw = session.sock.user?.lid || "";

        const myNumber = myRawId.split('@')[0].split(':')[0];
        const myLid = myLidRaw.split('@')[0].split(':')[0];

        console.log(`🤖 DEBUG: Mi Numero: ${myNumber} | Mi LID: ${myLid}`);
        console.log(`🔄 Sincronizando ${metadata.participants.length} miembros del grupo ${groupName}...`);

        let count = 0;
        for (const p of metadata.participants) {
            const idPart = p.id.split('@')[0].split(':')[0];
            const isLid = p.id.includes('@lid');

            // 1. FILTRO DE AUTO-AGREGADO (Evitar que el bot se agregue a sí mismo)
            if (idPart === myNumber || idPart === myLid) {
                console.log(`⏩ Saltando al propio Bot: ${idPart}`);
                continue;
            }

            // 2. INSPECCIÓN DE PARTICIPANTE (Aquí veremos si hay número real)
            console.log(`🔍 Inspeccionando ID: ${p.id}`);
            // Imprimimos TODO el objeto para ver si hay propiedades ocultas como 'jid' o 'attrs'
            console.log(`📦 DATA COMPLETA: ${JSON.stringify(p)}`);

            // 3. INTENTO DE RECUPERAR NÚMERO REAL
            // A veces el número viene en una propiedad separada si es un LID
            let realPhoneJid = null;

            if (!isLid) {
                // Si ya es un número normal, lo usamos
                realPhoneJid = p.id;
            } else {
                // SI ES LID: Buscamos en propiedades alternativas conocidas de Baileys
                // Nota: Dependiendo de la versión de Baileys, esto puede variar
                if (p.jid && p.jid.includes('@s.whatsapp.net')) realPhoneJid = p.jid;
                else if (p.attrs && p.attrs.jid) realPhoneJid = p.attrs.jid;
                else if (p.phoneNumber) realPhoneJid = p.phoneNumber; // A veces inyectado
            }

            if (!realPhoneJid) {
                console.warn(`⚠️ No se pudo obtener teléfono real para el LID: ${idPart} (Se omitirá para no ensuciar GHL)`);
                continue;
            }

            // Limpiar el JID final para obtener solo el número
            const finalNumber = realPhoneJid.split('@')[0].split(':')[0];
            console.log(`✅ Teléfono recuperado: ${finalNumber}`);

            // 4. CREAR EN GHL SOLO SI TENEMOS EL NÚMERO
            const contact = await findOrCreateGHLContact(
                locationId,
                finalNumber,
                "Miembro Grupo",
                null,
                false,
                true
            );

            if (contact?.id) {
                await addTagToContact(locationId, contact.id, `Miembro: ${groupName}`);
                count++;
            }
            await new Promise(r => setTimeout(r, 200));
        }
        return { synced: count, total: metadata.participants.length };

    } catch (e) {
        console.error("Error sync group members:", e);
        throw e;
    }
}

// --- FUNCIÓN PRINCIPAL DE CONEXIÓN ---

async function startWhatsApp(locationId, slotId) {
    const sessionId = `${locationId}_slot${slotId}`;
    const existing = sessions.get(sessionId);

    if (existing && existing.sock && existing.isConnected) {
        existing.lastActivity = Date.now();
        return existing;
    }

    const sessionData = {
        sock: null,
        qr: null,
        isConnected: false,
        myNumber: null,
        isDestroying: false,
        lastActivity: Date.now()
    };
    sessions.set(sessionId, sessionData);

    console.log(`▶ Iniciando: ${sessionId}`);

    const baileys = await import("@whiskeysockets/baileys");
    const { default: makeWASocket, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds, BufferJSON } = baileys;

    async function usePostgreSQLAuthState(pool, id) {
        const readData = async (key) => {
            try {
                const res = await pool.query("SELECT data FROM baileys_auth WHERE session_id = $1 AND key_id = $2", [id, key]);
                return res.rows.length > 0 ? JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver) : null;
            } catch (e) { return null; }
        };
        const writeData = async (key, data) => {
            try {
                if (sessionData.isDestroying) return;
                const jsonData = JSON.stringify(data, BufferJSON.replacer);
                const sql = `INSERT INTO baileys_auth (session_id, key_id, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW()) ON CONFLICT (session_id, key_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`;
                await pool.query(sql, [id, key, jsonData]);
            } catch (e) { }
        };
        const creds = (await readData("creds")) || initAuthCreds();
        return {
            state: {
                creds, keys: {
                    get: async (type, ids) => {
                        const data = {};
                        await Promise.all(ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (value) data[id] = value;
                        }));
                        return data;
                    },
                    set: async (data) => {
                        if (sessionData.isDestroying) return;
                        const tasks = [];
                        for (const cat in data) { for (const id in data[cat]) { const val = data[cat][id]; const key = `${cat}-${id}`; if (val) tasks.push(writeData(key, val)); } }
                        await Promise.all(tasks);
                    }
                }
            }, saveCreds: async () => await writeData("creds", creds)
        };
    }

    const { state, saveCreds } = await usePostgreSQLAuthState(pool, sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
        browser: locationId === SUPPORT_LOC_ID ? ["Soporte Admin", "Chrome", "10.0"] : [`ClicAndApp Slot ${slotId}`, "Chrome", "10.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        retryRequestDelayMs: 500
    });

    sessionData.sock = sock;
    initFunction(sock);

    sock.ev.on("creds.update", async (creds) => {
        if (!sessionData.isDestroying) {
            await saveCreds(creds);
            if (creds.me) {
                const myPhone = normalizePhone(creds.me.id.split(":")[0]);
                sessionData.myNumber = myPhone;
                syncSlotInfo(locationId, slotId, myPhone).catch(() => { });
            }
        }
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        sessionData.lastActivity = Date.now();

        // 👇 EMITIR QR AL FRONTEND
        if (qr && io) {
            io.emit("wa_event", {
                type: "qr",
                locationId,
                slotId,
                data: qr
            });
        }

        if (connection === "open") {
            sessionData.isConnected = true;
            sessionData.qr = null;
            const rawId = sock.user?.id;
            const myPhone = rawId ? normalizePhone(rawId.split(":")[0]) : "Desconocido";
            sessionData.myNumber = myPhone;
            console.log(`✅ CONECTADO: ${sessionId} (${myPhone})`);
            syncSlotInfo(locationId, slotId, myPhone).catch(console.error);

            // 👇 EMITIR CONEXIÓN EXITOSA
            if (io) {
                io.emit("wa_event", {
                    type: "connection",
                    status: "open",
                    locationId,
                    slotId,
                    myNumber: sessionData.myNumber
                });
            }
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            const isLogout = code === 401 || code === 403 || code === 440;
            const shouldReconnect = !isLogout && !sessionData.isDestroying;

            // 👇 EMITIR DESCONEXIÓN
            if (io) {
                io.emit("wa_event", {
                    type: "connection",
                    status: "close",
                    locationId,
                    slotId
                });
            }

            if (shouldReconnect) {
                console.log(`🔄 Reconectando ${sessionId}... (Código: ${code})`);
                setTimeout(() => startWhatsApp(locationId, slotId), 3000);
            } else {
                console.log(`🛑 Sesión cerrada definitivamente: ${sessionId}. Razón: ${isLogout ? 'Logout/Credenciales Inválidas (401/403)' : 'Destrucción Manual'}. Código: ${code}`);
                sessionData.isDestroying = true;
                sessionData.isConnected = false;
                sessionData.sock = null;
                sessions.delete(sessionId);

                if (isLogout) {
                    let clientPhone = sessionData.myNumber;
                    if (!clientPhone || clientPhone === "Desconocido") {
                        try {
                            const res = await pool.query("SELECT phone_number FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slotId]);
                            if (res.rows.length > 0) clientPhone = res.rows[0].phone_number;
                        } catch (e) { }
                    }
                    try {
                        await pool.query("UPDATE location_slots SET phone_number = NULL WHERE location_id = $1 AND slot_id = $2", [locationId, slotId]);
                        await pool.query("DELETE FROM baileys_auth WHERE session_id = $1", [sessionId]);
                    } catch (dbErr) { }

                    if (clientPhone && clientPhone !== "Desconocido") {
                        try {
                            const tenantConfig = await getTenantConfig(locationId);
                            const settings = tenantConfig.settings || {};
                            if (settings.send_disconnect_message !== false) {
                                const alertMsg = `⚠️ *DESCONEXIÓN DETECTADA*\n\nSu dispositivo del slot ${slotId} en la ubicación ${locationId} se ha desconectado. Por favor re-escanee el QR.`;
                                await sendSupportAlert(alertMsg, clientPhone);
                            }
                        } catch (e) { }
                    }
                }
            }
        }
    });

    sock.ev.on("messages.upsert", async (msg) => {
        sessionData.lastActivity = Date.now();

        // 🔥 FIX ANTIDUPLICADOS: Filtramos solo eventos 'notify'
        // Esto evita procesar historiales (append) que causan duplicados al conectar
        if (msg.type !== 'notify') return;

        await handleIncomingMessage(
            msg,
            sock,
            locationId,
            pool,
            botMessageIds,
            saveRouting,
            getRoutingForPhone
        );
    });

    return sessionData;
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
    sendInteractiveMessage,
    SUPPORT_LOC_ID,
    SUPPORT_SLOT_ID,
    getGroups,
    syncGroupMembers,
    setSocket
};