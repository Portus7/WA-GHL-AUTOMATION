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
    callGHLWithLocation,
    findOrCreateGHLContact,
    logMessageToGHL,
    addTagToContact,
    assignContactOwner,
    getLocationUsers,
    getContact
} = require("./services/ghlService");

// --- SERVICIOS DE PAGO Y PLANES ---
const { subscribe, manageBilling, updatePlan } = require("./controllers/paymentController");
const { handleWebhook } = require("./controllers/webhookController");
const { canAddSlot, canCreateTenant } = require("./services/planService");
const { handleIncomingMessage, processKeywordTags } = require("./services/messageHandler");
const { normalizePhone, processAdvancedMessage, sleep } = require("./helpers/utils");
const { parseGHLCommand } = require("./helpers/parser");
const axios = require("axios");

// Polyfill Crypto
if (!globalThis.crypto) {
    globalThis.crypto = require("crypto").webcrypto;
}

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA = process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
const AGENCY_ROW_ID = "__AGENCY__";

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");

const ALLOWED_ORIGINS = [
    "https://app.gohighlevel.com",
    "https://services.leadconnectorhq.com",
    "https://leadconnectorhq.com",
    "https://wa.clicandapp.com",
    process.env.API_PUBLIC_URL_FRONT, // Tu frontend administrativo
    // Agrega aquí otros dominios de GHL si usas marca blanca (ej: app.tudominio.com)
];

if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

const app = express();

app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

// ✅ Confiar en el proxy (Nginx/Docker)
app.set('trust proxy', 1);

// ==========================================
// 💳 WEBHOOK DE STRIPE (CRÍTICO: ANTES DE JSON)
// ==========================================
// Stripe necesita el cuerpo en crudo (Buffer) para validar la firma.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), handleWebhook);

// ==========================================
// ⚙️ MIDDLEWARES GLOBALES
// ==========================================
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.static(PUBLIC_DIR));

app.use(cors({
    origin: function (origin, callback) {
        // Permitir peticiones sin origen (como móviles o curl) SOLO si no es navegador,
        // pero para mayor seguridad en API pública, mejor filtrar estrictamente.
        if (!origin) return callback(null, true);

        if (ALLOWED_ORIGINS.some(domain => origin.includes(domain)) || origin.includes("localhost")) {
            callback(null, true);
        } else {
            console.warn(`⛔ Bloqueo CORS para origen: ${origin}`);
            callback(new Error('No permitido por CORS'));
        }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));


const requireIframeSecurity = (req, res, next) => {
    const origin = req.headers['origin'] || req.headers['referer'];
    const isAllowed = origin && (
        ALLOWED_ORIGINS.some(domain => origin.includes(domain)) ||
        origin.includes("localhost")
    );

    if (!isAllowed) {
        return res.status(403).json({ error: "Acceso denegado: Origen no autorizado." });
    }
    next();
};

// ==========================================
// 🛡️ RATE LIMITING
// ==========================================
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Demasiados intentos." } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200, message: { error: "Límite excedido." } });
const pollingLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 150, message: { error: "Demasiadas consultas." } });

app.use("/auth/", authLimiter);
app.use("/ghl/", apiLimiter);
app.use("/agency/", apiLimiter);
app.use("/admin/", apiLimiter);
app.use("/payments/", apiLimiter);
app.use("/status", pollingLimiter);
app.use("/qr", pollingLimiter);

// ==========================================
// 🔓 RUTAS PÚBLICAS
// ==========================================

app.post("/auth/login", login);

