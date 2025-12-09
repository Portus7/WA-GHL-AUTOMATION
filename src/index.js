const path = require("path");
const fs = require("fs");
const cors = require("cors");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const bcrypt = require("bcryptjs"); // ✅ IMPORTANTE: Para registro
const { initDb } = require("./db/init");
const { pool } = require("./config/db");
const { registerNewTenant, getTenantConfig } = require("./services/tenantService");

// ✅ Importamos requireRole para protección
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
    findOrCreateGHLContact,
    logMessageToGHL,
    addTagToContact
} = require("./services/ghlService");

const { normalizePhone, processAdvancedMessage, sleep } = require("./helpers/utils");
const { parseGHLCommand } = require("./helpers/parser");
const axios = require("axios");

if (!globalThis.crypto) {
    globalThis.crypto = require("crypto").webcrypto;
}

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

// ✅ URL limpia para el iframe (sin markdown)
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

app.use(cors({
    origin: "*", // Ajusta en producción a tus dominios reales
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// ==========================================
// 🔓 RUTAS PÚBLICAS
// ==========================================

app.post("/auth/login", login);

// ✅ REGISTRO DE AGENCIAS
app.post("/auth/register", async (req, res) => {
    const { email, password, agencyName, role } = req.body;

    if (!email || !password) return res.status(400).json({ error: "Datos incompletos" });

    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        const userRole = role || 'agency';
        // Generamos ID temporal. Se actualizará a CompanyID real al instalar la app en GHL.
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

// ✅ WEBHOOK INSTALACIÓN APP (Marketplace GHL)
app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const evt = req.body;
        console.log("🔔 Webhook App recibido:", JSON.stringify(evt));

        if (evt.type === "INSTALL") {
            try {
                // 1. Obtener y guardar tokens de la Location (OAuth)
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

                await saveTokens(evt.locationId, { ...ats, locationAccess: lr.data });

                // 2. Crear Custom Menu (Iframe)
                // Se inyecta location_id en la URL para que el frontend sepa quién es
                await callGHLWithAgency({
                    method: "post",
                    url: "https://services.leadconnectorhq.com/custom-menus/",
                    data: {
                        title: "WhatsApp - Clic&App",
                        url: `${CUSTOM_MENU_URL_WA}?location_id=${evt.locationId}`,
                        showOnCompany: false,
                        showOnLocation: true,
                        showToAllLocations: false,
                        locations: [evt.locationId],
                        openMode: "iframe",
                        userRole: "all",
                        allowCamera: false,
                        allowMicrophone: false,
                        // ✅ SOLUCIÓN AL ERROR 422: Objeto icon obligatorio
                        icon: {
                            name: "whatsapp",
                            fontFamily: "fab"
                        }
                    }
                }).then(() => console.log("✅ Custom Menu creado"))
                    .catch((err) => console.error("⚠️ Error menú:", err.response?.data || err.message));

            } catch (errGHL) {
                console.error("❌ Error flujo GHL:", errGHL.message);
            }

            // 3. Registrar en DB Local (Vincular Location con CompanyID)
            await registerNewTenant(evt.locationId, evt.companyId);

            return res.json({ ok: true });
        }

        if (evt.type === "UNINSTALL") {
            console.log(`🗑️ Desinstalación: ${evt.locationId}`);
            await pool.query("UPDATE tenants SET status = 'cancelled' WHERE location_id = $1", [evt.locationId]);
            return res.json({ ok: true });
        }

        res.json({ ignored: true });
    } catch (e) {
        console.error("Error app-webhook:", e);
        res.status(500).json({ error: "Error procesando webhook" });
    }
});

// ✅ WEBHOOK MENSAJERÍA (Outbound)
app.post("/ghl/webhook", async (req, res) => {
    try {
        const { locationId, phone, message, type, attachments } = req.body;
        if (!locationId || !phone) return res.json({ ignored: true });
        if (message && message.includes("[Enviado desde otro dispositivo]")) return res.json({ ignored: true });

        if (type === "Outbound" || type === "SMS") {
            let finalMessage = message || "";
            let messageDelay = 0;

            if (finalMessage) {
                const processed = processAdvancedMessage(finalMessage);
                finalMessage = processed.text;
                messageDelay = processed.delay;
                if (messageDelay > 0) await sleep(messageDelay);
            }

            const clientPhone = normalizePhone(phone);
            const dbConfigs = await getLocationSlotsConfig(locationId);

            let availableCandidates = dbConfigs.map(conf => ({
                slot: conf.slot_id,
                myNumber: conf.phone_number,
                session: sessions.get(`${locationId}_slot${conf.slot_id}`)
            })).filter(c => c.session && c.session.isConnected);

            if (availableCandidates.length === 0) return res.status(200).json({ error: "No devices connected" });

            const selected = availableCandidates[0];
            const jid = clientPhone.replace(/\D/g, "") + "@s.whatsapp.net";

            try {
                await waitForSocketOpen(selected.session.sock);

                if (attachments && attachments.length > 0) {
                    for (const url of attachments) {
                        let content = { image: { url }, caption: finalMessage };
                        if (url.endsWith(".mp4")) content = { video: { url }, caption: finalMessage };
                        else if (url.endsWith(".pdf")) content = { document: { url }, mimetype: "application/pdf", fileName: "doc.pdf", caption: finalMessage };
                        await selected.session.sock.sendMessage(jid, content);
                    }
                } else {
                    await selected.session.sock.sendMessage(jid, { text: finalMessage });
                }

                const contact = await findOrCreateGHLContact(locationId, clientPhone, "System Outbound", null, true);
                if (contact?.id) await processKeywordTags(locationId, contact.id, finalMessage, false);
                await saveRouting(clientPhone, locationId, contact?.id, selected.myNumber);

                return res.json({ ok: true });
            } catch (e) {
                console.error("Error envío:", e.message);
                return res.status(500).json({ error: "Send failed" });
            }
        }
        res.json({ ignored: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error" });
    }
});

// ==========================================
// 🔐 RUTAS PROTEGIDAS (Agencia/Admin)
// ==========================================

// ✅ SINCRONIZACIÓN AUTOMÁTICA (Llamado por Frontend tras instalación)
app.post("/agency/sync-ghl", verifyToken, async (req, res) => {
    const { locationIdToVerify } = req.body;
    const userId = req.user.id;

    if (!locationIdToVerify) return res.status(400).json({ error: "Falta Location ID" });

    try {
        // 1. Buscar el Tenant instalado
        //const tenantRes = await pool.query("SELECT agency_id FROM tenants WHERE location_id = $1", [locationIdToVerify]);

        //if (tenantRes.rows.length === 0) {
        //    return res.status(404).json({ error: "Subcuenta no encontrada. Instálala primero en GHL." });
        //}

        //const realGhlCompanyId = tenantRes.rows[0].agency_id;

        // 2. Actualizar Usuario con ID Real
        await pool.query("UPDATE users SET agency_id = $1 WHERE id = $2", [locationIdToVerify, userId]);

        res.json({ success: true, newAgencyId: locationIdToVerify });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 1. Obtener Subcuentas (Filtrado por Jerarquía)
app.get("/agency/locations", verifyToken, async (req, res) => {
    const { agencyId } = req.query;

    // Si es AGENCIA, usamos SU ID real (de la DB para asegurar frescura)
    if (req.user.role === 'agency') {
        try {
            const userRes = await pool.query("SELECT agency_id FROM users WHERE id = $1", [req.user.id]);
            const myAgencyId = userRes.rows[0]?.agency_id;

            if (!myAgencyId || myAgencyId.startsWith('AG-')) {
                return res.json([]); // Aún no ha sincronizado
            }

            const result = await pool.query(`
                SELECT t.location_id, t.name, t.status, t.settings, 
                       (SELECT COUNT(*) FROM location_slots s WHERE s.location_id = t.location_id) as total_slots
                FROM tenants t WHERE t.agency_id = $1
            `, [myAgencyId]);
            return res.json(result.rows);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // Si es ADMIN, puede ver cualquier agencia
    if (!agencyId) return res.status(400).json({ error: "Falta agencyId" });
    try {
        const result = await pool.query(`
            SELECT t.location_id, t.name, t.status, t.settings, 
                   (SELECT COUNT(*) FROM location_slots s WHERE s.location_id = t.location_id) as total_slots
            FROM tenants t WHERE t.agency_id = $1
        `, [agencyId]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Agregar Slot
app.post("/agency/add-slot", verifyToken, async (req, res) => {
    const { locationId } = req.body;
    try {
        const resSlots = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1 ORDER BY slot_id ASC", [locationId]);
        const ids = resSlots.rows.map(r => r.slot_id);
        let newId = 1;
        while (ids.includes(newId)) newId++;

        if (newId > 10) return res.status(400).json({ error: "Límite alcanzado" });

        await pool.query(
            "INSERT INTO location_slots (location_id, slot_id, slot_name, priority) VALUES ($1, $2, $3, $4)",
            [locationId, newId, `Dispositivo #${newId}`, newId]
        );
        res.json({ success: true, slot_id: newId, slot_name: `Dispositivo #${newId}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Borrar Slot
app.delete("/agency/slots/:locationId/:slotId", verifyToken, async (req, res) => {
    try {
        await deleteSessionData(req.params.locationId, req.params.slotId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Detalles de Location
app.get("/agency/location-details/:locationId", verifyToken, async (req, res) => {
    const { locationId } = req.params;
    try {
        const [slots, keys, tenant] = await Promise.all([
            pool.query("SELECT * FROM location_slots WHERE location_id=$1 ORDER BY slot_id", [locationId]),
            pool.query("SELECT * FROM keyword_tags WHERE location_id=$1 ORDER BY created_at DESC", [locationId]),
            pool.query("SELECT settings, name FROM tenants WHERE location_id=$1", [locationId])
        ]);
        res.json({
            slots: slots.rows,
            keywords: keys.rows,
            settings: tenant.rows[0]?.settings || {},
            name: tenant.rows[0]?.name
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Configuración
app.post("/agency/keywords", verifyToken, async (req, res) => {
    try {
        const r = await pool.query("INSERT INTO keyword_tags (location_id, keyword, tag) VALUES ($1, $2, $3) RETURNING *",
            [req.body.locationId, req.body.keyword.toLowerCase(), req.body.tag]);
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/agency/keywords/:id", verifyToken, async (req, res) => {
    try { await pool.query("DELETE FROM keyword_tags WHERE id=$1", [req.params.id]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/agency/settings/:locationId", verifyToken, async (req, res) => {
    try {
        await pool.query("UPDATE tenants SET settings=$1::jsonb WHERE location_id=$2", [JSON.stringify(req.body.settings), req.params.locationId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- RUTAS PÚBLICAS QR/STATUS (Para Iframe) ---

app.post("/start-whatsapp", async (req, res) => {
    try { await startWhatsApp(req.query.locationId, req.query.slot); res.json({ success: true }); } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.get("/qr", (req, res) => {
    const s = sessions.get(`${req.query.locationId}_slot${req.query.slot}`);
    if (s && s.qr) res.json({ qr: s.qr }); else res.status(404).json({ error: "No QR" });
});

app.get("/status", async (req, res) => {
    const s = sessions.get(`${req.query.locationId}_slot${req.query.slot}`);
    let extra = {};
    try { const r = await pool.query("SELECT * FROM location_slots WHERE location_id=$1 AND slot_id=$2", [req.query.locationId, req.query.slot]); if (r.rows.length) extra = r.rows[0]; } catch (e) { }
    res.json({ connected: s?.isConnected || false, myNumber: s?.myNumber, slotName: extra.slot_name });
});

app.post("/config-slot", verifyToken, async (req, res) => {
    try {
        await pool.query(`INSERT INTO location_slots (location_id, slot_id, slot_name) VALUES ($1, $2, $3) ON CONFLICT (location_id, slot_id) DO UPDATE SET slot_name = EXCLUDED.slot_name`, [req.body.locationId, req.body.slot, req.body.slotName]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/config", async (req, res) => {
    try {
        const { locationId } = req.query;
        const tenantStatus = await getTenantConfig(locationId);
        const slotsRes = await pool.query("SELECT slot_id, slot_name, phone_number FROM location_slots WHERE location_id = $1 ORDER BY slot_id ASC", [locationId]);
        res.json({
            is_active: tenantStatus.active,
            reason: tenantStatus.reason,
            slots: slotsRes.rows.map(s => ({ id: s.slot_id, name: s.slot_name, connected: !!s.phone_number }))
        });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

// --- ADMIN ROUTES ---
app.get("/admin/agencies", verifyToken, requireRole('admin'), async (req, res) => {
    const r = await pool.query("SELECT agency_id, MAX(agency_name) as agency_name, COUNT(*) as total_subaccounts FROM tenants WHERE agency_id IS NOT NULL GROUP BY agency_id");
    res.json(r.rows);
});

app.get("/admin/tenants", verifyToken, requireRole('admin'), async (req, res) => {
    const { agencyId } = req.query;
    let q = `SELECT t.*, p.name as plan_name FROM tenants t LEFT JOIN subscription_plans p ON t.plan_id = p.id`;
    const p = [];
    if (agencyId) { q += " WHERE t.agency_id = $1"; p.push(agencyId); }
    q += " ORDER BY t.created_at DESC";
    const r = await pool.query(q, p);
    res.json(r.rows);
});

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