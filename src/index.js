// src/index.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const { webcrypto } = require("crypto");
const fs = require("fs");

// 🔹 SDK oficial HighLevel
const { HighLevel, GHLError } = require("@gohighlevel/api-client");

// -----------------------------
// Config & estado
// -----------------------------

let isConnected = false;

// HighLevel (via SDK)
const GHL_PIT = process.env.GHL_PIT;               // Private Integration Token
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_API_VERSION = process.env.GHL_API_VERSION;

// Instancia del SDK
const ghl = new HighLevel({
  privateIntegrationToken: GHL_PIT,
  apiVersion: GHL_API_VERSION, // VER PARA AUTOMATIZAR
});

// Parche crypto para Baileys en Node
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// Express
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

// Baileys
let sock = null;
let baileysLoaded = false;
let currentQR = null;

// -----------------------------
// Helpers
// -----------------------------

function extractPhoneFromJid(jid) {
  return jid.split("@")[0];
}

function loadNumbersDb() {
  try {
    const raw = fs.readFileSync("./numbers.json", "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function savePhoneForLocation(locationId, phone) {
  const db = loadNumbersDb();
  db[locationId] = phone;
  fs.writeFileSync("./numbers.json", JSON.stringify(db, null, 2));
}

// Enviar mensaje de WhatsApp a un número en formato internacional (+569..., +52..., etc.)
async function sendWhatsAppMessage(phone, text) {
  if (!sock || !isConnected) {
    console.error("⚠️ WhatsApp no está conectado, no se puede enviar mensaje.");
    return;
  }

  // Normalizar: quitar espacios, guiones, etc.
  const numericPhone = phone.replace(/[^\d+]/g, "");

  // Si viene sin "+", le añadimos (ajusta si tus números vienen de otra forma)
  const waPhone = numericPhone.startsWith("+") ? numericPhone : `+${numericPhone}`;

  // JID de WhatsApp
  const jid = waPhone.replace("+", "") + "@s.whatsapp.net";

  try {
    await sock.sendMessage(jid, { text });
    console.log(`📤 WhatsApp enviado a ${waPhone}: ${text}`);
  } catch (err) {
    console.error("Error enviando mensaje de WhatsApp:", err);
  }
}

// ------------------------------------------------------------
// 🔥 findOrCreateGHLContact (YA ACTUALIZADO PARA GUARDAR NOMBRE)
// ------------------------------------------------------------
async function findOrCreateGHLContact(phone, waName = "WhatsApp Lead") {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    console.error("⚠️ Faltan GHL_PIT o GHL_LOCATION_ID en .env");
    return null;
  }

  const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;

  // 1) lookup por teléfono
  try {
    const lookupRes = await ghl.request({
      method: "GET",
      url: "/contacts/lookup",
      params: {
        locationId: GHL_LOCATION_ID,
        phone: normalizedPhone,
      },
    });

    if (lookupRes.data && lookupRes.data.contact) {
      console.log("🔍 Contacto encontrado (lookup):", lookupRes.data.contact.id);
      return lookupRes.data.contact;
    }
  } catch (err) {
    // Si es 404, no pasa nada: significa que no existe aún.
    if (err instanceof GHLError) {
      if (err.statusCode !== 404) {
        console.error("Error buscando contacto:", err.statusCode, err.response);
      }
    } else {
      console.error("Error buscando contacto (desconocido):", err);
    }
  }

  // 2) crear contacto si no existe
  try {
    const created = await ghl.contacts.createContact({
      locationId: GHL_LOCATION_ID,
      phone: normalizedPhone,
      firstName: waName,
      source: "WhatsApp Baileys",
    });

    console.log("👤 Contacto creado:", created.contact?.id || created.id);
    return created.contact || created;
  } catch (err) {
    // 💥 AQUÍ MANEJAMOS DUPLICADOS DE VERDAD
    if (err instanceof GHLError) {
      const statusCode = err.statusCode;
      const body = err.response; // normalmente aquí viene { message, meta, ... }

      console.error("Error creando contacto (GHL):", statusCode, body);

      // caso: "Esta localizacion no permite duplicados" con meta.contactId
      const msg = body?.message || err.message;

      if (
        statusCode === 400 &&
        body?.meta?.contactId // más fiable que matchear el texto del mensaje
      ) {
        console.log("ℹ️ Contacto ya existía (desde error 400):", body.meta.contactId);
        return { id: body.meta.contactId, phone: normalizedPhone };
      }
    } else {
      console.error("Error creando contacto (desconocido):", err);
    }

    return null;
  }
}


// ------------------------------------------------------------
// Crear mensaje INBOUND (WhatsApp ➜ GHL) como SMS
// ------------------------------------------------------------
async function sendMessageToGHLConversation(contactId, text) {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    console.error("⚠️ Faltan GHL_PIT o GHL_LOCATION_ID en .env");
    return;
  }

  try {
    const res = await ghl.request({
      method: "POST",
      url: "/conversations/messages/inbound",
      data: {
        type: "SMS",
        contactId,
        locationId: GHL_LOCATION_ID,
        message: text,
        direction: "inbound",
      },
    });

    console.log("📨 Mensaje INBOUND creado en GHL:", res.data);
  } catch (err) {
    if (err instanceof GHLError) {
      console.error("Error GHL (inbound):", err.statusCode, err.response);
    } else {
      console.error("Error enviando inbound:", err);
    }
  }
}

