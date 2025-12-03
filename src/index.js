const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const { initDb } = require("./db/init");
const { pool } = require("./config/db");
// const { sendMetaButtons } = require("./services/metaWhatsapp"); // Ya no usamos esto
const {
    startWhatsApp,
    sessions,
    botMessageIds,
    deleteSessionData,
    saveRouting,
    getRoutingForPhone,
    getLocationSlotsConfig,
    waitForSocketOpen,
} = require("./services/whatsappService");
const {
    saveTokens,
    getTokens,
    ensureAgencyToken,
    callGHLWithAgency,
} = require("./services/ghlService");
const { normalizePhone } = require("./helpers/utils");
const { parseGHLCommand } = require("./helpers/parser");

// Parche crypto
if (!globalThis.crypto) {
    globalThis.crypto = require("crypto").webcrypto;
}

const PORT = process.env.PORT || 5000;
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CUSTOM_MENU_URL_WA =
    process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com";
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
            "SELECT priority, tags FROM location_slots WHERE location_id=$1 AND slot_id=$2",
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
        });
    res.json({ connected: false, priority: extra.priority, tags: extra.tags });
});

// --- WEBHOOK OUTBOUND CON LISTAS ---
app.post("/ghl/webhook", async (req, res) => {
    try {
        const { locationId, phone, message, type, attachments } = req.body;
        if (!locationId || !phone || (!message && !attachments))
            return res.json({ ignored: true });

        // Filtro Anti-Bucle
        if (message && message.includes("[Enviado desde otro dispositivo]"))
            return res.json({ ignored: true });

        if (type === "Outbound" || type === "SMS") {

            let finalMessage = message || "";

            // --- LOGICA DE SPINTAX (Random Message) ---
            // Formato: //sep/Opcion A/Opcion B//sep_end
            const spintaxMatch = finalMessage.match(/\/\/sep([\s\S]*?)\/\/sep_end\/?/);
            if (spintaxMatch) {
                const content = spintaxMatch[1];
                // Dividimos por / y filtramos vacíos o la palabra "sep" que pueda quedar del inicio
                const options = content.split("/").map(o => o.trim()).filter(o => o !== "" && o !== "sep");

                if (options.length > 0) {
                    const randomIndex = Math.floor(Math.random() * options.length);
                    const selectedOption = options[randomIndex];
                    console.log(`🎲 Spintax: Seleccionada opción ${randomIndex + 1}/${options.length}: "${selectedOption.substring(0, 20)}..."`);

                    // Reemplazamos todo el bloque por la opción seleccionada
                    finalMessage = finalMessage.replace(spintaxMatch[0], selectedOption);
                }
            }
            // ------------------------------------------

            // --- LOGICA DE DELAY ---
            // Formato: //delay=5 (donde 5 son segundos maximos)
            const delayMatch = finalMessage.match(/\/\/delay=(\d+)/);

            if (delayMatch) {
                const maxSeconds = parseInt(delayMatch[1], 10);
                if (!isNaN(maxSeconds) && maxSeconds > 0) {
                    // Random entre 1000ms y maxSeconds*1000 ms
                    const minMs = 1000;
                    const maxMs = maxSeconds * 1000;
                    const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

                    console.log(`⏳ Delay detectado: ${maxSeconds}s. Esperando ${delayMs}ms antes de enviar...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));

                    // Removemos el tag del mensaje
                    finalMessage = finalMessage.replace(delayMatch[0], "").trim();
                }
            }
            // -----------------------

            const clientPhone = normalizePhone(phone);

            // 1. Obtener Candidatos
            let dbConfigs = await getLocationSlotsConfig(locationId);
            let availableCandidates = dbConfigs
                .map((conf) => ({
                    slot: conf.slot_id,
                    priority: conf.priority,
                    tags: conf.tags || [],
                    myNumber: conf.phone_number,
                    session: sessions.get(`${locationId}_slot${conf.slot_id}`),
                }))
                .filter((c) => c.session && c.session.isConnected);

            // Fallback Memoria
            if (availableCandidates.length === 0) {
                for (const [sid, s] of sessions.entries()) {
                    if (sid.startsWith(`${locationId}_slot`) && s.isConnected)
                        availableCandidates.push({
                            slot: parseInt(sid.split("_slot")[1]),
                            priority: 99,
                            tags: [],
                            myNumber: s.myNumber,
                            session: s,
                        });
                }
            }

            if (availableCandidates.length === 0)
                return res.status(200).json({ error: "No connected devices" });

            // -----------------------------------------------------------
            // 🧠 LÓGICA DE JERARQUÍA
            // -----------------------------------------------------------
            let selectedCandidate = null;
            let selectionReason = "";

            // NIVEL 1: TAG "PRIOR"
            const priorCandidate = availableCandidates.find(
                (c) =>
                    c.tags &&
                    c.tags.some((t) => t.toUpperCase() === "PRIOR" || t === "#priority")
            );

            if (priorCandidate) {
                selectedCandidate = priorCandidate;
                selectionReason = "Tag PRIOR detectado";
            }

            // NIVEL 2: PRIORIDAD 1
            if (!selectedCandidate) {
                const king = availableCandidates.find((c) => c.priority === 1);
                if (king) {
                    selectedCandidate = king;
                    selectionReason = "Prioridad Maestra (1)";
                }
            }

            // NIVEL 3: ROUTING
            if (!selectedCandidate) {
                const route = await getRoutingForPhone(clientPhone, locationId);
                if (route?.channelNumber) {
                    const stickyCandidate = availableCandidates.find(
                        (c) => c.myNumber === route.channelNumber
                    );
                    if (stickyCandidate) {
                        selectedCandidate = stickyCandidate;
                        selectionReason = "Historial (Routing)";
                    }
                }
            }

            // NIVEL 4: FALLBACK
            if (!selectedCandidate) {
                availableCandidates.sort((a, b) => a.priority - b.priority);
                selectedCandidate = availableCandidates[0];
                selectionReason = `Mejor Prioridad Disponible (${selectedCandidate.priority})`;
            }

            const sessionToUse = selectedCandidate.session;
            const jid =
                clientPhone.replace(/\D/g, "").replace("+", "") + "@s.whatsapp.net";

            console.log(
                `🚀 Enviando con Slot ${selectedCandidate.slot} (${selectionReason}) -> ${jid}`
            );

            try {
                await waitForSocketOpen(sessionToUse.sock);

                const commandData = parseGHLCommand(finalMessage);
                console.log("commandData:", JSON.stringify(commandData, null, 2));

                if (commandData) {
                    console.log("✅ Comando detectado. Enviando LISTA DE PRUEBA...");

                    // --- AQUÍ ESTÁ LA PRUEBA DE LISTA ---
                    // Ignoramos los botones específicos del parser y mandamos una lista dura
                    // para ver si Baileys la renderiza en tu celular.

                    const sections = [
                        {
                            title: "Sección Principal",
                            rows: [
                                {
                                    title: "Opción 1",
                                    rowId: "option_1",
                                    description: "Descripción prueba 1",
                                },
                                {
                                    title: "Opción 2",
                                    rowId: "option_2",
                                    description: "Descripción prueba 2",
                                },
                            ],
                        },
                        {
                            title: "Sección Secundaria",
                            rows: [
                                {
                                    title: "Opción 3",
                                    rowId: "option_3",
                                    description: "Otra sección",
                                },
                            ],
                        },
                    ];

                    const listMessage = {
                        text: "Cuerpo del mensaje de lista",
                        footer: "Pie de página de prueba",
                        title: "Título de Prueba",
                        buttonText: "ABRIR MENÚ", // El texto del botón que despliega la lista
                        sections,
                    };

                    // Enviamos usando la estructura estándar de Baileys para listas
                    const sent = await sessionToUse.sock.sendMessage(jid, listMessage);

                    // Log para debug
                    if (sent) console.log("📨 Mensaje de lista enviado a la red.");

                    // Guardar Routing y salir
                    await saveRouting(
                        clientPhone.replace("+", ""),
                        locationId,
                        null,
                        selectedCandidate.myNumber
                    );
                    return res.json({ ok: true, type: "list_test" });
                } else {
                    // --- LOGICA STANDARD (Sin comandos especiales) ---

                    if (attachments && attachments.length > 0) {
                        for (const url of attachments) {
                            let content = { image: { url: url }, caption: finalMessage || "" };
                            if (url.endsWith(".mp4"))
                                content = { video: { url: url }, caption: finalMessage || "" };
                            else if (url.endsWith(".pdf"))
                                content = {
                                    document: { url: url },
                                    mimetype: "application/pdf",
                                    fileName: "archivo.pdf",
                                };

                            const sent = await sessionToUse.sock.sendMessage(jid, content);
                            if (sent?.key?.id) {
                                botMessageIds.add(sent.key.id);
                                setTimeout(() => botMessageIds.delete(sent.key.id), 15000);
                            }
                        }
                    } else {
                        const sent = await sessionToUse.sock.sendMessage(jid, {
                            text: finalMessage,
                        });
                        if (sent?.key?.id) {
                            botMessageIds.add(sent.key.id);
                            setTimeout(() => botMessageIds.delete(sent.key.id), 15000);
                        }
                    }
                }
                console.log(`✅ Enviado.`);

                await saveRouting(
                    clientPhone.replace("+", ""),
                    locationId,
                    null,
                    selectedCandidate.myNumber
                );
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

app.post("/config-slot", async (req, res) => {
    const { locationId, slot, phoneNumber, priority, addTag, removeTag } =
        req.body;
    if (!locationId) return res.status(400).json({ error: "Faltan datos" });

    try {
        let targetSlot = slot;
        if (!targetSlot && phoneNumber) {
            const norm = normalizePhone(phoneNumber);
            const r = await pool.query(
                "SELECT slot_id FROM location_slots WHERE location_id=$1 AND phone_number=$2",
                [locationId, norm]
            );
            if (r.rows.length) targetSlot = r.rows[0].slot_id;
        }

        if (!targetSlot)
            return res.status(404).json({ error: "Slot no encontrado" });

        const allRes = await pool.query(
            "SELECT slot_id, priority, tags FROM location_slots WHERE location_id=$1",
            [locationId]
        );
        const allSlots = allRes.rows;
        const currentSlotData = allSlots.find((s) => s.slot_id == targetSlot);

        let t = currentSlotData?.tags || [];
        let finalP = currentSlotData?.priority || 99;
        let currentPriority = currentSlotData?.priority || 99;

        if (priority !== undefined) {
            const requestedPriority = parseInt(priority);
            if (requestedPriority !== currentPriority) {
                const conflictSlot = allSlots.find(
                    (x) => x.priority === requestedPriority && x.slot_id != targetSlot
                );

                if (conflictSlot) {
                    console.log(
                        `🔄 Swap: Slot ${targetSlot} toma la ${requestedPriority}, Slot ${conflictSlot.slot_id} se queda con la ${currentPriority}`
                    );
                    await pool.query(
                        "UPDATE location_slots SET priority=$1 WHERE location_id=$2 AND slot_id=$3",
                        [currentPriority, locationId, conflictSlot.slot_id]
                    );
                }
                finalP = requestedPriority;
            }
        }

        if (addTag && !t.includes(addTag)) t.push(addTag);
        if (removeTag) t = t.filter((x) => x !== removeTag);

        await pool.query(
            "UPDATE location_slots SET tags=$1::jsonb, priority=$2 WHERE location_id=$3 AND slot_id=$4",
            [JSON.stringify(t), finalP, locationId, targetSlot]
        );

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
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

app.post("/remove-slot", async (req, res) => {
    try {
        await deleteSessionData(req.query.locationId, req.query.slot);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/ghl/app-webhook", async (req, res) => {
    try {
        const evt = req.body;
        if (evt.type === "INSTALL") {
            const at = await ensureAgencyToken();
            const ats = await getTokens(AGENCY_ROW_ID);
            const lr = await axios.post(
                "https://services.leadconnectorhq.com/oauth/locationToken",
                new URLSearchParams({
                    companyId: evt.companyId,
                    locationId: evt.locationId,
                }).toString(),
                {
                    headers: {
                        Authorization: `Bearer ${at}`,
                        Version: GHL_API_VERSION,
                        "Content-Type": "application/x-www-form-urlencoded",
                        Accept: "application/json",
                    },
                }
            );
            await saveTokens(evt.locationId, { ...ats, locationAccess: lr.data });
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
                },
            }).catch(() => { });
            return res.json({ ok: true });
        }
        if (evt.type === "UNINSTALL") {
            const slots = await pool.query(
                "SELECT slot_id FROM location_slots WHERE location_id=$1",
                [evt.locationId]
            );
            for (const r of slots.rows)
                await deleteSessionData(evt.locationId, r.slot_id);
            await pool.query("DELETE FROM auth_db WHERE locationid=$1", [
                evt.locationId,
            ]);
            return res.json({ ok: true });
        }
        res.json({ ignored: true });
    } catch (e) {
        res.status(500).json({ error: "Error" });
    }
});

// --- RUTA DE PRUEBA MODIFICADA PARA LISTAS ---
app.get("/test-list", async (req, res) => {
    try {
        const { locationId, slot, phone } = req.query;
        const sess = sessions.get(`${locationId}_slot${slot}`);
        if (!sess || !sess.isConnected)
            return res.status(400).json({ error: "No session" });

        const jid = phone.replace(/\D/g, "") + "@s.whatsapp.net";

        const sections = [
            {
                title: "Sección 1",
                rows: [
                    { title: "Opción A", rowId: "opt_a", description: "Descripción A" },
                    { title: "Opción B", rowId: "opt_b", description: "Descripción B" },
                ],
            },
        ];

        const listMessage = {
            text: "Este es el cuerpo del mensaje de lista",
            footer: "Pie de página",
            title: "Título de la Lista",
            buttonText: "VER MENÚ",
            sections,
        };

        await sess.sock.sendMessage(jid, listMessage);

        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.get("/config", (req, res) => res.json({ max_slots: 3 }));

// --- ARRANQUE ---

async function restoreSessions() {
    try {
        const res = await pool.query(
            "SELECT DISTINCT session_id FROM baileys_auth"
        );
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
