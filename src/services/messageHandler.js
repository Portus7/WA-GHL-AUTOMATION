const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { normalizePhone } = require("../helpers/utils");
// ✅ Asegúrate de que assignContactOwner está importado aquí
const { findOrCreateGHLContact, logMessageToGHL, addTagToContact, assignContactOwner } = require("./ghlService");
const { transcribeAudio } = require("./openaiService");
const { getTenantConfig } = require("./tenantService");
const { pool } = require("../config/db"); // 👈 IMPORTANTE: Conexión DB directa
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "https://wa.clicandapp.com";

// --- Helpers Internos ---

// 🆕 Helper para obtener configuración específica del slot
async function getSlotSettings(locationId, phoneNumber) {
    try {
        const res = await pool.query(
            "SELECT settings, slot_id FROM location_slots WHERE location_id = $1 AND phone_number = $2",
            [locationId, phoneNumber]
        );
        if (res.rows.length > 0) return res.rows[0];
        return { settings: {}, slot_id: null };
    } catch (e) {
        return { settings: {}, slot_id: null };
    }
}

// ✅ processKeywordTags ahora filtra por slot_id
async function processKeywordTags(locationId, contactId, text, currentSlotId = null, isMobileContext = false) {
    if (locationId === "__SYSTEM_SUPPORT__") return;
    try {
        // Buscamos keywords globales (slot_id NULL) O específicas de este slot
        const sql = `
            SELECT keyword, tag FROM keyword_tags 
            WHERE location_id = $1 
            AND (slot_id IS NULL OR slot_id = $2)
        `;
        // Si currentSlotId es null, la query funcionará igual trayendo solo las globales
        const res = await pool.query(sql, [locationId, currentSlotId]);
        const tagRules = res.rows;

        if (tagRules.length === 0) return;

        const tagsToApply = new Set();
        const lowerText = text.toLowerCase();
        const deviceFooter = "[Enviado desde otro dispositivo]";

        for (const rule of tagRules) {
            const keyword = rule.keyword.toLowerCase();
            if (rule.keyword !== deviceFooter && lowerText.includes(keyword)) {
                tagsToApply.add(rule.tag);
            }
            if (isMobileContext && rule.keyword === deviceFooter) {
                tagsToApply.add(rule.tag);
            }
        }

        if (tagsToApply.size > 0) {
            await Promise.all(Array.from(tagsToApply).map(tag => addTagToContact(locationId, contactId, tag)));
        }
    } catch (e) {
        console.error("Error procesando tags:", e);
    }
}

