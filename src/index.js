const path = require("path");
const fs = require("fs");
const cors = require("cors");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const bcrypt = require("bcryptjs"); // ✅ IMPORTANTE: Para el registro de usuarios
const { initDb } = require("./db/init");
const { pool } = require("./config/db");
const { registerNewTenant, getTenantConfig } = require("./services/tenantService");

// ✅ Importamos requireRole para proteger rutas de admin
const { login, verifyToken, requireRole } = require("./controllers/authController");

const {
    startWhatsApp,
    sessions,
    botMessageIds,
    deleteSessionData,
    saveRouting,
    getRoutingForPhone,
    getLocationSlotsConfig,
    waitForSocketOpen,
    processKeywordTags,
    sendButtons
} = require("./services/whatsappService");

const {
    saveTokens,
    getTokens,
    ensureAgencyToken,
    callGHLWithAgency,
    findOrCreateGHLContact
} = require("./services/ghlService");

const { normalizePhone, processAdvancedMessage, sleep } = require("./helpers/utils");
const { parseGHLCommand } = require("./helpers/parser");
const axios = require("axios");

if (!globalThis.crypto) {
    globalThis.crypto = require("crypto").webcrypto;
}

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA = process.env.CUSTOM_MENU_URL_WA || "[https://wa.clicandapp.com](https://wa.clicandapp.com)";
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

