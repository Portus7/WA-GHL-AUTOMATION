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
// Se llama cuando alguien instala la app desde el Marketplace
async function registerNewTenant(locationId, companyId) {
    try {
        console.log(`📥 Procesando instalación para Location: ${locationId}, Agency: ${companyId}`);

        const trialDays = 14; // Damos 14 días de prueba
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + trialDays);

        // Asignamos plan por defecto (asegurarse que ID 1 exista en subscription_plans)
        const planId = 1;

        // Feature flags por defecto
        const defaultSettings = {
            show_source_label: true,
            create_unknown_contacts: true,
            transcribe_audio: true
        };

        // UPSERT: Si ya existe, actualizamos para reactivarlo o extender trial
        // IMPORTANTE: Guardamos companyId como agency_id para vincularlo al dueño
        const sql = `
            INSERT INTO tenants (location_id, status, trial_ends_at, plan_id, settings, created_at, agency_id)
            VALUES ($1, 'active', $2, $3, $4::jsonb, NOW(), $5)
            ON CONFLICT (location_id) 
            DO UPDATE SET 
                status = 'active', -- Reactivamos si estaba inactivo
                agency_id = EXCLUDED.agency_id, -- Actualizamos agencia por si cambió
                updated_at = NOW()
        `;

        await pool.query(sql, [locationId, trialEnd, planId, JSON.stringify(defaultSettings), companyId]);

        console.log(`🎉 Tenant Registrado/Actualizado: ${locationId} (Vinculado a Agencia: ${companyId})`);

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