// services/metaWhatsapp.js
const axios = require("axios");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const META_WA_TOKEN = process.env.META_WA_TOKEN;
const META_WA_PHONE_ID = process.env.META_WA_PHONE_ID;

async function sendMetaButtons(toE164, commandData) {
  // toE164 debe ser +598..., +34..., etc.
  const url = `https://graph.facebook.com/v21.0/${META_WA_PHONE_ID}/messages`;

  // Mapeamos tus buttons de #btn a reply buttons de Cloud API
  const buttons = commandData.buttons.slice(0, 3).map((b, idx) => {
    const params = JSON.parse(b.buttonParamsJson);

    // Usamos siempre "reply" y en el id metemos el tipo
    let id = `btn_${idx}`;
    let title = params.display_text || params.displayText || `Opción ${idx + 1}`;

    if (b.name === "quick_reply") {
      id = params.id || `quick_${idx}`;
    } else if (b.name === "cta_url") {
      id = `url::${params.url}`;
    } else if (b.name === "cta_call") {
      id = `call::${params.phone_number}`;
    } else if (b.name === "cta_copy") {
      id = `copy::${params.copy_code}`;
    }

    return {
      type: "reply",
      reply: {
        id,
        title
      }
    };
  });

  const payload = {
    messaging_product: "whatsapp",
    to: toE164, // ej: +59584756159
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: commandData.body || "Elige una opción" },
      footer: { text: "Clic&App" },
      action: { buttons }
    }
  };

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${META_WA_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  return res.data;
}

module.exports = { sendMetaButtons };
