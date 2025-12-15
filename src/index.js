const path = require("path");
const fs = require("fs");
const cors = require("cors");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const bcrypt = require("bcryptjs");
const { initDb } = require("./db/init");
const { pool } = require("./config/db");
const { registerNewTenant, getTenantConfig } = require("./services/tenantService");
const rateLimit = require("express-rate-limit");
const { canAddSlot, canCreateTenant } = require("./services/planService");

const { login, verifyToken, requireRole } = require("./controllers/authController");
const { startMediaCleanup } = require("./services/mediaCleanup");

// --- SERVICIOS WA ---
const {
    startWhatsApp,
    sessions,
    botMessageIds,
    deleteSessionData,
    saveRouting,
    getRoutingForPhone,
    getLocationSlotsConfig,
    waitForSocketOpen,
    sendButtons,
    SUPPORT_LOC_ID,
    SUPPORT_SLOT_ID,
    sendInteractiveMessage,
    getGroups,
    syncGroupMembers
} = require("./services/whatsappService");

// --- SERVICIOS GHL ---
const {
    saveTokens,
    getTokens,
    ensureAgencyToken,
    callGHLWithAgency,
    findOrCreateGHLContact,
    logMessageToGHL,
    addTagToContact,
    assignContactOwner,
    getLocationUsers,
    getContact
} = require("./services/ghlService");

// --- SERVICIOS DE PAGO Y PLANES (NUEVO) ---
const { subscribe, manageBilling } = require("./controllers/paymentController");
const { handleWebhook } = require("./controllers/webhookController");

const { normalizePhone, processAdvancedMessage, sleep } = require("./helpers/utils");
const { parseGHLCommand } = require("./helpers/parser");
const axios = require("axios");

if (!globalThis.crypto) {
    globalThis.crypto = require("crypto").webcrypto;
}

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

// ✅ Confiar en el proxy (Nginx/Docker)
app.set('trust proxy', 1);

// ==========================================
// 💳 WEBHOOK DE STRIPE (CRÍTICO: ANTES DE JSON)
// ==========================================
// Stripe necesita el cuerpo en crudo (Buffer) para validar la firma criptográfica.
// Si esto pasa por express.json(), la validación fallará.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), handleWebhook);

// ==========================================
// ⚙️ MIDDLEWARES GLOBALES
// ==========================================
app.use(express.json()); // Parser JSON para el resto de la API
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.static(PUBLIC_DIR));

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// ==========================================
// 🛡️ RATE LIMITING
// ==========================================
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Demasiados intentos de inicio de sesión." },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 200,
    message: { error: "Límite de peticiones excedido." }
});

const pollingLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 150,
    message: { error: "Demasiadas consultas de estado." }
});

app.use("/auth/", authLimiter);
app.use("/ghl/", apiLimiter);
app.use("/agency/", apiLimiter);
app.use("/admin/", apiLimiter);
app.use("/payments/", apiLimiter); // Rate limit para pagos
app.use("/status", pollingLimiter);
app.use("/qr", pollingLimiter);

// ==========================================
// 🔓 RUTAS PÚBLICAS
// ==========================================

app.post("/auth/login", login);