app.post("/auth/register", async (req, res) => {
    const { email, password, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Datos incompletos" });
    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        const userRole = role || 'agency';
        const agencyId = userRole === 'agency' ? `AG-${Date.now()}` : null;
        const newUser = await pool.query("INSERT INTO users (email, password_hash, role, agency_id) VALUES ($1, $2, $3, $4) RETURNING id, email, role, agency_id", [email, hash, userRole, agencyId]);
        res.json({ success: true, user: newUser.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// WEBHOOK GHL APP INSTALL
app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const evt = req.body;
        console.log("🔔 Webhook App recibido:", JSON.stringify(evt));

        if (evt.type === "INSTALL") {
            if (!evt.locationId) {
                console.log("ℹ️ Instalación de Agencia detectada. Omitiendo.");
                return res.json({ ok: true });
            }

            try {
                // 1. Tokens y Menú (Tu código actual)
                const at = await ensureAgencyToken();
                const ats = await getTokens(AGENCY_ROW_ID);
                const lr = await axios.post("https://services.leadconnectorhq.com/oauth/locationToken", new URLSearchParams({ companyId: evt.companyId, locationId: evt.locationId }).toString(), { headers: { Authorization: `Bearer ${at}`, Version: GHL_API_VERSION, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
                await saveTokens(evt.locationId, { ...ats, locationAccess: lr.data });
                await callGHLWithAgency({ method: "post", url: "https://services.leadconnectorhq.com/custom-menus/", data: { title: "WhatsApp - Clic&App", url: `${CUSTOM_MENU_URL_WA}?location_id=${evt.locationId}`, showOnCompany: false, showOnLocation: true, showToAllLocations: false, locations: [evt.locationId], openMode: "iframe", userRole: "all", allowCamera: false, allowMicrophone: false, icon: { name: "whatsapp", fontFamily: "fab" } } });
            } catch (errGHL) { console.error("❌ Error flujo GHL:", errGHL.message); }

            // 2. 🔥 DEFINIR VARIABLES FALTANTES (ESTO FALTABA)
            let locationName = null;
            try {
                const locData = await callGHLWithLocation(evt.locationId, { method: "GET", url: `https://services.leadconnectorhq.com/locations/${evt.locationId}` });
                locationName = locData.data.location?.name || locData.data?.name;
            } catch (e) { console.warn("⚠️ No se pudo obtener nombre subcuenta"); }

            const agencyName = evt.companyName || "Agencia Desconocida";

            // 3. Límites (Tu código actual)
            let statusToRegister = 'active';
            let assignedSubscriptionId = null;
            try {
                const userRes = await pool.query("SELECT id FROM users WHERE agency_id = $1", [evt.companyId]);
                if (userRes.rows.length > 0) {
                    const check = await canCreateTenant(userRes.rows[0].id);
                    if (!check.allowed) {
                        console.warn(`⛔ Bloqueo por límites: ${check.reason}`);
                        statusToRegister = 'suspended';
                    } else {
                        assignedSubscriptionId = check.subscriptionId;
                    }
                }
            } catch (errCheck) { console.error("Error límites:", errCheck); }

            // 4. Registro Final (Ahora las variables SÍ existen)
            await registerNewTenant(evt.locationId, evt.companyId, statusToRegister, assignedSubscriptionId, locationName, agencyName);

            return res.json({ ok: true });
        }

        if (evt.type === "UNINSTALL") {
            await pool.query("UPDATE tenants SET status = 'cancelled' WHERE location_id = $1", [evt.locationId]);
            return res.json({ ok: true });
        }
        res.json({ ignored: true });

    } catch (e) {
        console.error("❌ Error FATAL Webhook:", e); // 🔥 Agregado log para ver errores futuros
        res.status(500).json({ error: "Error procesando webhook" });
    }
});

// WEBHOOK MENSAJERÍA (Con {{W#ID}} y Favoritos)
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

            // ============================================================
            // 👑 PASO 0: ROUTING FORZADO DINÁMICO (COMANDO {{W#ID}})
            // ============================================================
            const wCommandRegex = /\{\{W#(\d+)\}\}/;
            const wMatch = finalMessage.match(wCommandRegex);
            let forcedSlotId = null;

            if (wMatch) {
                const targetId = parseInt(wMatch[1]);
                finalMessage = finalMessage.replace(wMatch[0], "").trim();
                const slotCheck = await pool.query("SELECT slot_id, phone_number FROM location_slots WHERE location_id = $1 AND slot_id = $2", [locationId, targetId]);
                if (slotCheck.rows.length > 0) {
                    forcedSlotId = targetId;
                    const forcedNumber = slotCheck.rows[0].phone_number;
                    const clientPhoneForDb = normalizePhone(phone);
                    await pool.query(`INSERT INTO phone_routing (phone, location_id, contact_id, channel_number, updated_at, messages_count) VALUES ($1, $2, $3, $4, NOW(), 1) ON CONFLICT (phone) DO UPDATE SET channel_number = EXCLUDED.channel_number, updated_at = NOW()`, [clientPhoneForDb, locationId, contactId || null, forcedNumber]);
                }
            }

            // ============================================================
            // 🏷️ PASO 1: ENRUTAMIENTO PRIORITARIO POR TAGS
            // ============================================================
            let prioritySlotId = null;
            if (contactId && !forcedSlotId) {
                try {
                    const contact = await getContact(locationId, contactId);
                    const tags = contact?.tags || [];
                    const priorTag = tags.find(t => t.startsWith("[PRIOR]:"));
                    if (priorTag) {
                        const targetVal = priorTag.replace("[PRIOR]:", "").trim().toLowerCase();
                        const slotRes = await pool.query(`SELECT slot_id FROM location_slots WHERE location_id = $1 AND settings->>'routing_tag' = $2`, [locationId, targetVal]);
                        if (slotRes.rows.length > 0) prioritySlotId = slotRes.rows[0].slot_id;
                    }
                } catch (e) { }
            }

            // ============================================================
            // 🧠 PASO 2: RECUPERAR ID REAL DESDE DB (HISTORIAL)
            // ============================================================
            let realJidUser = null;
            let realSlotId = forcedSlotId || prioritySlotId;
            if (contactId && !realSlotId) {
                try {
                    const routingRes = await pool.query("SELECT phone, channel_number FROM phone_routing WHERE contact_id = $1 AND location_id = $2", [contactId, locationId]);
                    if (routingRes.rows.length > 0) {
                        realJidUser = routingRes.rows[0].phone;
                        const botNumber = routingRes.rows[0].channel_number;
                        const slotRes = await pool.query("SELECT slot_id FROM location_slots WHERE location_id=$1 AND phone_number=$2", [locationId, botNumber]);
                        if (slotRes.rows.length > 0) realSlotId = slotRes.rows[0].slot_id;
                    }
                } catch (e) { }
            }

            const clientPhone = normalizePhone(phone);
            const jidUser = realJidUser ? realJidUser.replace(/\D/g, "") : clientPhone.replace(/\D/g, "");
            const dbConfigs = await getLocationSlotsConfig(locationId);

            let availableCandidates = dbConfigs.map(conf => ({
                slot: conf.slot_id,
                myNumber: conf.phone_number,
                is_favorite: conf.is_favorite, // ✅ Importante para Paso 3
                settings: conf.settings || {},
                session: sessions.get(`${locationId}_slot${conf.slot_id}`)
            })).filter(c => c.session && c.session.isConnected);

            if (availableCandidates.length === 0) return res.status(200).json({ error: "No devices connected" });

            let selected = null;
            let targetJid = null;

            // --- PASO 3: SELECCIÓN FINAL DEL SLOT ---

            // 3.1 Intentar por Historial o Forzado
            if (realSlotId) selected = availableCandidates.find(c => c.slot === realSlotId);

            // 3.2 ⭐ Si no hay selección, buscar FAVORITO
            if (!selected && !forcedSlotId && !prioritySlotId) {
                selected = availableCandidates.find(c => c.is_favorite);
            }

            // 3.3 Fallback a Grupos
            if (!selected && !forcedSlotId) {
                const isPotentialGroup = jidUser.startsWith("12036") && jidUser.length >= 17;
                const fuzzyJidPrefix = jidUser.substring(0, 15);
                for (const candidate of availableCandidates) {
                    const groupsConfig = candidate.settings?.groups || {};
                    const foundGroupKey = Object.keys(groupsConfig).find(gKey => {
                        const cleanKey = gKey.replace(/\D/g, "");
                        return cleanKey === jidUser || (isPotentialGroup && cleanKey.startsWith(fuzzyJidPrefix));
                    });
                    if (foundGroupKey && groupsConfig[foundGroupKey].active) {
                        selected = candidate;
                        targetJid = foundGroupKey;
                        break;
                    }
                }
            }

            // 3.4 Fallback Final (El primero de la lista)
            if (!selected) selected = availableCandidates[0];

            if (!targetJid) targetJid = (jidUser.startsWith("12036") && jidUser.length >= 17) ? jidUser + "@g.us" : jidUser + "@s.whatsapp.net";

            if (contactId && finalMessage) {
                processKeywordTags(locationId, contactId, finalMessage, selected.slot, false)
                    .catch(e => console.error("⚠️ Error procesando keywords en GHL Outbound:", e.message));
            }

            try {
                await waitForSocketOpen(selected.session.sock);
                let sentMsg;
                const commandData = parseGHLCommand(finalMessage);
                const isEmptyMessage = (!finalMessage || finalMessage.trim().length === 0) && (!attachments || attachments.length === 0) && !commandData;

                if (!isEmptyMessage) {
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
                            }
                        } else {
                            sentMsg = await selected.session.sock.sendMessage(targetJid, { text: finalMessage });
                        }
                    }
                    if (sentMsg?.key?.id) botMessageIds.set(sentMsg.key.id, Date.now());
                }

                if (!contactId && !forcedSlotId && !prioritySlotId) {
                    const contact = await findOrCreateGHLContact(locationId, clientPhone, "System Outbound", null, true);
                    if (contact?.id) await saveRouting(clientPhone, locationId, contact.id, selected.myNumber);
                }
                return res.json({ ok: true });
            } catch (e) { return res.status(500).json({ error: "Send failed: " + e.message }); }
        }
        res.json({ ignored: true });
    } catch (e) { res.status(500).json({ error: "Error processing webhook" }); }
});

