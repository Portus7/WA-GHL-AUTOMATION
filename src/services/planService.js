// src/services/planService.js
const { pool } = require("../config/db");

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

module.exports = { canCreateTenant, canAddSlot };