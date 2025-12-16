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

        const lowerText = text.toLowerCase();
        const deviceFooter = "[Enviado desde otro dispositivo]";

        for (const rule of tagRules) {
            const keyword = rule.keyword.toLowerCase();
            const tag = rule.tag;

            let match = false;
            // Coincidencia normal o mensaje desde móvil
            if (rule.keyword !== deviceFooter && lowerText.includes(keyword)) match = true;
            if (isMobileContext && rule.keyword === deviceFooter) match = true;

            if (match) {
                // 🔥 LÓGICA ESPECIAL PARA PRIORIDAD
                if (tag.startsWith("[PRIOR]:")) {
                    // Extraemos el valor limpio. Ej: "[PRIOR]: finanzas" -> "finanzas"
                    const cleanValue = tag.replace("[PRIOR]:", "").trim();
                    const { setPriorTag } = require("./ghlService");

                    // Usamos la función que borra los anteriores
                    await setPriorTag(locationId, contactId, cleanValue);
                } else {
                    // Tag normal (acumulativo)
                    const { addTagToContact } = require("./ghlService");
                    await addTagToContact(locationId, contactId, tag);
                }
            }
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

    // 🔥 CORRECCIÓN CRÍTICA DE JID 🔥
    // Aceptamos @s.whatsapp.net (usuarios) Y @g.us (grupos).
    // Solo si NO es ninguno de esos, intentamos buscar el alternativo (para los casos raros de LIDs).
    let remoteJid = m.key.remoteJid;
    if (remoteJid && !remoteJid.includes("@s.whatsapp.net") && !remoteJid.includes("@g.us")) {
        if (m.key.remoteJidAlt) {
            remoteJid = m.key.remoteJidAlt;
        }
    }

    if (remoteJid && remoteJid.includes("@lid")) {
        console.log(`Ignorando evento LID para evitar duplicados: ${remoteJid}`);
        return;
    }

    // Filtros básicos
    if (!remoteJid || remoteJid.includes("status@") || remoteJid.includes("@newsletter")) return;

    // Limpieza extra: Si por alguna razón sigue llegando con :2 al final (ej: 123@g.us:2), lo limpiamos
    if (remoteJid.includes(':')) {
        remoteJid = remoteJid.split(':')[0];
    }

    // LOG DE DEBUG PARA VERIFICAR
    // console.log(`📩 Procesando mensaje de: ${remoteJid}`);

    try {
        const tenantStatus = await getTenantConfig(locationId);
        if (!tenantStatus.active) {
            console.warn(`⛔ Tenant ${locationId} inactivo.`);
            return;
        }

        const myId = sock.user?.id;
        const myChannelNumber = myId ? normalizePhone(myId.split(":")[0]) : "";

        const slotData = await getSlotSettings(locationId, myChannelNumber);
        const settings = slotData.settings || {};
        const currentSlotId = slotData.slot_id;

        // Detectar si es Grupo
        const isGroup = remoteJid.endsWith('@g.us');
        let clientIdentifier = "";
        let clientName = "";

        if (isGroup) {
            // Buscamos la configuración del grupo
            const groupConfig = settings.groups?.[remoteJid];

            // Si no está activo explícitamente en el panel, ignorar mensaje
            if (!groupConfig || !groupConfig.active) {
                console.log(`Ignorando grupo no activo: ${remoteJid}`);
                return;
            }

            // Para GHL, usamos solo los números del ID del grupo
            clientIdentifier = remoteJid.replace(/\D/g, "");

            // ✅ AGREGAR SUFIJO [GRUPO] PARA IDENTIFICACIÓN EN GHL
            const rawName = groupConfig.name || "Grupo WhatsApp";
            clientName = rawName.includes("[GRUPO]") ? rawName : `${rawName} [GRUPO]`;

            console.log(`👥 Mensaje de Grupo Activo: ${clientName} (${clientIdentifier})`);
        } else {
            // Chat Individual
            clientIdentifier = normalizePhone(remoteJid.split("@")[0]);

            // ✅ PROTECCIÓN DE NOMBRE AL ESCRIBIR DESDE CELULAR
            if (m.key.fromMe) {
                clientName = "Usuario WhatsApp";
            } else {
                clientName = m.pushName || "Usuario WhatsApp";
            }
        }

        // Extracción de Contenido
        const msgType = Object.keys(m.message)[0];
        let text = "";
        let attachments = [];
        let transcription = "";

        if (msgType === 'conversation') text = m.message.conversation;
        else if (msgType === 'extendedTextMessage') text = m.message.extendedTextMessage.text;
        else if (msgType === 'imageMessage') text = m.message.imageMessage.caption || "";
        else if (msgType === 'videoMessage') text = m.message.videoMessage.caption || "";
        else if (msgType === 'documentMessage') text = m.message.documentMessage.caption || "";

        // 🔥 NUEVO: Soporte para respuestas de Botones y Listas
        else if (msgType === 'interactiveResponseMessage') {
            const ir = m.message.interactiveResponseMessage;
            // Intentar sacar el texto visible del botón, si no, el nombre interno
            text = ir.body?.text || ir.nativeFlowResponseMessage?.selectedDisplayName || "[Respuesta Interactiva]";
        }
        else if (msgType === 'templateButtonReplyMessage') {
            text = m.message.templateButtonReplyMessage.selectedDisplayText;
        }
        else if (msgType === 'buttonsResponseMessage') {
            text = m.message.buttonsResponseMessage.selectedDisplayText;
        }
        else if (msgType === 'listResponseMessage') {
            text = m.message.listResponseMessage.title;
        }

        // Ignorar mensajes de sistema (ej: cambios de claves)
        if (msgType === 'senderKeyDistributionMessage' || msgType === 'protocolMessage') return;

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

            // 🔥 NUEVO: Soporte para leer el texto del menú original
            else if (q.interactiveMessage) {
                const im = q.interactiveMessage;
                // Preferimos el cuerpo (la pregunta), si no el título
                qText = im.body?.text || im.header?.title || "[Menú]";
            }

            else qText = "[Archivo/Otro]";

            // console.log(JSON.stringify(contextInfo, null, 2)); // Debug opcional
            text = `> En respuesta a: "${qText.substring(0, 50)}..."\n\n${text}`;
        }

        // ✅ MEJORA: PREFIJO EN GRUPOS CON NOMBRE REAL
        if (isGroup && !m.key.fromMe) {
            // Intentamos obtener el nombre real (pushName)
            let participantNum = m.key.participant || m.participant || "";
            participantNum = participantNum.split('@')[0].split(':')[0];

            // Priorizamos el nombre. Si no existe, usamos el número.
            const displayName = m.pushName ? m.pushName : participantNum;

            text = `[${displayName}]: ${text}`;
        }

        if (!text && attachments.length === 0) return;

        // Routing y GHL
        const route = await getRoutingForPhone(clientIdentifier, locationId);
        const messageNumber = route?.messages ?? 1;
        const existingContactId = (route?.locationId === locationId) ? route.contactId : null;

        const contact = await findOrCreateGHLContact(locationId, clientIdentifier, clientName, existingContactId, m.key.fromMe, settings.create_unknown_contacts);

        if (!contact?.id) return;

        // Acciones CRM (Solo Inbound)
        if (!m.key.fromMe) {
            if (!isGroup && settings.ghl_contact_tag) {
                await addTagToContact(locationId, contact.id, settings.ghl_contact_tag);
            }
            if (settings.ghl_assigned_user) {
                await assignContactOwner(locationId, contact.id, settings.ghl_assigned_user);
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

            // 🔥 BLOQUE CORREGIDO: Asignación de Tags para mensajes desde el celular
            if (!isGroup) {
                console.log(`📱 Detectado mensaje desde celular para contacto ${contact.id}. Aplicando tags...`);

                // 1. Tag Fijo "another-device"
                try {
                    await addTagToContact(locationId, contact.id, "another device");
                    console.log("✅ Tag 'another-device' asignado.");
                } catch (e) {
                    console.error("❌ Error asignando tag another-device:", e.message);
                }

                // 2. Procesar Keywords (si hay reglas configuradas)
                try {
                    await processKeywordTags(locationId, contact.id, text, currentSlotId, true);
                } catch (e) {
                    console.error("❌ Error procesando keywords:", e.message);
                }
            } else {
                console.log("⏩ Mensaje desde celular en GRUPO, omitiendo tags.");
            }

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
                // Para la transcripción también intentamos usar el nombre
                let participantNum = m.key.participant || m.participant || "";
                participantNum = participantNum.split('@')[0].split(':')[0];
                const displayName = m.pushName ? m.pushName : participantNum;

                transcriptionMsg = `[${displayName}]: ${transcriptionMsg}`;
            }

            await logMessageToGHL(locationId, contact.id, transcriptionMsg, direction, []);
        }

    } catch (error) {
        console.error("Handler Error:", error.message);
    }
}

module.exports = { handleIncomingMessage, processKeywordTags };