async function sendMessageToGHLConversationOutbound(contactId, text) {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    console.error("⚠️ Faltan GHL_PIT o GHL_LOCATION_ID en .env");
    return;
  }

  try {
    const res = await ghl.request({
      method: "POST",
      url: "/conversations/messages",
      data: {
        type: "SMS",            // O "WHATSAPP" si tu custom provider lo soporta
        contactId,
        locationId: GHL_LOCATION_ID,
        message: text,
        direction: "outbound",
      },
    });

    console.log("📤 Mensaje OUTBOUND enviado desde GHL:", res.data);
    return res.data;
  } catch (err) {
    if (err instanceof GHLError) {
      console.error("Error GHL (outbound):", err.statusCode, err.response);
    } else {
      console.error("Error enviando outbound:", err);
    }
  }
}

async function getGHLContactById(contactId) {
  try {
    const res = await ghl.request({
      method: "GET",
      url: `/contacts/${contactId}`,
    });

    return res.data?.contact || res.data;
  } catch (err) {
    if (err instanceof GHLError) {
      console.error("Error GHL (get contact):", err.statusCode, err.response);
    } else {
      console.error("Error obteniendo contacto:", err);
    }
    return null;
  }
}
// -----------------------------
// Arranque de WhatsApp / Baileys
// -----------------------------
async function startWhatsApp() {
  if (baileysLoaded && sock) return;

  // Un solo import de Baileys
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
  } = await import("@whiskeysockets/baileys");

  baileysLoaded = true;

  const { version } = await fetchLatestBaileysVersion();
  console.log("▶ Usando versión WA:", version);

  // Usa la misma carpeta que vas a montar como volumen
  const authDir = process.env.BAILEYS_AUTH_DIR || "sessions/default";
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // IMPORTANTE: asigna al sock GLOBAL
  sock = makeWASocket({
    version,
    logger: pino({ level: "info" }),
    auth: state,
    browser: ["Windows", "Chrome", "10.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📌 Escanea este QR con WhatsApp:\n");
      qrcodeTerminal.generate(qr, { small: true });
      currentQR = qr;
      isConnected = false;
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado");
      isConnected = true;
      currentQR = null;

      const waId = sock?.user?.id || null;
      if (waId) {
        const myNumber = waId.split("@")[0].split(":")[0];
        console.log("📞 Número conectado:", myNumber);
        savePhoneForLocation(GHL_LOCATION_ID, myNumber);
      }
    }

    if (connection === "close") {
      isConnected = false;
      currentQR = null;

      const statusCode =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.code;

      console.log("❌ Conexión cerrada:", statusCode);

      if (statusCode === 440) {
        console.log("⚠️ Sesión en uso por otro cliente.");
        sock = null;
        baileysLoaded = false;
        return;
      }

      console.log("🔁 Reintentando...");
      sock = null;
      baileysLoaded = false;
      setTimeout(startWhatsApp, 3000);
    }
  });

  // 👇 Mantén aquí tus listeners de mensajes (ya los tienes):
  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0];
    if (!m?.message || m.key.fromMe) return;

    const from = m.key.remoteJid;
    const text =
      m.message.conversation || m.message.extendedTextMessage?.text;

    const waName =
      m.pushName ||
      sock?.contacts?.[from]?.name ||
      sock?.contacts?.[from]?.notify ||
      "WhatsApp Lead";

    console.log("📩 Recibido de", waName, ":", text);

    const phone = extractPhoneFromJid(from);
    const contact = await findOrCreateGHLContact(phone, waName);
    if (!contact?.id) return;

    await sendMessageToGHLConversation(contact.id, text);
  });
}

// (opcional) Arranque automático
if (process.env.AUTO_START_WHATSAPP === "true") {
  startWhatsApp().catch(console.error);
}

// -----------------------------
// Endpoints HTTP
// -----------------------------
app.post("/start-whatsapp", async (req, res) => {
  try {
    await startWhatsApp();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "No se pudo iniciar WhatsApp" });
  }
});

// 🔥 Webhook desde GoHighLevel -> enviar mensaje por WhatsApp
//    https://express.clicandapp.com/ghl/webhook   
app.post("/ghl/webhook", async (req, res) => {
  try {
    console.log("📩 Webhook GHL recibido:", req.body);

    const {
      userId,       // <-- clave para evitar loop
      contactId,
      locationId,
      phone,
      message,
      type
    } = req.body;

    // 1) SI EL WEBHOOK PROVIENE DE TU PROPIO MENSAJE OUTBOUND, IGNÓRALO
    if (!userId) {
      console.log("⏭️ Ignorando mensaje OUTBOUND generado por API (evita loop)");
      return res.status(200).json({ ignored: true });
    }

    // 2) Validaciones normales
    if (!contactId || !phone || !message) {
      console.warn("⚠️ Webhook incompleto");
      return res.status(200).json({ ignored: true });
    }

    // 3) Solo filtrar por location si quieres
    if (locationId && GHL_LOCATION_ID && locationId !== GHL_LOCATION_ID) {
      console.log("➡️ Webhook de otra location, se ignora.");
      return res.status(200).json({ ignored: true });
    }

    // 4) Enviar mensaje a WhatsApp
    await sendWhatsAppMessage(phone, message);

    // 5) Registrar OUTBOUND en GHL para mostrarlo en conversacion
    // await sendMessageToGHLConversationOutbound(contactId, message);

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error("Error en webhook /ghl/webhook:", err);
    res.status(500).json({ error: "Error interno en webhook" });
  }
});



app.get("/qr", (req, res) => {
  if (!currentQR) {
    return res.status(404).json({ error: "QR no disponible aún" });
  }
  res.json({ qr: currentQR });
});

app.get("/status", (req, res) => {
  res.json({ status: "ok", whatsappConnected: isConnected });
});

// -----------------------------
// Arrancar servidor HTTP
// -----------------------------
app.listen(PORT, () =>
  console.log(`API escuchando en http://localhost:${PORT}`)
);
