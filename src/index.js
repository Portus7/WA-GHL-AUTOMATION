const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const { initDb } = require("./db/init");
const { pool } = require("./config/db");
const { 
    startWhatsApp, 
    sessions, 
    botMessageIds, 
    deleteSessionData, 
    saveRouting, 
    getLocationSlotsConfig, 
    waitForSocketOpen,
    getRoutingForPhone 
} = require("./services/whatsappService");
const { saveTokens, getTokens, ensureAgencyToken, callGHLWithAgency } = require("./services/ghlService");
const { normalizePhone } = require("./helpers/utils");
const fs = require("fs");

if (!globalThis.crypto) { globalThis.crypto = require("crypto").webcrypto; }

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA = process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
const AGENCY_ROW_ID = "__AGENCY__";

// 🔥 URL PÚBLICA PARA MEDIOS (Define esto en tu .env)
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "https://wa.clicandapp.com";

const app = express();
app.use(express.json());

// 🔥 SERVIR ARCHIVOS ESTÁTICOS Y CREAR CARPETAS
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");
if (!fs.existsSync(MEDIA_DIR)) { fs.mkdirSync(MEDIA_DIR, { recursive: true }); }

app.use(express.static(PUBLIC_DIR)); // Esto permite acceder a /media/foto.jpg

// ... (Endpoints start-whatsapp, qr, status, config-slot, remove-slot, app-webhook siguen IGUAL) ...
// Pega aquí tus endpoints anteriores (start-whatsapp, qr, etc.) sin cambios.
// Para ahorrar espacio, asumo que los mantienes.

// --- WEBHOOK OUTBOUND CON IMÁGENES ---
app.post("/ghl/webhook", async (req, res) => {
  try {
    const { locationId, phone, message, type, attachments } = req.body; // 🔥 Aceptamos attachments
    if (!locationId || !phone || (!message && (!attachments || attachments.length === 0))) return res.json({ ignored: true });

    if (message && message.includes("[Enviado desde otro dispositivo]")) return res.json({ ignored: true });

    if (type === "Outbound" || type === "SMS") {
        const clientPhone = normalizePhone(phone);
        let dbConfigs = await getLocationSlotsConfig(locationId);
        
        let availableCandidates = dbConfigs.map(conf => ({
            slot: conf.slot_id,
            priority: conf.priority,
            tags: conf.tags || [],
            myNumber: conf.phone_number, 
            session: sessions.get(`${locationId}_slot${conf.slot_id}`)
        })).filter(c => c.session && c.session.isConnected);

        if (availableCandidates.length === 0) {
             // Fallback Memoria
             for (const [sid, s] of sessions.entries()) {
                if (sid.startsWith(`${locationId}_slot`) && s.isConnected) 
                    availableCandidates.push({ slot: parseInt(sid.split("_slot")[1]), priority: 99, myNumber: s.myNumber, session: s });
             }
             availableCandidates.sort((a,b) => a.slot - b.slot);
        }

        if (availableCandidates.length === 0) return res.status(200).json({ error: "No connected devices" });

        // Selección: Prioridad 1
        let selectedCandidate = availableCandidates[0];
        const sessionToUse = selectedCandidate.session;
        const jid = clientPhone.replace(/\D/g, '') + "@s.whatsapp.net";

        console.log(`🚀 Enviando con Slot ${selectedCandidate.slot} -> ${jid}`);

        try {
            await waitForSocketOpen(sessionToUse.sock);
            
            // 🔥 ENVÍO DE MEDIOS (Si GHL manda attachments)
            if (attachments && attachments.length > 0) {
                for (const url of attachments) {
                    // Baileys maneja URLs remotas automáticamente en 'image' o 'video'
                    // Detectar tipo simple por extensión o mandar como documento
                    let msgContent = { image: { url: url }, caption: message || "" };
                    if (url.endsWith(".mp4")) msgContent = { video: { url: url }, caption: message || "" };
                    else if (url.endsWith(".pdf")) msgContent = { document: { url: url }, mimetype: "application/pdf", fileName: "archivo.pdf" };
                    
                    const sent = await sessionToUse.sock.sendMessage(jid, msgContent);
                    if (sent?.key?.id) {
                        botMessageIds.add(sent.key.id);
                        setTimeout(() => botMessageIds.delete(sent.key.id), 15000);
                    }
                }
            } else {
                // Envío de Texto Normal
                const sent = await sessionToUse.sock.sendMessage(jid, { text: message });
                if (sent?.key?.id) {
                    botMessageIds.add(sent.key.id);
                    setTimeout(() => botMessageIds.delete(sent.key.id), 15000);
                }
            }

            console.log(`✅ Enviado.`);
            await saveRouting(clientPhone, locationId, null, selectedCandidate.myNumber);
            return res.json({ ok: true });
        } catch (e) { return res.status(500).json({ error: "Send failed" }); }
    }
    res.json({ ignored: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Error" }); }
});

// ... (Resto de endpoints config-slot, remove-slot, install, config, restoreSessions, init) ...

(async () => {
  try {
    await initDb();
    app.listen(PORT, async () => {
      console.log(`API OK ${PORT}`);
      await restoreSessions();
    });
  } catch (e) {
    console.error("Fatal:", e);
    process.exit(1);
  }
})();