app.post("/auth/register", async (req, res) => {
    const { email, password, agencyName, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Datos incompletos" });

    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        const userRole = role || 'agency';
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

// WEBHOOK GHL APP INSTALL
app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const evt = req.body;
        console.log("🔔 Webhook App recibido:", JSON.stringify(evt));

        if (evt.type === "INSTALL") {
            try {
                // 1. Obtener tokens de agencia
                const at = await ensureAgencyToken();
                const ats = await getTokens(AGENCY_ROW_ID);

                // 2. Intercambiar token de ubicación (OAuth) para obtener acceso a la subcuenta
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

                // 3. Guardar tokens de la ubicación en DB
                await saveTokens(evt.locationId, { ...ats, locationAccess: lr.data });

                // 4. Crear Custom Menu (El botón de WhatsApp en la barra lateral de GHL)
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
                        icon: { name: "whatsapp", fontFamily: "fab" }
                    }
                }).then(() => console.log("✅ Custom Menu creado"))
                    .catch((err) => console.error("⚠️ Error menú:", err.response?.data || err.message));

            } catch (errGHL) {
                // Si falla la parte de GHL (tokens/menú), logueamos pero NO detenemos el registro
                // Queremos que al menos quede constancia en nuestra DB.
                console.error("❌ Error flujo GHL (Tokens/Menu):", errGHL.message);
            }

            // --- 5. LÓGICA DE PROTECCIÓN DE LÍMITES (NUEVO) ---
            let statusToRegister = 'active'; // Por defecto activa (si es trial o tiene cupo)

            try {
                // A. Buscamos al dueño de la agencia usando el companyId
                const userRes = await pool.query("SELECT id FROM users WHERE agency_id = $1", [evt.companyId]);

                if (userRes.rows.length > 0) {
                    const userId = userRes.rows[0].id;

                    // B. Preguntamos al guardián si puede crear más tenants
                    // (Esta función la importamos de services/planService.js)
                    const check = await canCreateTenant(userId);

                    if (!check.allowed) {
                        console.warn(`⛔ Bloqueando instalación para ${evt.locationId}: ${check.reason}`);
                        statusToRegister = 'suspended'; // Se registra, pero nace bloqueada (no consume recursos)
                    }
                } else {
                    console.warn(`⚠️ Agencia ${evt.companyId} no encontrada en DB. Se registrará 'active' por defecto.`);
                }
            } catch (errCheck) {
                console.error("Error verificando límites en install:", errCheck);
            }

            // 6. Registrar en DB local (con el estado calculado)
            await registerNewTenant(evt.locationId, evt.companyId, statusToRegister);

            return res.json({ ok: true });
        }

        if (evt.type === "UNINSTALL") {
            console.log(`🗑️ Desinstalación: ${evt.locationId}`);
            // Marcar como cancelado para liberar cupo
            await pool.query("UPDATE tenants SET status = 'cancelled' WHERE location_id = $1", [evt.locationId]);
            return res.json({ ok: true });
        }

        res.json({ ignored: true });

    } catch (e) {
        console.error("Error app-webhook:", e);
        res.status(500).json({ error: "Error procesando webhook" });
    }
});

