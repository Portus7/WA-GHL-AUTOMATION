const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { normalizePhone } = require("../helpers/utils");
const { findOrCreateGHLContact, logMessageToGHL, addTagToContact, assignContactOwner } = require("./ghlService");
const { transcribeAudio } = require("./openaiService");
const { getTenantConfig } = require("./tenantService");
const { pool } = require("../config/db");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "https://wa.clicandapp.com";

// --- Helpers Internos ---

function getCleanJid(jid) {
    if (!jid) return "";
    let clean = jid;
    if (clean.includes('@')) clean = clean.split('@')[0];
    if (clean.includes(':')) clean = clean.split(':')[0];
    return clean;
}

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

async function processKeywordTags(locationId, contactId, text, currentSlotId = null, isMobileContext = false) {
    if (locationId === "__SYSTEM_SUPPORT__") return;
    try {
        const sql = `
            SELECT keyword, tag FROM keyword_tags 
            WHERE location_id = $1 
            AND (slot_id IS NULL OR slot_id = $2)
        `;
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

    // Deduplicación rápida
    if (botMessageIds.has(m.key.id)) return;
    botMessageIds.add(m.key.id);

    let remoteJid = m.key.remoteJid;

    // Filtros
    if (!remoteJid) return;
    if (remoteJid.includes("status@") || remoteJid.includes("@newsletter")) return;
    if (remoteJid.includes("@lid")) return;

    try {
        const tenantStatus = await getTenantConfig(locationId);
        if (!tenantStatus.active) return;

        const myIdRaw = sock.user?.id;
        const myChannelNumber = myIdRaw ? getCleanJid(myIdRaw) : "";

        const slotData = await getSlotSettings(locationId, myChannelNumber);
        const settings = slotData.settings || {};
        const currentSlotId = slotData.slot_id;

        const isGroup = remoteJid.endsWith('@g.us');
        let clientIdentifier = "";
        let clientName = "";

        if (isGroup) {
            const groupConfig = settings.groups?.[remoteJid];
            if (!groupConfig || !groupConfig.active) return;

            clientIdentifier = remoteJid.replace(/\D/g, "");
            clientName = groupConfig.name || "Grupo WhatsApp";
            console.log(`👥 Mensaje de Grupo Activo: ${clientName}`);
        } else {
            clientIdentifier = getCleanJid(remoteJid);
            clientName = m.pushName || "Usuario WhatsApp";
        }

        if (!clientIdentifier || clientIdentifier.length < 5) return;

        const msgType = Object.keys(m.message)[0];
        let text = "";
        let attachments = [];
        let transcription = "";

        if (msgType === 'conversation') text = m.message.conversation;
        else if (msgType === 'extendedTextMessage') text = m.message.extendedTextMessage.text;
        else if (msgType === 'imageMessage') text = m.message.imageMessage.caption || "";
        else if (msgType === 'videoMessage') text = m.message.videoMessage.caption || "";
        else if (msgType === 'documentMessage') text = m.message.documentMessage.caption || "";
        else if (msgType === 'senderKeyDistributionMessage') return;

        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(msgType)) {
            const mediaData = await downloadAndSaveMedia(m, msgType);
            if (mediaData) {
                attachments.push(mediaData.url);
                if (!text) text = `[Archivo: ${msgType}]`;

                if (msgType === 'audioMessage' && settings.transcribe_audio !== false) {
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

        if (isGroup && !m.key.fromMe) {
            const participant = m.key.participant || m.participant;
            const participantPhone = participant ? getCleanJid(participant) : "Anon";
            text = `[${participantPhone}]: ${text}`;
        }

        if (!text && attachments.length === 0) return;

        console.log(`📩 PROCESANDO: ${clientIdentifier} (${isGroup ? 'Grupo' : 'Directo'}) -> Slot: ${myChannelNumber}`);

        const route = await getRoutingForPhone(clientIdentifier, locationId);
        const messageNumber = route?.messages ?? 1;
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;

        const contact = await findOrCreateGHLContact(locationId, clientIdentifier, clientName, existingContactId, m.key.fromMe, settings.create_unknown_contacts);

        if (!contact?.id) return;

        // 🔥 OPTIMIZACIÓN: EVITAR LLAMADAS REDUNDANTES A LA API
        if (!m.key.fromMe) {

            // A. Tags (Si el contacto NO tiene el tag ya, lo agregamos)
            if (!isGroup && settings.ghl_contact_tag) {
                // contact.tags suele ser un array de strings ["tag1", "tag2"]
                const currentTags = contact.tags || [];
                const targetTag = settings.ghl_contact_tag;

                // Solo si NO incluye el tag, llamamos a la API
                if (!currentTags.includes(targetTag)) {
                    await addTagToContact(locationId, contact.id, targetTag);
                }
            }

            // B. Responsable (Si el contacto NO está asignado a ese usuario, lo asignamos)
            if (settings.ghl_assigned_user) {
                // contact.assignedTo es el ID del usuario
                if (contact.assignedTo !== settings.ghl_assigned_user) {
                    await assignContactOwner(locationId, contact.id, settings.ghl_assigned_user);
                }
            }
        }

        await saveRouting(clientIdentifier, locationId, contact.id, myChannelNumber, messageNumber);

        let messageForGHL = "";
        let direction = "inbound";
        const isFromMe = m.key.fromMe;

        if (isFromMe) {
            const deviceFooter = "[Enviado desde otro dispositivo]";
            messageForGHL = `${text}\n\n${deviceFooter}`;

            if (settings.show_source_label !== false) {
                let sourceLabel = `+${myChannelNumber}`;
                try {
                    const slotRes = await pool.query("SELECT slot_name FROM location_slots WHERE location_id=$1 AND phone_number=$2", [locationId, myChannelNumber]);
                    if (slotRes.rows.length > 0 && slotRes.rows[0].slot_name) sourceLabel = slotRes.rows[0].slot_name;
                } catch (err) { }
                messageForGHL += `\nSource: ${sourceLabel}`;
            }

            direction = "outbound";
            if (!isGroup) await processKeywordTags(locationId, contact.id, text, currentSlotId, true);
        } else {
            messageForGHL = text;
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

            if (isGroup && !isFromMe) {
                let participant = m.key.participant || m.participant;
                participant = participant ? getCleanJid(participant) : "Anon";
                transcriptionMsg = `[${participant}]: ${transcriptionMsg}`;
            }

            await logMessageToGHL(locationId, contact.id, transcriptionMsg, direction, []);
        }

    } catch (error) {
        console.error("Handler Error:", error.message);
    }
}

module.exports = { handleIncomingMessage, processKeywordTags };