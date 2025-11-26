const axios = require("axios");
const { pool } = require("../config/db");
const { normalizePhone } = require("../helpers/utils");

const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

async function saveTokens(locationId, tokenData) {
  const sql = `INSERT INTO auth_db (locationid, raw_token) VALUES ($1, $2::jsonb) ON CONFLICT (locationid) DO UPDATE SET raw_token = EXCLUDED.raw_token`;
  await pool.query(sql, [locationId, JSON.stringify(tokenData)]);
}

async function getTokens(locationId) {
  const result = await pool.query("SELECT raw_token FROM auth_db WHERE locationid = $1", [locationId]);
  return result.rows[0]?.raw_token || null;
}

async function ensureAgencyToken() {
  const AGENCY_ROW_ID = "__AGENCY__";
  let tokens = await getTokens(AGENCY_ROW_ID);
  if (!tokens) throw new Error("No hay tokens agencia");
  // Aquí podrías agregar lógica de refresh si es necesario para agencia, 
  // pero usualmente se usa el de location para operaciones diarias.
  return tokens.access_token; 
}

async function forceRefreshToken(locationId) {
  console.log(`🔄 Refrescando token forzado para: ${locationId}`);
  const tokens = await getTokens(locationId);
  if (!tokens) throw new Error(`No hay tokens para ${locationId}`);
  try {
    const body = new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokens.locationAccess.refresh_token
    });
    const res = await axios.post("https://services.leadconnectorhq.com/oauth/token", body.toString(), { 
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } 
    });
    const newToken = res.data;
    await saveTokens(locationId, { ...tokens, locationAccess: newToken });
    return newToken.access_token;
  } catch (e) { 
      console.error(`❌ Error refresh token: ${e.message}`); 
      throw e; 
  }
}

async function ensureLocationToken(locationId) {
  const tokens = await getTokens(locationId);
  if (!tokens?.locationAccess) throw new Error(`No hay tokens para ${locationId}`);
  return { accessToken: tokens.locationAccess.access_token, realLocationId: tokens.locationAccess.locationId };
}

async function callGHLWithAgency(config) {
  const accessToken = await ensureAgencyToken();
  return axios({ ...config, headers: { Accept: "application/json", Version: GHL_API_VERSION, Authorization: `Bearer ${accessToken}`, ...(config.headers || {}) } });
}

async function callGHLWithLocation(locationId, config) {
  let tokenData;
  try { tokenData = await ensureLocationToken(locationId); } 
  catch (e) { 
      const newToken = await forceRefreshToken(locationId);
      tokenData = { accessToken: newToken, realLocationId: locationId };
  }

  try {
    return await axios({ 
        ...config, 
        headers: { 
            Accept: "application/json", 
            Version: GHL_API_VERSION, 
            Authorization: `Bearer ${tokenData.accessToken}`, 
            "Location-Id": tokenData.realLocationId, 
            ...(config.headers || {}) 
        } 
    });
  } catch (error) {
    if (error.response?.status === 401) {
      const newAccessToken = await forceRefreshToken(locationId);
      return await axios({ 
          ...config, 
          headers: { 
              Accept: "application/json", 
              Version: GHL_API_VERSION, 
              Authorization: `Bearer ${newAccessToken}`, 
              "Location-Id": tokenData.realLocationId, 
              ...(config.headers || {}) 
          } 
      });
    }
    throw error;
  }
}

// --- Lógica de Contactos ---

async function findOrCreateGHLContact(locationId, phone, waName, contactId, isFromMe) {
  const rawPhone = phone.replace(/\D/g, ''); 
  const phoneWithPlus = `+${rawPhone}`;
  const safeName = (waName && waName.trim() && !isFromMe) ? waName : "Usuario WhatsApp";

  if (contactId) {
    try {
      const res = await callGHLWithLocation(locationId, { method: "GET", url: `https://services.leadconnectorhq.com/contacts/${contactId}` });
      const contact = res.data.contact || res.data;
      if (contact?.id) {
          // Update name logic if needed
          const currentName = ((contact.firstName || "") + " " + (contact.lastName || "")).toLowerCase().trim();
          if ((currentName === "usuario whatsapp" || currentName === "") && safeName !== "Usuario WhatsApp") {
               await callGHLWithLocation(locationId, { method: "PUT", url: `https://services.leadconnectorhq.com/contacts/${contact.id}`, data: { firstName: safeName, lastName: "" } }).catch(()=>{});
          }
          return contact;
      }
    } catch (err) {}
  }

  // Búsqueda por Query
  try {
      const searchRes = await callGHLWithLocation(locationId, {
          method: "GET", url: "https://services.leadconnectorhq.com/contacts/",
          params: { locationId: locationId, query: rawPhone, limit: 1 }
      });
      if (searchRes.data?.contacts?.length > 0) {
          const found = searchRes.data.contacts[0];
          const foundPhone = found.phone ? found.phone.replace(/\D/g, '') : "";
          if (foundPhone.includes(rawPhone) || rawPhone.includes(foundPhone)) {
               // Update name check
               if ((found.firstName === "Usuario" || found.firstName === "Usuario WhatsApp") && safeName !== "Usuario WhatsApp") {
                   await callGHLWithLocation(locationId, { method: "PUT", url: `https://services.leadconnectorhq.com/contacts/${found.id}`, data: { firstName: safeName, lastName: "" } }).catch(()=>{});
               }
               return found;
          }
      }
  } catch(e) {}

  // Crear
  try {
    const createdRes = await callGHLWithLocation(locationId, {
      method: "POST", url: "https://services.leadconnectorhq.com/contacts/",
      data: { locationId, phone: phoneWithPlus, firstName: safeName, source: "WhatsApp Baileys" }
    });
    return createdRes.data.contact || createdRes.data;
  } catch (err) {
    const body = err.response?.data;
    if (err.response?.status === 400 && body?.meta?.contactId) return { id: body.meta.contactId, phone: phoneWithPlus };
    return null;
  }
}

async function logMessageToGHL(locationId, contactId, text, direction, attachments = []) {
  try {
    let url = "https://services.leadconnectorhq.com/conversations/messages"; 
    
    // Objeto base
    const payload = { 
        type: "SMS", 
        contactId, 
        locationId, 
        message: text || " ", // GHL no acepta mensajes vacíos, ponemos un espacio por seguridad
        direction: direction
    };

    // 🔥 FIX: Solo agregamos attachments si el array NO está vacío
    if (attachments && attachments.length > 0) {
        payload.attachments = attachments;
    }

    // Cambiar endpoint si es inbound
    if (direction === "inbound") {
        url = "https://services.leadconnectorhq.com/conversations/messages/inbound";
    }

    await callGHLWithLocation(locationId, {
      method: "POST", 
      url: url,
      data: payload
    });

    console.log(`✅ GHL Sync [${direction}]: ${text ? text.substring(0, 15) : 'Media'}... (Media: ${attachments.length})`);

  } catch (err) { 
      // 🔥 FIX: Loguear el error real que devuelve GHL para saber qué pasó
      const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`❌ GHL Log Error (${direction}):`, errorMsg); 
  }
}

module.exports = {
    saveTokens,
    getTokens,
    callGHLWithAgency,
    callGHLWithLocation,
    findOrCreateGHLContact,
    logMessageToGHL,
    ensureAgencyToken,
};