// WEBHOOK MENSAJERÍA
app.post("/ghl/webhook", async (req, res) => {
    try {
        const { locationId, contactId, phone, message, type, attachments } = req.body;

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

            // --- Lógica de Prioridad y Routing ---
            let prioritySlotId = null;

            if (contactId) {
                try {
                    const contact = await getContact(locationId, contactId);
                    const tags = contact?.tags || [];
                    const priorTag = tags.find(t => t.startsWith("[PRIOR]:"));

                    if (priorTag) {
                        const targetRoutingValue = priorTag.replace("[PRIOR]:", "").trim().toLowerCase();
                        const slotQuery = `SELECT slot_id FROM location_slots WHERE location_id = $1 AND settings->>'routing_tag' = $2`;
                        const slotRes = await pool.query(slotQuery, [locationId, targetRoutingValue]);
                        if (slotRes.rows.length > 0) prioritySlotId = slotRes.rows[0].slot_id;
                    }
                } catch (e) { console.error("Error Priority Routing:", e.message); }
            }

            let realJidUser = null;
            let realSlotId = prioritySlotId;

            if (contactId && !realSlotId) {
                try {
                    const routingRes = await pool.query(
                        "SELECT phone, channel_number FROM phone_routing WHERE contact_id = $1 AND location_id = $2",
                        [contactId, locationId]
                    );
                    if (routingRes.rows.length > 0) {
                        realJidUser = routingRes.rows[0].phone;
                        const botNumber = routingRes.rows[0].channel_number;
                        const slotRes = await pool.query("SELECT slot_id FROM location_slots WHERE location_id=$1 AND phone_number=$2", [locationId, botNumber]);
                        if (slotRes.rows.length > 0) realSlotId = slotRes.rows[0].slot_id;
                    }
                } catch (e) { console.error("Routing error:", e.message); }
            }

            const clientPhone = normalizePhone(phone);
            const jidUser = realJidUser ? realJidUser.replace(/\D/g, "") : clientPhone.replace(/\D/g, "");
            const dbConfigs = await getLocationSlotsConfig(locationId);

            let availableCandidates = dbConfigs.map(conf => ({
                slot: conf.slot_id,
                myNumber: conf.phone_number,
                settings: conf.settings || {},
                session: sessions.get(`${locationId}_slot${conf.slot_id}`)
            })).filter(c => c.session && c.session.isConnected);

            if (availableCandidates.length === 0) return res.status(200).json({ error: "No devices connected" });

            let selected = null;
            let targetJid = null;

            if (realSlotId) selected = availableCandidates.find(c => c.slot === realSlotId);

            if (!selected && !prioritySlotId) {
                const isPotentialGroup = jidUser.startsWith("12036") && jidUser.length >= 17;
                const fuzzyJidPrefix = jidUser.substring(0, 15);

                for (const candidate of availableCandidates) {
                    const groupsConfig = candidate.settings?.groups || {};
                    const foundGroupKey = Object.keys(groupsConfig).find(gKey => {
                        const cleanKey = gKey.replace(/\D/g, "");
                        if (cleanKey === jidUser) return true;
                        if (isPotentialGroup && cleanKey.startsWith(fuzzyJidPrefix)) return true;
                        return false;
                    });

                    if (foundGroupKey && groupsConfig[foundGroupKey].active) {
                        selected = candidate;
                        targetJid = foundGroupKey;
                        break;
                    }
                }
            }

            if (!selected) selected = availableCandidates[0];

            if (!targetJid) {
                const isPotentialGroup = jidUser.startsWith("12036") && jidUser.length >= 17;
                targetJid = isPotentialGroup ? jidUser + "@g.us" : jidUser + "@s.whatsapp.net";
            }

            try {
                await waitForSocketOpen(selected.session.sock);
                let sentMsg;
                const commandData = parseGHLCommand(finalMessage);

                if (commandData) {
                    sentMsg = await sendInteractiveMessage(selected.session.sock, targetJid, commandData);
                } else {
                    if (attachments && attachments.length > 0) {
                        for (const url of attachments) {
                            let content = { image: { url }, caption: finalMessage };
                            if (url.endsWith(".mp4")) content = { video: { url }, caption: finalMessage };
                            else if (url.endsWith(".pdf")) content = { document: { url }, mimetype: "application/pdf", fileName: "doc.pdf", caption: finalMessage };
                            else if (url.endsWith(".ogg") || url.endsWith(".mp3")) content = { audio: { url }, mimetype: "audio/mp4", ptt: true };

                            sentMsg = await selected.session.sock.sendMessage(targetJid, content);
                            if (sentMsg?.key?.id) botMessageIds.add(sentMsg.key.id);
                        }
                    } else {
                        if (finalMessage && finalMessage.trim().length > 0) {
                            sentMsg = await selected.session.sock.sendMessage(targetJid, { text: finalMessage });
                        }
                    }
                }

                if (sentMsg?.key?.id) botMessageIds.add(sentMsg.key.id);

                if (!contactId && !prioritySlotId) {
                    const contact = await findOrCreateGHLContact(locationId, clientPhone, "System Outbound", null, true);
                    if (contact?.id) await saveRouting(clientPhone, locationId, contact.id, selected.myNumber);
                }

                return res.json({ ok: true });

            } catch (e) {
                console.error("Error envío:", e.message);
                return res.status(500).json({ error: "Send failed: " + e.message });
            }
        }
        res.json({ ignored: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error processing webhook" });
    }
});

// ==========================================
// 🔐 RUTAS PROTEGIDAS (Agencia/Admin)
// ==========================================

// ✅ NUEVO: Obtener información de la cuenta (Plan, Límites, Estado)
app.get("/agency/info", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            "SELECT email, plan_status, trial_ends_at, max_subagencies, max_slots FROM users WHERE id = $1",
            [userId]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

        const user = result.rows[0];

        // Calculamos uso actual (para mostrar barras de progreso)
        const usageRes = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM tenants WHERE agency_id = $1 AND status != 'cancelled') as used_subagencies,
                (SELECT COUNT(*) FROM location_slots s JOIN tenants t ON s.location_id = t.location_id WHERE t.agency_id = $1) as used_slots
        `, [req.user.agencyId]); // Asegúrate que el token tenga agencyId, si no usa user.agency_id buscando de nuevo

        // Pequeño fix si el token no tiene agencyId directo, lo buscamos del user
        // (Ya lo hicimos en el query anterior, pero para el count usamos el del user obtenido)
        // Simplificamos: usamos una sola query con CTE o joins, pero para no complicar:

        // Mejor opción robusta:
        const agencyIdRes = await pool.query("SELECT agency_id FROM users WHERE id = $1", [userId]);
        const agencyId = agencyIdRes.rows[0].agency_id;

        const subCount = await pool.query("SELECT COUNT(*) FROM tenants WHERE agency_id = $1 AND status != 'cancelled'", [agencyId]);
        const slotCount = await pool.query("SELECT COUNT(*) FROM location_slots s JOIN tenants t ON s.location_id = t.location_id WHERE t.agency_id = $1", [agencyId]);

        res.json({
            plan: user.plan_status,
            trial_ends: user.trial_ends_at,
            limits: {
                max_subagencies: user.max_subagencies,
                max_slots: user.max_slots,
                used_subagencies: parseInt(subCount.rows[0].count),
                used_slots: parseInt(slotCount.rows[0].count)
            }
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// ✅ RUTAS DE PAGO
app.post("/payments/subscribe", verifyToken, subscribe);
app.post("/payments/portal", verifyToken, manageBilling);

// ✅ ENDPOINT ADD-SLOT PROTEGIDO (Límites de Plan)
app.post("/agency/add-slot", verifyToken, async (req, res) => {
    const { locationId } = req.body;
    const userId = req.user.id;

    // 1. VERIFICACIÓN DE LÍMITES
    const check = await canAddSlot(userId);
    if (!check.allowed) {
        return res.status(403).json({ error: check.reason });
    }

    try {
        const resSlots = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1 ORDER BY slot_id ASC", [locationId]);
        const ids = resSlots.rows.map(r => r.slot_id);
        let newId = 1;
        while (ids.includes(newId)) newId++;
        // Límite técnico por ubicación (no confundir con límite de plan)
        if (newId > 10) return res.status(400).json({ error: "Límite técnico de 10 slots por ubicación alcanzado." });

        await pool.query("INSERT INTO location_slots (location_id, slot_id, slot_name, priority) VALUES ($1, $2, $3, $4)", [locationId, newId, `Dispositivo #${newId}`, newId]);
        res.json({ success: true, slot_id: newId, slot_name: `Dispositivo #${newId}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/agency/slots/:locationId/:slotId/groups", verifyToken, async (req, res) => {
    try {
        const { locationId, slotId } = req.params;
        const groups = await getGroups(locationId, slotId);
        res.json(groups);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/agency/slots/:locationId/:slotId/groups/sync-members", verifyToken, async (req, res) => {
    try {
        const { locationId, slotId } = req.params;
        const { groupJid } = req.body;
        syncGroupMembers(locationId, slotId, groupJid)
            .then(r => console.log(`✅ Miembros sincronizados: ${r.synced}`))
            .catch(e => console.error("❌ Error background sync:", e));
        res.json({ success: true, message: "Sincronización iniciada en segundo plano." });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/agency/sync-ghl", verifyToken, async (req, res) => {
    const { locationIdToVerify } = req.body;
    const userId = req.user.id;
    if (!locationIdToVerify) return res.status(400).json({ error: "Falta Location ID" });
    try {
        await pool.query("UPDATE users SET agency_id = $1 WHERE id = $2", [locationIdToVerify, userId]);
        res.json({ success: true, newAgencyId: locationIdToVerify });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/agency/ghl-users/:locationId", verifyToken, async (req, res) => {
    try {
        const { locationId } = req.params;
        const users = await getLocationUsers(locationId);
        res.json(users);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/agency/locations", verifyToken, async (req, res) => {
    const { agencyId } = req.query;
    if (req.user.role === 'agency') {
        try {
            const userRes = await pool.query("SELECT agency_id FROM users WHERE id = $1", [req.user.id]);
            const myAgencyId = userRes.rows[0]?.agency_id;
            if (!myAgencyId || myAgencyId.startsWith('AG-')) return res.json([]);
            const result = await pool.query(`SELECT t.location_id, t.name, t.status, t.settings, (SELECT COUNT(*) FROM location_slots s WHERE s.location_id = t.location_id) as total_slots FROM tenants t WHERE t.agency_id = $1`, [myAgencyId]);
            return res.json(result.rows);
        } catch (e) { return res.status(500).json({ error: e.message }); }
    }
    if (!agencyId) return res.status(400).json({ error: "Falta agencyId" });
    try {
        const result = await pool.query(`SELECT t.location_id, t.name, t.status, t.settings, (SELECT COUNT(*) FROM location_slots s WHERE s.location_id = t.location_id) as total_slots FROM tenants t WHERE t.agency_id = $1`, [agencyId]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/agency/slots/:locationId/:slotId", verifyToken, async (req, res) => {
    try {
        await deleteSessionData(req.params.locationId, req.params.slotId, true);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/agency/slots/:locationId/:slotId/settings", verifyToken, async (req, res) => {
    try {
        const { locationId, slotId } = req.params;
        const { settings } = req.body;
        await pool.query("UPDATE location_slots SET settings = $1::jsonb WHERE location_id = $2 AND slot_id = $3", [JSON.stringify(settings), locationId, slotId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/agency/update-slot-config", verifyToken, async (req, res) => {
    const { locationId, slotId, priority, assignedUser } = req.body;
    try {
        if (priority) {
            const currentRes = await pool.query("SELECT priority FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slotId]);
            const oldPriority = currentRes.rows[0]?.priority || 99;
            const targetRes = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1 AND priority = $2", [locationId, priority]);
            if (targetRes.rows.length > 0) {
                const targetSlotId = targetRes.rows[0].slot_id;
                await pool.query("UPDATE location_slots SET priority = $1 WHERE location_id = $2 AND slot_id = $3", [oldPriority, locationId, targetSlotId]);
            }
            await pool.query("UPDATE location_slots SET priority = $1 WHERE location_id = $2 AND slot_id = $3", [priority, locationId, slotId]);
        }
        if (assignedUser !== undefined) {
            const setRes = await pool.query("SELECT settings FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slotId]);
            let currentSettings = setRes.rows[0]?.settings || {};
            currentSettings.ghl_assigned_user = assignedUser;
            await pool.query("UPDATE location_slots SET settings = $1::jsonb WHERE location_id = $2 AND slot_id = $3", [JSON.stringify(currentSettings), locationId, slotId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/agency/location-details/:locationId", verifyToken, async (req, res) => {
    const { locationId } = req.params;
    try {
        const [slots, keys, tenant] = await Promise.all([
            pool.query("SELECT * FROM location_slots WHERE location_id=$1 ORDER BY priority ASC", [locationId]),
            pool.query("SELECT * FROM keyword_tags WHERE location_id=$1 ORDER BY created_at DESC", [locationId]),
            pool.query("SELECT name FROM tenants WHERE location_id=$1", [locationId])
        ]);
        res.json({ slots: slots.rows, keywords: keys.rows, name: tenant.rows[0]?.name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/agency/keywords", verifyToken, async (req, res) => {
    try {
        const { locationId, slotId, keyword, tag } = req.body;
        const r = await pool.query("INSERT INTO keyword_tags (location_id, slot_id, keyword, tag) VALUES ($1, $2, $3, $4) RETURNING *", [locationId, slotId || null, keyword.toLowerCase(), tag]);
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/agency/keywords/:id", verifyToken, async (req, res) => {
    try { await pool.query("DELETE FROM keyword_tags WHERE id=$1", [req.params.id]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/agency/settings/:locationId", verifyToken, async (req, res) => {
    try { await pool.query("UPDATE tenants SET settings=$1::jsonb WHERE location_id=$2", [JSON.stringify(req.body.settings), req.params.locationId]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 🛠️ RUTAS GESTIÓN BOT DE SOPORTE
// ==========================================

app.post("/admin/support/start", verifyToken, requireRole('admin'), async (req, res) => {
    try { await startWhatsApp(SUPPORT_LOC_ID, SUPPORT_SLOT_ID); res.json({ success: true, message: "Iniciando proceso de conexión..." }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/support/qr", verifyToken, requireRole('admin'), (req, res) => {
    const session = sessions.get(`${SUPPORT_LOC_ID}_slot${SUPPORT_SLOT_ID}`);
    if (session && session.qr) res.json({ qr: session.qr }); else res.status(404).json({ error: "QR no disponible o ya conectado" });
});

app.get("/admin/support/status", verifyToken, requireRole('admin'), async (req, res) => {
    const session = sessions.get(`${SUPPORT_LOC_ID}_slot${SUPPORT_SLOT_ID}`);
    let dbInfo = {};
    try { const r = await pool.query("SELECT phone_number FROM location_slots WHERE location_id=$1 AND slot_id=$2", [SUPPORT_LOC_ID, SUPPORT_SLOT_ID]); if (r.rows.length) dbInfo = r.rows[0]; } catch (e) { }
    res.json({ connected: session?.isConnected || false, myNumber: session?.myNumber || dbInfo.phone_number, is_active: true });
});

app.delete("/admin/support/disconnect", verifyToken, requireRole('admin'), async (req, res) => {
    try { await deleteSessionData(SUPPORT_LOC_ID, SUPPORT_SLOT_ID); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 🌍 RUTAS PÚBLICAS IFRAME
// ==========================================

app.get("/public/ghl-users", async (req, res) => {
    try {
        const { locationId } = req.query;
        if (!locationId) return res.status(400).json({ error: "Falta locationId" });
        const users = await getLocationUsers(locationId);
        res.json(users.map(u => ({ id: u.id, name: u.name })));
    } catch (e) { res.status(500).json({ error: "Error obteniendo usuarios" }); }
});

app.post("/public/update-slot-config", async (req, res) => {
    const { locationId, slotId, priority, assignedUser } = req.body;
    try {
        if (priority) {
            const currentRes = await pool.query("SELECT priority FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slotId]);
            const oldPriority = currentRes.rows[0]?.priority || 99;
            const targetRes = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1 AND priority = $2", [locationId, priority]);
            if (targetRes.rows.length > 0) {
                const targetSlotId = targetRes.rows[0].slot_id;
                await pool.query("UPDATE location_slots SET priority = $1 WHERE location_id = $2 AND slot_id = $3", [oldPriority, locationId, targetSlotId]);
            }
            await pool.query("UPDATE location_slots SET priority = $1 WHERE location_id = $2 AND slot_id = $3", [priority, locationId, slotId]);
        }
        if (assignedUser !== undefined) {
            const setRes = await pool.query("SELECT settings FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, slotId]);
            let currentSettings = setRes.rows[0]?.settings || {};
            currentSettings.ghl_assigned_user = assignedUser;
            await pool.query("UPDATE location_slots SET settings = $1::jsonb WHERE location_id = $2 AND slot_id = $3", [JSON.stringify(currentSettings), locationId, slotId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/start-whatsapp", async (req, res) => {
    try { await startWhatsApp(req.query.locationId, req.query.slot); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: "Error" }); }
});

app.get("/qr", (req, res) => {
    const s = sessions.get(`${req.query.locationId}_slot${req.query.slot}`);
    if (s && s.qr) res.json({ qr: s.qr }); else res.status(404).json({ error: "No QR" });
});

app.get("/status", async (req, res) => {
    const s = sessions.get(`${req.query.locationId}_slot${req.query.slot}`);
    let extra = {};
    try { const r = await pool.query("SELECT * FROM location_slots WHERE location_id=$1 AND slot_id=$2", [req.query.locationId, req.query.slot]); if (r.rows.length) extra = r.rows[0]; } catch (e) { }
    res.json({ connected: s?.isConnected || false, myNumber: s?.myNumber, slotName: extra.slot_name, priority: extra.priority, settings: extra.settings });
});

app.post("/remove-slot", async (req, res) => {
    try {
        const locationId = req.query.locationId;
        const slot = req.query.slot;
        if (!locationId || !slot) return res.status(400).json({ error: "Faltan parámetros" });
        await deleteSessionData(locationId, slot);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error al desconectar" }); }
});

app.post("/config-slot", async (req, res) => {
    try {
        await pool.query(`INSERT INTO location_slots (location_id, slot_id, slot_name) VALUES ($1, $2, $3) ON CONFLICT (location_id, slot_id) DO UPDATE SET slot_name = EXCLUDED.slot_name`, [req.body.locationId, req.body.slot, req.body.slotName]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/config", async (req, res) => {
    try {
        const { locationId } = req.query;
        const tenantStatus = await getTenantConfig(locationId);
        const slotsRes = await pool.query("SELECT slot_id, slot_name, phone_number, priority, settings FROM location_slots WHERE location_id = $1 ORDER BY priority ASC", [locationId]);
        res.json({
            is_active: tenantStatus.active,
            reason: tenantStatus.reason,
            slots: slotsRes.rows.map(s => ({
                id: s.slot_id,
                name: s.slot_name,
                connected: !!s.phone_number,
                priority: s.priority,
                settings: s.settings
            }))
        });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});
// ==========================================
// 📊 INFO DE CUENTA Y LÍMITES (Faltaba esto)
// ==========================================

app.get("/agency/info", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Obtener datos del usuario (Plan y Límites)
        const result = await pool.query(
            "SELECT email, plan_status, trial_ends_at, max_subagencies, max_slots, agency_id FROM users WHERE id = $1",
            [userId]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

        const user = result.rows[0];
        const agencyId = user.agency_id;

        // 2. Calcular uso actual (Contar subagencias y slots ocupados)
        const subCount = await pool.query(
            "SELECT COUNT(*) FROM tenants WHERE agency_id = $1 AND status != 'cancelled'",
            [agencyId]
        );

        // Join para contar slots totales de esta agencia
        const slotCount = await pool.query(`
            SELECT COUNT(*) 
            FROM location_slots s 
            JOIN tenants t ON s.location_id = t.location_id 
            WHERE t.agency_id = $1
        `, [agencyId]);

        // 3. Responder al Frontend
        res.json({
            plan: user.plan_status,
            trial_ends: user.trial_ends_at,
            limits: {
                max_subagencies: user.max_subagencies || 1,
                max_slots: user.max_slots || 5,
                used_subagencies: parseInt(subCount.rows[0].count) || 0,
                used_slots: parseInt(slotCount.rows[0].count) || 0
            }
        });

    } catch (e) {
        console.error("Error en /agency/info:", e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 👑 RUTAS ADMIN (Gestión General)
// ==========================================

app.get("/admin/agencies", verifyToken, requireRole('admin'), async (req, res) => {
    const q = `
        SELECT agency_id, MAX(agency_name) as agency_name, COUNT(*) as total_subaccounts, COUNT(CASE WHEN status = 'active' THEN 1 END) as active_subaccounts
        FROM tenants WHERE agency_id IS NOT NULL GROUP BY agency_id
    `;
    const r = await pool.query(q);
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
        startMediaCleanup();
        app.listen(PORT, async () => {
            console.log(`API OK ${PORT}`);
            await restoreSessions();
        });
    } catch (e) {
        console.error("❌ Error fatal al iniciar:", e);
        process.exit(1);
    }
})();