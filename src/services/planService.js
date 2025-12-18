// src/services/planService.js
const { pool } = require("../config/db");
const { STRIPE_CONFIG } = require("../controllers/webhookController");
/**
 * Verifica si una agencia puede crear una nueva subagencia (Tenant)
 */
async function canCreateTenant(userId) {
    const client = await pool.connect();
    try {
        // 1. Obtener límites del usuario y su ID de agencia
        const userRes = await client.query(
            "SELECT agency_id, max_subagencies, plan_status, trial_ends_at FROM users WHERE id = $1",
            [userId]
        );
        const user = userRes.rows[0];

        if (!user) throw new Error("Usuario no encontrado");

        // Verificar estado del plan o trial
        const now = new Date();
        if (user.plan_status === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) < now) {
            return { allowed: false, reason: "El periodo de prueba ha finalizado." };
        }
        if (user.plan_status === 'canceled' || user.plan_status === 'past_due') {
            return { allowed: false, reason: "Suscripción inactiva." };
        }

        // 2. Contar cuántos tenants tiene ya esa agencia
        // (Asumiendo que tenants.agency_id es el link con users.agency_id)
        const countRes = await client.query(
            "SELECT COUNT(*) FROM tenants WHERE agency_id = $1 AND status != 'cancelled'",
            [user.agency_id]
        );
        const currentCount = parseInt(countRes.rows[0].count);

        if (currentCount >= user.max_subagencies) {
            return {
                allowed: false,
                reason: `Has alcanzado el límite de ${user.max_subagencies} subagencias. Mejora tu plan.`
            };
        }

        return { allowed: true };
    } finally {
        client.release();
    }
}

/**
 * Verifica si una agencia puede agregar un nuevo número (Slot) en CUALQUIER subagencia
 */
async function canAddSlot(userId) {
    const client = await pool.connect();
    try {
        // 1. Obtener límites
        const userRes = await client.query(
            "SELECT agency_id, max_slots, plan_status, trial_ends_at FROM users WHERE id = $1",
            [userId]
        );
        const user = userRes.rows[0];

        // Verificaciones de estado (igual que arriba) ...
        // (Puedes refactorizar esto en una función auxiliar checkStatus)

        // 2. Contar TOTAL de slots usados en TODAS las subagencias de esta agencia
        // Hacemos un JOIN entre location_slots y tenants para filtrar por agency_id
        const countRes = await client.query(`
            SELECT COUNT(*) 
            FROM location_slots s
            JOIN tenants t ON s.location_id = t.location_id
            WHERE t.agency_id = $1
        `, [user.agency_id]);

        const currentSlots = parseInt(countRes.rows[0].count);

        if (currentSlots >= user.max_slots) {
            return {
                allowed: false,
                reason: `Has alcanzado el límite global de ${user.max_slots} números. Compra slots extra.`
            };
        }

        return { allowed: true };
    } finally {
        client.release();
    }
}

/**
 * Busca una suscripción activa que tenga espacio disponible para una nueva subagencia
 */
async function findAvailableSubscription(userId) {
    // 1. Obtener todas las suscripciones del usuario
    const subsRes = await pool.query(
        "SELECT stripe_subscription_id, stripe_price_id, quantity FROM active_subscriptions WHERE user_id = $1 AND status = 'active'",
        [userId]
    );

    // 2. Revisar cuál tiene cupo
    for (const sub of subsRes.rows) {
        // Cuántas subcuentas permite este plan (multiplicado por cantidad si compró varios packs)
        // Nota: Necesitamos importar STRIPE_CONFIG o hardcodear la lógica aquí. 
        // Para simplificar y evitar dependencias circulares, asumiremos la lógica estándar:
        // (En un entorno real, exporta STRIPE_CONFIG a un archivo config separado)

        let allowed = 0;
        // Lógica simplificada basada en tus planes actuales
        if (sub.stripe_price_id.includes('1SfJpk')) allowed = 1 * sub.quantity; // Regular
        else if (sub.stripe_price_id.includes('1SfJqb')) allowed = 5 * sub.quantity; // Pro
        else if (sub.stripe_price_id.includes('1SfJrZ')) allowed = 10 * sub.quantity; // Enterprise
        else if (sub.stripe_price_id.includes('1SfK547')) allowed = 1 * sub.quantity; // VIP/Addon

        // Contar cuántas subcuentas ya están vinculadas a ESTA suscripción específica
        const usedRes = await pool.query(
            "SELECT COUNT(*) FROM tenants WHERE linked_subscription_id = $1 AND status != 'cancelled'",
            [sub.stripe_subscription_id]
        );
        const used = parseInt(usedRes.rows[0].count);

        if (used < allowed) {
            return sub.stripe_subscription_id; // ¡Encontramos una con espacio!
        }
    }
    return null;
}

async function canCreateTenant(userId) {
    const client = await pool.connect();
    try {
        // 1. Verificar estado general
        const userRes = await client.query("SELECT plan_status FROM users WHERE id = $1", [userId]);
        if (userRes.rows[0]?.plan_status !== 'active' && userRes.rows[0]?.plan_status !== 'trial') {
            return { allowed: false, reason: "Suscripción inactiva." };
        }

        // 2. Buscar Slot de Suscripción Específico
        const availableSubId = await findAvailableSubscription(userId);

        if (!availableSubId) {
            // Fallback: Si estamos en Trial o Admin, permitimos sin vincular (null)
            // Pero si es usuario normal y no tiene hueco en sus planes, bloqueamos.
            if (userRes.rows[0]?.plan_status === 'trial') return { allowed: true, subscriptionId: null };

            return {
                allowed: false,
                reason: "No tienes cupo disponible en tus planes activos. Contrata un nuevo plan."
            };
        }

        return { allowed: true, subscriptionId: availableSubId };
    } finally {
        client.release();
    }
}

module.exports = { canCreateTenant, canAddSlot, findAvailableSubscription };