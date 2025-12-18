const { pool } = require("../config/db");

// 1. Obtener estado y configuración de una subagencia
async function getTenantConfig(locationId) {
    try {
        const res = await pool.query(
            "SELECT status, trial_ends_at, settings FROM tenants WHERE location_id = $1",
            [locationId]
        );

        if (res.rows.length === 0) return { active: false, reason: "not_found", settings: {} };

        const tenant = res.rows[0];
        const now = new Date();

        // Lógica de Bloqueo
        if (tenant.status === 'trial' && new Date(tenant.trial_ends_at) < now) {
            await pool.query("UPDATE tenants SET status = 'suspended' WHERE location_id = $1", [locationId]);
            return { active: false, reason: "trial_expired", settings: tenant.settings };
        }

        if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
            return { active: false, reason: "subscription_inactive", settings: tenant.settings };
        }

        return { active: true, settings: tenant.settings || {} };

    } catch (e) {
        console.error(`❌ Error obteniendo tenant ${locationId}:`, e.message);
        return { active: false, reason: "db_error", settings: {} };
    }
}

// 2. Registrar un nuevo cliente (Webhook INSTALL)
async function registerNewTenant(locationId, companyId, initialStatus = 'active', subscriptionId = null) {
    try {
        console.log(`📥 Procesando instalación para Location: ${locationId}, Agency: ${companyId}, Status: ${initialStatus}`);

        const trialDays = 14;
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + trialDays);
        const planId = 1;

        const defaultSettings = {
            show_source_label: true,
            create_unknown_contacts: true,
            transcribe_audio: true,
            send_disconnect_message: true
        };

        const sql = `
            INSERT INTO tenants (location_id, status, trial_ends_at, plan_id, settings, created_at, agency_id, linked_subscription_id)
            VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), $6, $7)
            ON CONFLICT (location_id) 
            DO UPDATE SET 
                status = EXCLUDED.status, -- Actualizamos al estado que enviamos
                agency_id = EXCLUDED.agency_id,
                updated_at = NOW()
        `;

        // Pasamos initialStatus en lugar de hardcodear 'active'
        await pool.query(sql, [locationId, initialStatus, trialEnd, planId, JSON.stringify(defaultSettings), companyId, subscriptionId]);

        console.log(`🎉 Tenant Registrado: ${locationId} (${initialStatus})`);

    } catch (e) {
        console.error("❌ Error registrando tenant en DB:", e.message);
        throw e;
    }
}
// 3. Actualizar configuraciones
async function updateTenantSettings(locationId, newSettings) {
    // Implementación futura
}

module.exports = {
    getTenantConfig,
    registerNewTenant,
    updateTenantSettings
};