async function downloadAndSaveMedia(message, type) {
    try {
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

        if (mimeType) ext = mime.extension(mimeType) || "bin";
        if (type === 'audioMessage' && !ext) ext = "ogg";

        const filename = `${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
        const filepath = path.join(MEDIA_DIR, filename);

        fs.writeFileSync(filepath, buffer);

        return {
            url: `${API_PUBLIC_URL}/media/${filename}`,
            filePath: filepath
        };
    } catch (e) {
        console.error("Error descargando media:", e);
        return null;
    }
}

// --- Lógica Principal ---

async function handleIncomingMessage(msg, sock, locationId, _poolArg, botMessageIds, saveRouting, getRoutingForPhone) {
    if (locationId === "__SYSTEM_SUPPORT__") return;
    const m = msg.messages[0];
    if (!m?.message) return;
    if (botMessageIds.has(m.key.id)) return;

    const from = m.key.remoteJid.includes("@s.whatsapp.net") ? m.key.remoteJid : m.key.remoteJidAlt;
    if (!from || from.includes("status@") || from.includes("@newsletter")) return;

    try {
        // 1. Validar Tenant Activo (Nivel Global)
        const tenantStatus = await getTenantConfig(locationId);
        if (!tenantStatus.active) {
            console.warn(`⛔ Tenant ${locationId} inactivo.`);
            return;
        }

        // 2. Identificar el Slot (Canal) para obtener SU configuración específica
        const myId = sock.user?.id;
        const myChannelNumber = myId ? normalizePhone(myId.split(":")[0]) : "";

        const slotData = await getSlotSettings(locationId, myChannelNumber);

        // Si el slot tiene settings personalizados, úsalos.
        const settings = slotData.settings || {};
        const currentSlotId = slotData.slot_id;

        const msgType = Object.keys(m.message)[0];
        let text = "";
        let attachments = [];
        let transcription = "";

        if (msgType === 'conversation') text = m.message.conversation;
        else if (msgType === 'extendedTextMessage') text = m.message.extendedTextMessage.text;
        else if (msgType === 'imageMessage') text = m.message.imageMessage.caption || "";
        else if (msgType === 'videoMessage') text = m.message.videoMessage.caption || "";
        else if (msgType === 'documentMessage') text = m.message.documentMessage.caption || "";

        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(msgType)) {
            const mediaData = await downloadAndSaveMedia(m, msgType);
            if (mediaData) {
                attachments.push(mediaData.url);
                if (!text) text = `[Archivo: ${msgType}]`;

                // Configuración de audio específica del slot
                if (msgType === 'audioMessage' && settings.transcribe_audio !== false) {
                    console.log(`🎙️ Transcribiendo audio para ${locationId} (Slot ${currentSlotId})...`);
                    const transcriptText = await transcribeAudio(mediaData.filePath);
                    if (transcriptText) transcription = transcriptText;
                }
            }
        }

        const contextInfo = m.message[msgType]?.contextInfo || m.message.extendedTextMessage?.contextInfo;
        if (contextInfo && contextInfo.quotedMessage) {
            let qText = "";
            const q = contextInfo.quotedMessage;
            if (q.conversation) qText = q.conversation;
            else if (q.extendedTextMessage) qText = q.extendedTextMessage.text;
            else qText = "[Archivo/Otro]";
            text = `> En respuesta a: "${qText.substring(0, 50)}..."\n\n${text}`;
        }

        if (!text && attachments.length === 0) return;

        const clientPhone = normalizePhone(from.split("@")[0]);
        const isFromMe = m.key.fromMe;
        const waName = m.pushName || "Usuario WhatsApp";

        console.log(`📩 PROCESANDO: ${clientPhone} (FromMe: ${isFromMe})`);

        const route = await getRoutingForPhone(clientPhone, locationId);
        const messageNumber = route?.messages ?? 1;
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;

        const contact = await findOrCreateGHLContact(locationId, clientPhone, waName, existingContactId, isFromMe, settings.create_unknown_contacts);

        if (!contact?.id) return;

        // --- 🆕 LÓGICA: ASIGNACIÓN DE TAGS Y RESPONSABLES (SOLO INBOUND) ---
        if (!isFromMe) {
            // A. Agregar Tag Específico del Número (si existe en la config del slot)
            if (settings.ghl_contact_tag) {
                await addTagToContact(locationId, contact.id, settings.ghl_contact_tag);
            }

            // B. Asignar Usuario Responsable (si existe en la config del slot)
            if (settings.ghl_assigned_user) {
                await assignContactOwner(locationId, contact.id, settings.ghl_assigned_user);
            }
        }
        // -------------------------------------------------------------------

        await saveRouting(clientPhone, locationId, contact.id, myChannelNumber, messageNumber);

        let messageForGHL = "";
        let direction = "inbound";

        if (isFromMe) {
            const deviceFooter = "[Enviado desde otro dispositivo]";
            messageForGHL = `${text}\n\n${deviceFooter}`;

            // Configuración de Source Label específica del slot
            if (settings.show_source_label !== false) {
                let sourceLabel = `+${myChannelNumber}`;
                try {
                    const slotRes = await pool.query("SELECT slot_name FROM location_slots WHERE location_id=$1 AND phone_number=$2", [locationId, myChannelNumber]);
                    if (slotRes.rows.length > 0 && slotRes.rows[0].slot_name) sourceLabel = slotRes.rows[0].slot_name;
                } catch (err) { }
                messageForGHL += `\nSource: ${sourceLabel}`;
            }

            direction = "outbound";
            // Pasamos currentSlotId para filtrar keywords
            await processKeywordTags(locationId, contact.id, text, currentSlotId, true);
        } else {
            messageForGHL = text;

            // Configuración de Source Label específica del slot (opcional en inbound)
            if (settings.show_source_label !== false) {
                let sourceLabel = `+${myChannelNumber}`;
                try {
                    const slotRes = await pool.query("SELECT slot_name FROM location_slots WHERE location_id=$1 AND phone_number=$2", [locationId, myChannelNumber]);
                    if (slotRes.rows.length > 0 && slotRes.rows[0].slot_name) sourceLabel = slotRes.rows[0].slot_name;
                } catch (err) { }
                messageForGHL += `\nSource: ${sourceLabel}`;
            }

            direction = "inbound";
        }

        await logMessageToGHL(locationId, contact.id, messageForGHL, direction, attachments);

        if (transcription) {
            let transcriptionMsg = `🎤 [Transcripción]:\n"${transcription}"\n\nSource: +${myChannelNumber}`;
            if (isFromMe) transcriptionMsg += "\n\n[Enviado desde otro dispositivo]";
            await logMessageToGHL(locationId, contact.id, transcriptionMsg, direction, []);
        }

    } catch (error) {
        console.error("Handler Error:", error.message);
    }
}

// ✅ Exportamos AMBAS funciones
module.exports = { handleIncomingMessage, processKeywordTags };