// ==========================================
// 🔐 RUTAS PROTEGIDAS (Agencia/Admin)
// ==========================================

// ✅ INFO CUENTA
app.get("/agency/info", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query("SELECT email, plan_status, trial_ends_at, max_subagencies, max_slots, agency_id FROM users WHERE id = $1", [userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });
        const user = result.rows[0];
        const agencyId = user.agency_id;
        const subCount = await pool.query("SELECT COUNT(*) FROM tenants WHERE agency_id = $1 AND status != 'cancelled'", [agencyId]);
        const slotCount = await pool.query(`SELECT COUNT(*) FROM location_slots s JOIN tenants t ON s.location_id = t.location_id WHERE t.agency_id = $1`, [agencyId]);
        res.json({
            plan: user.plan_status, trial_ends: user.trial_ends_at,
            limits: { max_subagencies: user.max_subagencies || 1, max_slots: user.max_slots || 5, used_subagencies: parseInt(subCount.rows[0].count) || 0, used_slots: parseInt(slotCount.rows[0].count) || 0 }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ PAGOS
app.post("/payments/subscribe", verifyToken, subscribe);
app.post("/payments/portal", verifyToken, manageBilling);

// ✅ ADD SLOT CON LÍMITES
app.post("/agency/add-slot", verifyToken, async (req, res) => {
    const { locationId } = req.body;
    const check = await canAddSlot(req.user.id);
    if (!check.allowed) return res.status(403).json({ error: check.reason });
    try {
        const resSlots = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1 ORDER BY slot_id ASC", [locationId]);
        const ids = resSlots.rows.map(r => r.slot_id);
        let newId = 1;
        while (ids.includes(newId)) newId++;
        if (newId > 10) return res.status(400).json({ error: "Límite técnico de 10 slots alcanzado." });
        await pool.query("INSERT INTO location_slots (location_id, slot_id, slot_name, priority) VALUES ($1, $2, $3, $4)", [locationId, newId, `Dispositivo #${newId}`, newId]);
        res.json({ success: true, slot_id: newId, slot_name: `Dispositivo #${newId}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ UPDATE CONFIG (Con isFavorite)
app.post("/agency/update-slot-config", verifyToken, async (req, res) => {
    const { locationId, slotId, priority, assignedUser, isFavorite } = req.body;
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
        if (isFavorite !== undefined) {
            if (isFavorite === true) await pool.query("UPDATE location_slots SET is_favorite = false WHERE location_id = $1", [locationId]);
            await pool.query("UPDATE location_slots SET is_favorite = $1 WHERE location_id = $2 AND slot_id = $3", [isFavorite, locationId, slotId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ... Otros endpoints de gestión (slots, keywords, settings, admin/support)
app.get("/agency/slots/:locationId/:slotId/groups", verifyToken, async (req, res) => {
    try { const { locationId, slotId } = req.params; const groups = await getGroups(locationId, slotId); res.json(groups); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/agency/slots/:locationId/:slotId/groups/sync-members", verifyToken, async (req, res) => {
    try { const { locationId, slotId } = req.params; const { groupJid } = req.body; syncGroupMembers(locationId, slotId, groupJid).then(r => console.log(`✅ Sync: ${r.synced}`)).catch(e => console.error("❌ Sync:", e)); res.json({ success: true, message: "Sync iniciada." }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/agency/sync-ghl", verifyToken, async (req, res) => {
    const { locationIdToVerify } = req.body; const userId = req.user.id; if (!locationIdToVerify) return res.status(400).json({ error: "Falta Location ID" }); try { await pool.query("UPDATE users SET agency_id = $1 WHERE id = $2", [locationIdToVerify, userId]); res.json({ success: true, newAgencyId: locationIdToVerify }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/agency/ghl-users/:locationId", verifyToken, async (req, res) => {
    try { const { locationId } = req.params; const users = await getLocationUsers(locationId); res.json(users); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/agency/locations", verifyToken, async (req, res) => {
    const { agencyId } = req.query; if (req.user.role === 'agency') { try { const userRes = await pool.query("SELECT agency_id FROM users WHERE id = $1", [req.user.id]); const myAgencyId = userRes.rows[0]?.agency_id; if (!myAgencyId || myAgencyId.startsWith('AG-')) return res.json([]); const result = await pool.query(`SELECT t.location_id, t.name, t.status, t.settings, (SELECT COUNT(*) FROM location_slots s WHERE s.location_id = t.location_id) as total_slots FROM tenants t WHERE t.agency_id = $1`, [myAgencyId]); return res.json(result.rows); } catch (e) { return res.status(500).json({ error: e.message }); } }
    if (!agencyId) return res.status(400).json({ error: "Falta agencyId" }); try { const result = await pool.query(`SELECT t.location_id, t.name, t.status, t.settings, (SELECT COUNT(*) FROM location_slots s WHERE s.location_id = t.location_id) as total_slots FROM tenants t WHERE t.agency_id = $1`, [agencyId]); res.json(result.rows); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/agency/slots/:locationId/:slotId", verifyToken, async (req, res) => {
    try { await deleteSessionData(req.params.locationId, req.params.slotId, true); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/agency/slots/:locationId/:slotId/settings", verifyToken, async (req, res) => {
    try { await pool.query("UPDATE location_slots SET settings = $1::jsonb WHERE location_id = $2 AND slot_id = $3", [JSON.stringify(req.body.settings), req.params.locationId, req.params.slotId]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/agency/location-details/:locationId", verifyToken, async (req, res) => {
    const { locationId } = req.params; try { const [slots, keys, tenant] = await Promise.all([pool.query("SELECT * FROM location_slots WHERE location_id=$1 ORDER BY priority ASC", [locationId]), pool.query("SELECT * FROM keyword_tags WHERE location_id=$1 ORDER BY created_at DESC", [locationId]), pool.query("SELECT name FROM tenants WHERE location_id=$1", [locationId])]); res.json({ slots: slots.rows, keywords: keys.rows, name: tenant.rows[0]?.name }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/agency/keywords", verifyToken, async (req, res) => {
    try { const { locationId, slotId, keyword, tag } = req.body; const r = await pool.query("INSERT INTO keyword_tags (location_id, slot_id, keyword, tag) VALUES ($1, $2, $3, $4) RETURNING *", [locationId, slotId || null, keyword.toLowerCase(), tag]); res.json(r.rows[0]); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/agency/keywords/:id", verifyToken, async (req, res) => {
    try { await pool.query("DELETE FROM keyword_tags WHERE id=$1", [req.params.id]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/agency/settings/:locationId", verifyToken, async (req, res) => {
    try { await pool.query("UPDATE tenants SET settings=$1::jsonb WHERE location_id=$2", [JSON.stringify(req.body.settings), req.params.locationId]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ ELIMINAR SUBCUENTA COMPLETA (Liberar Licencia)
app.delete("/agency/tenants/:locationId", verifyToken, async (req, res) => {
    const { locationId } = req.params;

    // Seguridad: Verificar que la location pertenece a la agencia del usuario
    const userId = req.user.id;
    try {
        const userRes = await pool.query("SELECT agency_id FROM users WHERE id = $1", [userId]);
        const myAgencyId = userRes.rows[0]?.agency_id;

        // Verificar propiedad
        const tenantRes = await pool.query("SELECT agency_id FROM tenants WHERE location_id = $1", [locationId]);
        if (tenantRes.rows.length === 0) return res.status(404).json({ error: "Subcuenta no encontrada" });

        if (tenantRes.rows[0].agency_id !== myAgencyId && req.user.role !== 'admin') {
            return res.status(403).json({ error: "No tienes permiso sobre esta subcuenta" });
        }

        console.log(`🗑️ Eliminando subcuenta y liberando recursos: ${locationId}`);

        // 1. Obtener y desconectar todos los slots activos
        const slotsRes = await pool.query("SELECT slot_id FROM location_slots WHERE location_id = $1", [locationId]);
        for (const row of slotsRes.rows) {
            await deleteSessionData(locationId, row.slot_id, true); // true = borrar slot de DB
        }

        // 2. Eliminar datos asociados (Routing, Keywords, Auth)
        await pool.query("DELETE FROM phone_routing WHERE location_id = $1", [locationId]);
        await pool.query("DELETE FROM keyword_tags WHERE location_id = $1", [locationId]);
        await pool.query("DELETE FROM auth_db WHERE locationid = $1", [locationId]);

        // 3. Finalmente eliminar el Tenant (Esto libera el cupo en el conteo)
        await pool.query("DELETE FROM tenants WHERE location_id = $1", [locationId]);

        res.json({ success: true, message: "Subcuenta eliminada y cupo liberado." });

    } catch (e) {
        console.error("Error borrando tenant:", e);
        res.status(500).json({ error: e.message });
    }
});

// Admin Support Routes
app.post("/admin/support/start", verifyToken, requireRole('admin'), async (req, res) => {
    try { await startWhatsApp(SUPPORT_LOC_ID, SUPPORT_SLOT_ID); res.json({ success: true, message: "Iniciando..." }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/admin/support/qr", verifyToken, requireRole('admin'), (req, res) => {
    const session = sessions.get(`${SUPPORT_LOC_ID}_slot${SUPPORT_SLOT_ID}`); if (session && session.qr) res.json({ qr: session.qr }); else res.status(404).json({ error: "No QR" });
});
app.get("/admin/support/status", verifyToken, requireRole('admin'), async (req, res) => {
    const session = sessions.get(`${SUPPORT_LOC_ID}_slot${SUPPORT_SLOT_ID}`); let dbInfo = {}; try { const r = await pool.query("SELECT phone_number FROM location_slots WHERE location_id=$1 AND slot_id=$2", [SUPPORT_LOC_ID, SUPPORT_SLOT_ID]); if (r.rows.length) dbInfo = r.rows[0]; } catch (e) { } res.json({ connected: session?.isConnected || false, myNumber: session?.myNumber || dbInfo.phone_number, is_active: true });
});
app.delete("/admin/support/disconnect", verifyToken, requireRole('admin'), async (req, res) => {
    try { await deleteSessionData(SUPPORT_LOC_ID, SUPPORT_SLOT_ID); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 🌍 RUTAS PÚBLICAS IFRAME
// ==========================================

app.get("/public/ghl-users", requireIframeSecurity, async (req, res) => {
    try { const { locationId } = req.query; if (!locationId) return res.status(400).json({ error: "Falta locationId" }); const users = await getLocationUsers(locationId); res.json(users.map(u => ({ id: u.id, name: u.name }))); } catch (e) { res.status(500).json({ error: "Error obteniendo usuarios" }); }
});

app.post("/public/update-slot-config", requireIframeSecurity, async (req, res) => {
    const { locationId, slotId, priority, assignedUser, isFavorite } = req.body;
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
        if (isFavorite !== undefined) {
            if (isFavorite === true) await pool.query("UPDATE location_slots SET is_favorite = false WHERE location_id = $1", [locationId]);
            await pool.query("UPDATE location_slots SET is_favorite = $1 WHERE location_id = $2 AND slot_id = $3", [isFavorite, locationId, slotId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/start-whatsapp", requireIframeSecurity, async (req, res) => { try { await startWhatsApp(req.query.locationId, req.query.slot); res.json({ success: true }); } catch (e) { res.status(500).json({ error: "Error" }); } });
app.get("/qr", requireIframeSecurity, (req, res) => { const s = sessions.get(`${req.query.locationId}_slot${req.query.slot}`); if (s && s.qr) res.json({ qr: s.qr }); else res.status(404).json({ error: "No QR" }); });
app.get("/status", requireIframeSecurity, async (req, res) => { const s = sessions.get(`${req.query.locationId}_slot${req.query.slot}`); let extra = {}; try { const r = await pool.query("SELECT * FROM location_slots WHERE location_id=$1 AND slot_id=$2", [req.query.locationId, req.query.slot]); if (r.rows.length) extra = r.rows[0]; } catch (e) { } res.json({ connected: s?.isConnected || false, myNumber: s?.myNumber, slotName: extra.slot_name, priority: extra.priority, settings: extra.settings, is_favorite: extra.is_favorite }); });
app.post("/remove-slot", requireIframeSecurity, async (req, res) => { try { const locationId = req.query.locationId; const slot = req.query.slot; if (!locationId || !slot) return res.status(400).json({ error: "Faltan parámetros" }); await deleteSessionData(locationId, slot); res.json({ success: true }); } catch (e) { res.status(500).json({ error: "Error al desconectar" }); } });
app.post("/config-slot", requireIframeSecurity, async (req, res) => { try { await pool.query(`INSERT INTO location_slots (location_id, slot_id, slot_name) VALUES ($1, $2, $3) ON CONFLICT (location_id, slot_id) DO UPDATE SET slot_name = EXCLUDED.slot_name`, [req.body.locationId, req.body.slot, req.body.slotName]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get("/config", requireIframeSecurity, async (req, res) => {
    try {
        const { locationId } = req.query;
        const tenantStatus = await getTenantConfig(locationId);
        const slotsRes = await pool.query("SELECT slot_id, slot_name, phone_number, priority, settings, is_favorite FROM location_slots WHERE location_id = $1 ORDER BY priority ASC", [locationId]);
        res.json({
            is_active: tenantStatus.active,
            reason: tenantStatus.reason,
            slots: slotsRes.rows.map(s => ({
                id: s.slot_id,
                name: s.slot_name,
                connected: !!s.phone_number,
                priority: s.priority,
                settings: s.settings,
                is_favorite: s.is_favorite
            }))
        });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

// Admin Routes
app.get("/admin/agencies", verifyToken, requireRole('admin'), async (req, res) => { const q = `SELECT agency_id, MAX(agency_name) as agency_name, COUNT(*) as total_subaccounts, COUNT(CASE WHEN status = 'active' THEN 1 END) as active_subaccounts FROM tenants WHERE agency_id IS NOT NULL GROUP BY agency_id`; const r = await pool.query(q); res.json(r.rows); });
app.get("/admin/tenants", verifyToken, requireRole('admin'), async (req, res) => { const { agencyId } = req.query; let q = `SELECT t.*, p.name as plan_name FROM tenants t LEFT JOIN subscription_plans p ON t.plan_id = p.id`; const p = []; if (agencyId) { q += " WHERE t.agency_id = $1"; p.push(agencyId); } q += " ORDER BY t.created_at DESC"; const r = await pool.query(q, p); res.json(r.rows); });


// ✅ OBTENER SUSCRIPCIONES ACTIVAS (DETALLADO)
app.get("/payments/my-subscriptions", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            "SELECT * FROM active_subscriptions WHERE user_id = $1 ORDER BY created_at DESC",
            [userId]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/payments/update-plan", verifyToken, updatePlan);

// ⏰ CRON JOB SUSPENSIÓN
setInterval(async () => {
    console.log("⏰ Revisión de trials...");
    try {
        await pool.query(`UPDATE users SET plan_status = 'suspended' WHERE plan_status = 'trial' AND trial_ends_at < NOW()`);
        await pool.query(`UPDATE tenants SET status = 'suspended' WHERE status = 'trial' AND trial_ends_at < NOW()`);
        await pool.query(`UPDATE tenants SET status = 'suspended' FROM users WHERE tenants.agency_id = users.agency_id AND users.plan_status IN ('suspended', 'canceled', 'past_due') AND tenants.status = 'active'`);
    } catch (e) { console.error("Error Cron Job:", e.message); }
}, 60 * 60 * 1000);

// START
async function restoreSessions() {
    try {
        console.log("🔄 Iniciando restauración de sesiones...");

        // 1. Obtener todas las sesiones únicas
        const res = await pool.query("SELECT DISTINCT session_id FROM baileys_auth");
        const totalSessions = res.rows.length;

        console.log(`📊 Se encontraron ${totalSessions} sesiones para restaurar.`);

        // 2. Iterar con pausa (Rate Limiting)
        for (const [index, row] of res.rows.entries()) {
            const parts = row.session_id.split("_slot");

            if (parts.length === 2) {
                const locationId = parts[0];
                const slotId = parts[1];

                // Calculamos el progreso para loguear
                const progress = index + 1;
                console.log(`[${progress}/${totalSessions}] 🚀 Iniciando: ${locationId} (Slot ${slotId})...`);

                // 🔥 CLAVE: Lanzamos la conexión SIN await para no bloquear el hilo principal por completo,
                // pero capturamos errores individuales para que uno no detenga a los demás.
                startWhatsApp(locationId, slotId).catch(err => {
                    console.error(`❌ Error al iniciar sesión ${row.session_id}:`, err.message);
                });

                // 🔥 CLAVE: Pausa de seguridad de 2 a 5 segundos entre arranques.
                // Esto permite que la CPU baje y que la conexión TCP se establezca antes de abrir otra.
                await sleep(2500);
            }
        }

        console.log("✅ Proceso de restauración escalonada finalizado.");

    } catch (e) {
        console.error("❌ Error fatal restaurando sesiones:", e);
    }
}
(async () => { try { await initDb(); startMediaCleanup(); app.listen(PORT, async () => { console.log(`API OK ${PORT}`); await restoreSessions(); }); } catch (e) { console.error("❌ Error fatal al iniciar:", e); process.exit(1); } })();