app.use(cors({
    origin: [
        "http://localhost:5173",
        "https://clicandapp-frontend-web-wa.aqdlt2.easypanel.host",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// ==========================================
// 🔓 RUTAS PÚBLICAS (Login, Registro, Webhooks)
// ==========================================

app.post("/auth/login", login);

// ✅ RUTA DE REGISTRO (Para nuevas Agencias)
app.post("/auth/register", async (req, res) => {
    const { email, password, agencyName, role } = req.body;

    if (!email || !password) return res.status(400).json({ error: "Datos incompletos" });

    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        const userRole = role || 'agency';
        // Generamos un ID de agencia. 
        // NOTA: Para que la vinculación automática funcione, este ID debería coincidir con el Company ID de GHL.
        // Si es un registro manual, se genera uno nuevo.
        const agencyId = userRole === 'agency' ? `AG-${Date.now()}` : null;

        const newUser = await pool.query(
            "INSERT INTO users (email, password_hash, role, agency_id) VALUES ($1, $2, $3, $4) RETURNING id, email, role, agency_id",
            [email, hash, userRole, agencyId]
        );

        res.json({ success: true, user: newUser.rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: "El email ya existe" });
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// ✅ WEBHOOK DE INSTALACIÓN (GHL Marketplace)
// Vincula la subcuenta (Location) con la Agencia (Company) automáticamente
app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const evt = req.body;
        console.log("🔔 Webhook App recibido:", JSON.stringify(evt));

        if (evt.type === "INSTALL") {
            try {
                // 1. Obtener Tokens de GHL (OAuth)
                const at = await ensureAgencyToken();
                const ats = await getTokens(AGENCY_ROW_ID);

                const lr = await axios.post(
                    "https://services.leadconnectorhq.com/oauth/locationToken",
                    new URLSearchParams({
                        companyId: evt.companyId,
                        locationId: evt.locationId
                    }).toString(),
                    {
                        headers: {
                            Authorization: `Bearer ${at}`,
                            Version: GHL_API_VERSION,
                            "Content-Type": "application/x-www-form-urlencoded",
                            Accept: "application/json"
                        }
                    }
                );

                // Guardar tokens de la location
                await saveTokens(evt.locationId, { ...ats, locationAccess: lr.data });

                // 2. Crear Custom Menu (Iframe) con la URL correcta
                // Esto soluciona el problema de "location_id=null" porque inyectamos el ID explícitamente aquí.
                await callGHLWithAgency({
                    method: "post",
                    url: "https://services.leadconnectorhq.com/custom-menus/",
                    data: {
                        title: "WhatsApp - Clic&App",
                        url: `${CUSTOM_MENU_URL_WA}?location_id=${evt.locationId}`, // <-- AQUÍ LA MAGIA 
                        showOnCompany: false,
                        showOnLocation: true,
                        showToAllLocations: false,
                        locations: [evt.locationId],
                        openMode: "iframe",
                        userRole: "all",
                        allowCamera: false,
                        allowMicrophone: false
                    }
                }).catch((err) => {
                    console.error("⚠️ Error creando Custom Menu:", err.response?.data || err.message);
                });

            } catch (errGHL) {
                console.error("❌ Error en flujo OAuth GHL:", errGHL.message);
                // No detenemos el proceso, intentamos registrar en BD local de todos modos
            }

            // 3. Registrar/Vincular en DB Local (Jerarquía)
            await registerNewTenant(evt.locationId, evt.companyId);

            return res.json({ ok: true });
        }
        if (evt.type === "UNINSTALL") {
            console.log(`🗑️ Desinstalación detectada: ${evt.locationId}`);
            await pool.query("UPDATE tenants SET status = 'cancelled' WHERE location_id = $1", [evt.locationId]);
            return res.json({ ok: true });
        }

        res.json({ ignored: true });
    } catch (e) {
        console.error("Error en app-webhook:", e);
        res.status(500).json({ error: "Error procesando webhook" });
    }
});

// ✅ WEBHOOK MENSAJERÍA (Outbound GHL -> WhatsApp)
app.post("/ghl/webhook", async (req, res) => {
    try {
        const { locationId, phone, message, type, attachments } = req.body;
        if (!locationId || !phone || (!message && !attachments))
            return res.json({ ignored: true });

        // Evitar bucles infinitos si nosotros mismos enviamos el mensaje
        if (message && message.includes("[Enviado desde otro dispositivo]"))
            return res.json({ ignored: true });

        if (type === "Outbound" || type === "SMS") {
            let finalMessage = message || "";
            let messageDelay = 0;

            if (finalMessage) {
                const processed = processAdvancedMessage(finalMessage);
                finalMessage = processed.text;
                messageDelay = processed.delay;

                if (messageDelay > 0) {
                    console.log(`⏳ Delay: ${messageDelay}ms para ${phone}...`);
                    await sleep(messageDelay);
                }
            }

            const clientPhone = normalizePhone(phone);
            let dbConfigs = await getLocationSlotsConfig(locationId);

            // Buscar un slot conectado
            let availableCandidates = dbConfigs
                .map((conf) => ({
                    slot: conf.slot_id,
                    priority: conf.priority,
                    tags: conf.tags || [],
                    myNumber: conf.phone_number,
                    session: sessions.get(`${locationId}_slot${conf.slot_id}`),
                }))
                .filter((c) => c.session && c.session.isConnected);

            if (availableCandidates.length === 0)
                return res.status(200).json({ error: "No connected devices" });

            let selectedCandidate = availableCandidates[0]; // Simple: elige el primero disponible
            const sessionToUse = selectedCandidate.session;
            const jid = clientPhone.replace(/\D/g, "").replace("+", "") + "@s.whatsapp.net";

            try {
                await waitForSocketOpen(sessionToUse.sock);

                if (attachments && attachments.length > 0) {
                    for (const url of attachments) {
                        let content = { image: { url: url }, caption: finalMessage || "" };
                        if (url.endsWith(".mp4")) content = { video: { url: url }, caption: finalMessage || "" };
                        else if (url.endsWith(".pdf")) content = { document: { url: url }, mimetype: "application/pdf", fileName: "archivo.pdf", caption: finalMessage || "" };

                        const sent = await sessionToUse.sock.sendMessage(jid, content);
                        if (sent?.key?.id) {
                            botMessageIds.add(sent.key.id);
                            setTimeout(() => botMessageIds.delete(sent.key.id), 15000);
                        }
                    }
                } else {
                    const sent = await sessionToUse.sock.sendMessage(jid, { text: finalMessage });
                    if (sent?.key?.id) {
                        botMessageIds.add(sent.key.id);
                        setTimeout(() => botMessageIds.delete(sent.key.id), 15000);
                    }
                }

                // Registrar contacto y tags
                const contact = await findOrCreateGHLContact(locationId, clientPhone, "System Outbound", null, true);
                if (contact && contact.id) {
                    await processKeywordTags(locationId, contact.id, finalMessage, false);
                }
                await saveRouting(clientPhone.replace("+", ""), locationId, null, selectedCandidate.myNumber);

                return res.json({ ok: true });
            } catch (e) {
                console.error(`❌ Error envío: ${e.message}`);
                return res.status(500).json({ error: "Send failed" });
            }
        }
        res.json({ ignored: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error" });
    }
});

// ==========================================
// 🔐 RUTAS PROTEGIDAS (Panel de Agencia / Admin)
// ==========================================

// 1. Obtener Subcuentas (Con filtro de Jerarquía)
app.get("/agency/locations", verifyToken, async (req, res) => {
    const { agencyId } = req.query;

    // Si es AGENCIA, forzamos su ID (evitamos ver datos ajenos)
    if (req.user.role === 'agency') {
        const myAgencyId = req.user.agencyId;
        if (!myAgencyId) return res.status(403).json({ error: "Agencia no identificada" });

        try {
            const result = await pool.query(`
                SELECT t.location_id, t.name, t.status, t.settings, 
                       (SELECT COUNT(*) FROM location_slots s WHERE s.location_id = t.location_id) as total_slots
                FROM tenants t 
                WHERE t.agency_id = $1
            `, [myAgencyId]);
            return res.json(result.rows);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // Si es ADMIN, puede ver lo que quiera (si envía el query param)
    if (!agencyId) return res.status(400).json({ error: "Falta agencyId" });
    try {
        const result = await pool.query(`
            SELECT t.location_id, t.name, t.status, t.settings, 
                   (SELECT COUNT(*) FROM location_slots s WHERE s.location_id = t.location_id) as total_slots
            FROM tenants t 
            WHERE t.agency_id = $1
        `, [agencyId]);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Agregar Slot
app.post("/agency/add-slot", verifyToken, async (req, res) => {
    const { locationId } = req.body;
    try {
        const resSlots = await pool.query(
            "SELECT slot_id FROM location_slots WHERE location_id = $1 ORDER BY slot_id ASC",
            [locationId]
        );

        const existingIds = resSlots.rows.map(r => r.slot_id);
        let newSlotId = 1;
        while (existingIds.includes(newSlotId)) {
            newSlotId++;
        }

        if (newSlotId > 10) {
            return res.status(400).json({ error: "Límite de dispositivos alcanzado" });
        }

        await pool.query(
            "INSERT INTO location_slots (location_id, slot_id, slot_name, priority) VALUES ($1, $2, $3, $4)",
            [locationId, newSlotId, `Dispositivo #${newSlotId}`, newSlotId]
        );

        res.json({ success: true, slot_id: newSlotId, slot_name: `Dispositivo #${newSlotId}` });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// 3. Eliminar Slot
app.delete("/agency/slots/:locationId/:slotId", verifyToken, async (req, res) => {
    const { locationId, slotId } = req.params;
    try {
        await deleteSessionData(locationId, slotId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Detalles de Location (Configuración, Keywords, Slots)
app.get("/agency/location-details/:locationId", verifyToken, async (req, res) => {
    const { locationId } = req.params;
    try {
        const [slotsRes, keywordsRes, tenantRes] = await Promise.all([
            pool.query("SELECT * FROM location_slots WHERE location_id = $1 ORDER BY slot_id ASC", [locationId]),
            pool.query("SELECT * FROM keyword_tags WHERE location_id = $1 ORDER BY created_at DESC", [locationId]),
            pool.query("SELECT settings, name FROM tenants WHERE location_id = $1", [locationId])
        ]);
        res.json({
            slots: slotsRes.rows,
            keywords: keywordsRes.rows,
            settings: tenantRes.rows[0]?.settings || {},
            name: tenantRes.rows[0]?.name
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/agency/keywords", verifyToken, async (req, res) => {
    const { locationId, keyword, tag } = req.body;
    try {
        const result = await pool.query(
            "INSERT INTO keyword_tags (location_id, keyword, tag) VALUES ($1, $2, $3) RETURNING *",
            [locationId, keyword.toLowerCase(), tag]
        );
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/agency/keywords/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM keyword_tags WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put("/agency/settings/:locationId", verifyToken, async (req, res) => {
    const { locationId } = req.params;
    const { settings } = req.body;
    try {
        await pool.query(
            "UPDATE tenants SET settings = $1::jsonb, updated_at = NOW() WHERE location_id = $2",
            [JSON.stringify(settings), locationId]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- RUTAS PÚBLICAS/OPERATIVAS (Para Iframe o Frontend sin auth directa en endpoints específicos) ---

app.post("/start-whatsapp", async (req, res) => {
    const { locationId, slot } = req.query;
    try {
        await startWhatsApp(locationId, slot);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Error" });
    }
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
        const r = await pool.query(
            "SELECT priority, tags, slot_name FROM location_slots WHERE location_id=$1 AND slot_id=$2",
            [locationId, slot]
        );
        if (r.rows.length) extra = r.rows[0];
    } catch (e) { }

    if (sess && sess.isConnected)
        return res.json({
            connected: true,
            myNumber: sess.myNumber,
            priority: extra.priority || 99,
            tags: extra.tags || [],
            slotName: extra.slot_name || `Dispositivo #${slot}`
        });
    res.json({ connected: false, priority: extra.priority, tags: extra.tags, slotName: extra.slot_name || `Dispositivo #${slot}` });
});

app.post("/config-slot", verifyToken, async (req, res) => {
    const { locationId, slot, slotName } = req.body;
    try {
        await pool.query(`
            INSERT INTO location_slots (location_id, slot_id, slot_name)
            VALUES ($1, $2, $3)
            ON CONFLICT (location_id, slot_id) 
            DO UPDATE SET slot_name = EXCLUDED.slot_name
        `, [locationId, slot, slotName]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }) }
});

app.get("/get-info", async (req, res) => {
    try {
        const { locationId, slot } = req.query;
        const slots = await getLocationSlotsConfig(locationId, slot);
        return res.json({ slots });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/remove-slot", verifyToken, async (req, res) => {
    try {
        await deleteSessionData(req.query.locationId, req.query.slot);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/config", async (req, res) => {
    try {
        const { locationId } = req.query;
        const tenantStatus = await getTenantConfig(locationId);

        const slotsRes = await pool.query(
            "SELECT slot_id, slot_name, phone_number FROM location_slots WHERE location_id = $1 ORDER BY slot_id ASC",
            [locationId]
        );

        const activeSlots = slotsRes.rows.map(s => ({
            id: s.slot_id,
            name: s.slot_name,
            connected: !!s.phone_number
        }));

        res.json({
            is_active: tenantStatus.active,
            reason: tenantStatus.reason,
            slots: activeSlots
        });
    } catch (e) {
        res.status(500).json({ error: "Error interno" });
    }
});

// ==========================================
// 🔐 RUTAS ADMIN PANEL (Solo Admin)
// ==========================================

app.get("/admin/agencies", verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                agency_id,
                MAX(agency_name) as agency_name,
                COUNT(*) as total_subaccounts,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_subaccounts
            FROM tenants 
            WHERE agency_id IS NOT NULL
            GROUP BY agency_id
        `);
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.get("/admin/tenants", verifyToken, requireRole('admin'), async (req, res) => {
    const { agencyId } = req.query;
    try {
        let query = `
            SELECT t.*, p.name as plan_name 
            FROM tenants t 
            LEFT JOIN subscription_plans p ON t.plan_id = p.id 
        `;
        const params = [];
        if (agencyId) {
            query += " WHERE t.agency_id = $1";
            params.push(agencyId);
        }
        query += " ORDER BY t.created_at DESC";
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/admin/tenants", verifyToken, requireRole('admin'), async (req, res) => {
    const { locationId, planName, days, name, agencyId, agencyName } = req.body;
    try {
        const planRes = await pool.query("SELECT id FROM subscription_plans WHERE name = $1", [planName || 'trial']);
        const planId = planRes.rows[0]?.id;
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + (days || 5));
        const defaultSettings = { show_source_label: true, create_unknown_contacts: true, transcribe_audio: true };

        await pool.query(`
            INSERT INTO tenants (
                location_id, name, agency_id, agency_name, 
                plan_id, status, trial_ends_at, settings, created_at
            )
            VALUES ($1, $2, $3, $4, $5, 'active', $6, $7::jsonb, NOW())
            ON CONFLICT (location_id) 
            DO UPDATE SET 
                name = EXCLUDED.name, 
                agency_id = EXCLUDED.agency_id,
                agency_name = EXCLUDED.agency_name,
                plan_id = EXCLUDED.plan_id,
                trial_ends_at = EXCLUDED.trial_ends_at
        `, [locationId, name, agencyId, agencyName, planId, trialEnd, JSON.stringify(defaultSettings)]);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put("/admin/tenants/:id", verifyToken, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { status, settings, name, agencyName } = req.body;
    try {
        if (status) await pool.query("UPDATE tenants SET status = $1, updated_at = NOW() WHERE location_id = $2", [status, id]);
        if (settings) await pool.query("UPDATE tenants SET settings = $1::jsonb, updated_at = NOW() WHERE location_id = $2", [JSON.stringify(settings), id]);
        if (name) await pool.query("UPDATE tenants SET name = $1, updated_at = NOW() WHERE location_id = $2", [name, id]);
        if (agencyName) await pool.query("UPDATE tenants SET agency_name = $1, updated_at = NOW() WHERE location_id = $2", [agencyName, id]);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- ARRANQUE ---

async function restoreSessions() {
    try {
        const res = await pool.query("SELECT DISTINCT session_id FROM baileys_auth");
        for (const row of res.rows) {
            const parts = row.session_id.split("_slot");
            if (parts.length === 2)
                startWhatsApp(parts[0], parts[1]).catch(console.error);
        }
    } catch (e) {
        console.error(e);
    }
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