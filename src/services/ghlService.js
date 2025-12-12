const axios = require("axios");
const { pool } = require("../config/db");
const { normalizePhone } = require("../helpers/utils");

const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

// --- Helpers de Tokens ---

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

// Helper para detectar nombres genéricos de forma más robusta
function isGenericName(name) {
  if (!name) return true;
  const n = name.toLowerCase().trim();
  // Detecta variaciones como "Miembro Grupo", "Miembro Grupo 2", "Usuario WhatsApp", etc.
  return n.includes("miembro") ||
    n.includes("usuario") ||
    n.includes("system outbound") ||
    n === "";
}

async function findOrCreateGHLContact(locationId, phone, waName, contactId, isFromMe, createUnknownContacts = true) {
  const rawPhone = phone.replace(/\D/g, '');
  const phoneWithPlus = `+${rawPhone}`;

  // Si soy yo, uso un genérico para no romper mi propio contacto si existiera con otro nombre
  const safeName = (waName && waName.trim() && !isFromMe) ? waName : "Usuario WhatsApp";

  // 1. BUSQUEDA POR ID (Si viene del routing)
  if (contactId) {
    try {
      const res = await callGHLWithLocation(locationId, { method: "GET", url: `https://services.leadconnectorhq.com/contacts/${contactId}` });
      const contact = res.data.contact || res.data;
      if (contact?.id) {
        // --- AUTO-CORRECCIÓN DE NOMBRE ---
        const currentName = ((contact.firstName || "") + " " + (contact.lastName || "")).trim();

        // Si el nombre en GHL es genérico ("Miembro Grupo") Y el nuevo nombre NO lo es ("Juan Perez")
        if (isGenericName(currentName) && !isGenericName(safeName)) {
          console.log(`✨ [Auto-Fix] Actualizando nombre ID: "${currentName}" -> "${safeName}"`);
          await callGHLWithLocation(locationId, {
            method: "PUT",
            url: `https://services.leadconnectorhq.com/contacts/${contact.id}`,
            data: { firstName: safeName, lastName: "" }
          }).catch((e) => console.error("Error actualizando nombre:", e.message));
        }
        return contact;
      }
    } catch (err) { }
  }

  // 2. BUSQUEDA POR TELEFONO (Query)
  try {
    const searchRes = await callGHLWithLocation(locationId, {
      method: "GET", url: "https://services.leadconnectorhq.com/contacts/",
      params: { locationId: locationId, query: rawPhone, limit: 1 }
    });

    if (searchRes.data?.contacts?.length > 0) {
      const found = searchRes.data.contacts[0];
      const foundPhone = found.phone ? found.phone.replace(/\D/g, '') : "";

      if (foundPhone.includes(rawPhone) || rawPhone.includes(foundPhone)) {
        // --- AUTO-CORRECCIÓN DE NOMBRE ---
        const currentName = ((found.firstName || "") + " " + (found.lastName || "")).trim();

        if (isGenericName(currentName) && !isGenericName(safeName)) {
          console.log(`✨ [Auto-Fix] Actualizando nombre Query: "${currentName}" -> "${safeName}"`);
          await callGHLWithLocation(locationId, {
            method: "PUT",
            url: `https://services.leadconnectorhq.com/contacts/${found.id}`,
            data: { firstName: safeName, lastName: "" }
          }).catch((e) => console.error("Error actualizando nombre:", e.message));
        }
        return found;
      }
    }
  } catch (e) { }

  // 3. CREAR CONTACTO NUEVO
  // Solo crear si está habilitado createUnknownContacts
  if (!createUnknownContacts) {
    console.log(`⚠️ Contacto desconocido ${phoneWithPlus} ignorado por configuración.`);
    return null;
  }

  try {
    const createdRes = await callGHLWithLocation(locationId, {
      method: "POST", url: "https://services.leadconnectorhq.com/contacts/",
      data: { locationId, phone: phoneWithPlus, firstName: safeName, source: "WhatsApp Baileys" }
    });
    console.log(`✅ Contacto creado: ${createdRes.data.contact?.id || 'ID?'}, Nombre: ${safeName}`);

    if (createdRes.data.contact?.id) {
      await addTagToContact(locationId, createdRes.data.contact.id, "whatsapp");
    }

    return createdRes.data.contact || createdRes.data;
  } catch (err) {
    const body = err.response?.data;
    // Si falla porque ya existe, devolvemos el ID existente
    if (err.response?.status === 400 && body?.meta?.contactId) {
      return { id: body.meta.contactId, phone: phoneWithPlus };
    }
    return null;
  }
}

async function addTagToContact(locationId, contactId, tag) {
  try {
    await callGHLWithLocation(locationId, {
      method: "POST",
      url: `https://services.leadconnectorhq.com/contacts/${contactId}/tags`,
      data: { tags: [tag] }
    });
  } catch (e) {
    console.error("Error agregando tag:", e.message);
  }
}

async function deleteTagsContact(locationId, contactId, tags) {
  try {
    await callGHLWithLocation(locationId, {
      method: "DELETE",
      url: `https://services.leadconnectorhq.com/contacts/${contactId}/tags`,
      data: { tags: [tags] }
    });
  } catch (e) {
    console.error("Error eliminando tags:", e.message);
  }
}

async function logMessageToGHL(locationId, contactId, text, direction, attachments = []) {
  try {
    let url = "https://services.leadconnectorhq.com/conversations/messages";

    const payload = {
      type: "SMS",
      contactId,
      locationId,
      message: text || " ",
      direction: direction
    };

    if (attachments && attachments.length > 0) {
      payload.attachments = attachments;
    }

    if (direction === "inbound") {
      url = "https://services.leadconnectorhq.com/conversations/messages/inbound";
    }

    await callGHLWithLocation(locationId, {
      method: "POST",
      url: url,
      data: payload
    });

    console.log(`✅ GHL Sync [${direction}]: ${text ? text.substring(0, 15) : 'Media'}...`);

  } catch (err) {
    const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`❌ GHL Log Error (${direction}):`, errorMsg);
  }
}

async function getLocationUsers(locationId) {
  try {
    const res = await callGHLWithLocation(locationId, {
      method: "GET",
      url: "https://services.leadconnectorhq.com/users/",
      params: { locationId }
    });

    return (res.data.users || []).map(u => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`,
      email: u.email,
      role: u.roles?.type || u.role
    }));
  } catch (error) {
    console.error("Error obteniendo usuarios GHL:", error.message);
    return [];
  }
}

async function assignContactOwner(locationId, contactId, userId) {
  if (!userId) return;
  try {
    await callGHLWithLocation(locationId, {
      method: "PUT",
      url: `https://services.leadconnectorhq.com/contacts/${contactId}`,
      data: { assignedTo: userId }
    });
  } catch (e) {
    console.error("Error asignando responsable:", e.message);
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
  addTagToContact,
  deleteTagsContact,
  getLocationUsers,
  assignContactOwner
};