const path = require("path");
const fs = require("fs");
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
    getRoutingForPhone, 
    getLocationSlotsConfig, 
    waitForSocketOpen 
} = require("./services/whatsappService");
const { saveTokens, getTokens, ensureAgencyToken, callGHLWithAgency } = require("./services/ghlService");
const { normalizePhone } = require("./helpers/utils");

// Parche crypto
if (!globalThis.crypto) { globalThis.crypto = require("crypto").webcrypto; }

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA = process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
const AGENCY_ROW_ID = "__AGENCY__";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");

if (!fs.existsSync(MEDIA_DIR)) { 
    fs.mkdirSync(MEDIA_DIR, { recursive: true }); 
}


const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.static(PUBLIC_DIR));

// --- RUTAS ---

app.post("/start-whatsapp", async (req, res) => {
  const { locationId, slot } = req.query;
  try { await startWhatsApp(locationId, slot); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ error: "Error" }); }
});

app.get("/qr", (req, res) => {
  const { locationId, slot } = req.query;
  const sess = sessions.get(`${locationId}_slot${slot}`);
  if (!sess || !sess.qr) return res.status(404).json({ error: "No QR" });
  res.json({ qr: sess.qr });
});

app.get("/status", async (req, res) => {
  const { locationId, slot } = req.query;
  const sess = sessions.get(`${locationId}_slot${slot}`);
  let extra = {};
  try { 
      const r = await pool.query("SELECT priority, tags FROM location_slots WHERE location_id=$1 AND slot_id=$2", [locationId, slot]);
      if (r.rows.length) extra = r.rows[0];
  } catch(e){}
  if (sess && sess.isConnected) return res.json({ connected: true, myNumber: sess.myNumber, priority: extra.priority||99, tags: extra.tags||[] });
  res.json({ connected: false, priority: extra.priority, tags: extra.tags });
});

// --- WEBHOOK OUTBOUND CON LÓGICA DE PRIORIDAD REAL ---
app.post("/ghl/webhook", async (req, res) => {
  try {
    const { locationId, phone, message, type } = req.body;
    if (!locationId || !phone || !message) return res.json({ ignored: true });
    if (message.includes("[Enviado desde otro dispositivo]")) return res.json({ ignored: true });

    if (type === "Outbound" || type === "SMS") {
        const clientPhone = normalizePhone(phone);
        
        // 1. Obtener configuración ordenada por prioridad (1, 2, 3...)
        let dbConfigs = await getLocationSlotsConfig(locationId);
        
        // 2. Mapear a sesiones activas en memoria
        let availableCandidates = dbConfigs.map(conf => ({
            slot: conf.slot_id,
            priority: conf.priority,
            tags: conf.tags || [],
            myNumber: conf.phone_number, 
            session: sessions.get(`${locationId}_slot${conf.slot_id}`)
        })).filter(c => c.session && c.session.isConnected);

        // Fallback Memoria (Si DB falla, ordenamos por slot como emergencia)
        if (availableCandidates.length === 0) {
             for (const [sid, s] of sessions.entries()) {
                if (sid.startsWith(`${locationId}_slot`) && s.isConnected) 
                    availableCandidates.push({ slot: parseInt(sid.split("_slot")[1]), priority: 99, myNumber: s.myNumber, session: s });
             }
             // Ordenar por slot si no hay prioridad definida
             availableCandidates.sort((a,b) => a.slot - b.slot);
        }

        if (availableCandidates.length === 0) return res.status(200).json({ error: "No connected devices" });

        // 3. SELECCIÓN DEL CANDIDATO
        let selectedCandidate = null;
        let selectionReason = "";

        // A) Routing Histórico (Sticky Session)
        // Intentamos mantener la conversación en el mismo número
        const route = await getRoutingForPhone(clientPhone);
        if (route?.channelNumber) {
             const sticky = availableCandidates.find(c => c.myNumber === route.channelNumber);
             if (sticky) {
                 selectedCandidate = sticky;
                 selectionReason = "Historial";
             }
        }

        // B) Prioridad (Si es nuevo o el histórico falló)
        if (!selectedCandidate) {
            // Como dbConfigs ya venía ordenado por prioridad ASC, 
            // y availableCandidates mantiene ese orden relativo,
            // el índice 0 es el de mejor prioridad disponible.
            
            // Refuerzo: Ordenamos explícitamente por prioridad
            availableCandidates.sort((a, b) => a.priority - b.priority);
            
            selectedCandidate = availableCandidates[0];
            selectionReason = `Prioridad ${selectedCandidate.priority}`;
        }

        const sessionToUse = selectedCandidate.session;
        const jid = clientPhone.replace(/\D/g, '') + "@s.whatsapp.net";

        console.log(`🚀 Enviando con Slot ${selectedCandidate.slot} (${selectionReason}) -> ${jid}`);

        try {
            await waitForSocketOpen(sessionToUse.sock);
            const sent = await sessionToUse.sock.sendMessage(jid, { text: message });
            
            if (sent?.key?.id) {
                botMessageIds.add(sent.key.id);
                setTimeout(() => botMessageIds.delete(sent.key.id), 15000);
            }

            console.log(`✅ Enviado.`);
            await saveRouting(clientPhone, locationId, null, selectedCandidate.myNumber);
            return res.json({ ok: true });

        } catch (e) {
            // FALLBACK AUTOMÁTICO (Si falla el prioritario, intenta el siguiente)
            console.warn(`⚠️ Falló Slot ${selectedCandidate.slot}. Intentando siguiente...`);
            
            // Quitamos al fallido de la lista
            const nextCandidates = availableCandidates.filter(c => c.slot !== selectedCandidate.slot);
            
            if (nextCandidates.length > 0) {
                const backup = nextCandidates[0]; // El siguiente en prioridad
                console.log(`🚀 Reintentando con Slot ${backup.slot} (Backup)...`);
                try {
                    await waitForSocketOpen(backup.session.sock);
                    const sentBackup = await backup.session.sock.sendMessage(jid, { text: message });
                    if (sentBackup?.key?.id) {
                         botMessageIds.add(sentBackup.key.id);
                         setTimeout(() => botMessageIds.delete(sentBackup.key.id), 15000);
                    }
                    await saveRouting(clientPhone, locationId, null, backup.myNumber);
                    return res.json({ ok: true });
                } catch(e2) {}
            }
            
            return res.status(500).json({ error: "Send failed" });
        }
    }
    res.json({ ignored: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Error" }); }
});

app.post("/config-slot", async (req, res) => {
  const { locationId, slot, phoneNumber, priority, addTag, removeTag } = req.body;
  if (!locationId) return res.status(400).json({ error: "Faltan datos" });

  try {
    // 1. Identificar el Slot Objetivo (targetSlot)
    let targetSlot = slot;
    if (!targetSlot && phoneNumber) {
        const norm = normalizePhone(phoneNumber);
        const r = await pool.query("SELECT slot_id FROM location_slots WHERE location_id=$1 AND phone_number=$2", [locationId, norm]);
        if (r.rows.length) targetSlot = r.rows[0].slot_id;
    }
    
    if (!targetSlot) return res.status(404).json({ error: "Slot no encontrado" });

    // 2. Obtener estado ACTUAL de todos los slots (Necesario para el Swap)
    const allRes = await pool.query("SELECT slot_id, priority, tags FROM location_slots WHERE location_id=$1", [locationId]);
    const allSlots = allRes.rows;

    // Datos actuales del slot que queremos modificar
    const currentSlotData = allSlots.find(s => s.slot_id == targetSlot);
    
    // Valores por defecto si no existían
    let t = currentSlotData?.tags || [];
    let finalP = currentSlotData?.priority || 99;
    let currentPriority = currentSlotData?.priority || 99; // Guardamos la prioridad "vieja"

    // 3. Lógica de PRIORIDAD (SWAP / INTERCAMBIO)
    if (priority !== undefined) {
        const requestedPriority = parseInt(priority);

        // Solo hacemos swap si la prioridad es diferente a la que ya tiene
        if (requestedPriority !== currentPriority) {
            // Buscamos si alguien más YA TIENE la prioridad que queremos robar
            const conflictSlot = allSlots.find(x => x.priority === requestedPriority && x.slot_id != targetSlot);
            
            if (conflictSlot) {
                console.log(`🔄 Swap: Slot ${targetSlot} toma la ${requestedPriority}, Slot ${conflictSlot.slot_id} se queda con la ${currentPriority}`);
                
                // Al slot conflictivo le asignamos MI prioridad vieja (currentPriority)
                await pool.query(
                    "UPDATE location_slots SET priority=$1 WHERE location_id=$2 AND slot_id=$3", 
                    [currentPriority, locationId, conflictSlot.slot_id]
                );
            }
            finalP = requestedPriority;
        }
    }

    // 4. Lógica de TAGS
    if (addTag && !t.includes(addTag)) t.push(addTag);
    if (removeTag) t = t.filter(x => x !== removeTag);

    // 5. Guardar cambios del slot objetivo
    await pool.query(
        "UPDATE location_slots SET tags=$1::jsonb, priority=$2 WHERE location_id=$3 AND slot_id=$4", 
        [JSON.stringify(t), finalP, locationId, targetSlot]
    );

    res.json({ success: true });

  } catch(e) { 
      console.error(e);
      res.status(500).json({error:e.message}); 
  }
});

app.post("/remove-slot", async (req, res) => {
    try { await deleteSessionData(req.query.locationId, req.query.slot); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const evt = req.body;
        if (evt.type === "INSTALL") {
             const at = await ensureAgencyToken();
             const ats = await getTokens(AGENCY_ROW_ID);
             const lr = await axios.post("https://services.leadconnectorhq.com/oauth/locationToken", new URLSearchParams({ companyId: evt.companyId, locationId: evt.locationId }).toString(), { headers: { Authorization: `Bearer ${at}`, Version: GHL_API_VERSION, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
             await saveTokens(evt.locationId, { ...ats, locationAccess: lr.data });
             await callGHLWithAgency({ method: "post", url: "https://services.leadconnectorhq.com/custom-menus/", data: { title: "WhatsApp - Clic&App", url: `${CUSTOM_MENU_URL_WA}?location_id=${evt.locationId}`, showOnCompany: false, showOnLocation: true, showToAllLocations: false, locations: [evt.locationId], openMode: "iframe", userRole: "all", allowCamera: false, allowMicrophone: false } }).catch(() => {});
             return res.json({ ok: true });
        }
        if (evt.type === "UNINSTALL") {
            const slots = await pool.query("SELECT slot_id FROM location_slots WHERE location_id=$1", [evt.locationId]);
            for(const r of slots.rows) await deleteSessionData(evt.locationId, r.slot_id);
            await pool.query("DELETE FROM auth_db WHERE locationid=$1", [evt.locationId]);
            return res.json({ ok: true });
        }
        res.json({ ignored: true });
    } catch (e) { res.status(500).json({error: "Error"}); }
});

app.get("/config", (req, res) => res.json({ max_slots: 3 }));

// --- ARRANQUE ---

async function restoreSessions() {
  try {
    const res = await pool.query("SELECT DISTINCT session_id FROM baileys_auth");
    for (const row of res.rows) {
      const parts = row.session_id.split("_slot");
      if (parts.length === 2) startWhatsApp(parts[0], parts[1]).catch(console.error);
    }
  } catch (e) { console.error(e); }
}

(async () => {
  try {
    await initDb();
    app.listen(PORT, async () => {
      console.log(`API OK ${PORT}`);
      await restoreSessions();
    });
  } catch (e) {
    console.error("❌ Error fatal al iniciar:", e);
    process.exit(1);
  }
})();