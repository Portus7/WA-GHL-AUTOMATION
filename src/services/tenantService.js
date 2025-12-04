const { pool } = require("../config/db");

// 1. Obtener estado y configuración de una subagencia
async function getTenantConfig(locationId) {
    try {
        const res = await pool.query(
            "SELECT status, trial_ends_at, settings FROM tenants WHERE location_id = $1",
            [locationId]
        );

        // Si no existe, asumimos que es nuevo o hubo un error de registro
        if (res.rows.length === 0) return { active: false, reason: "not_found", settings: {} };

        const tenant = res.rows[0];
        const now = new Date();

        // Lógica de Bloqueo por Trial Vencido
        if (tenant.status === 'trial' && new Date(tenant.trial_ends_at) < now) {
            // Opcional: Actualizar DB a 'suspended'
            const update = "UPDATE tenants SET status = 'suspended' WHERE location_id = $1";
            await pool.query(update, [locationId]);
            return { active: false, reason: "trial_expired", settings: tenant.settings };
        }

        // Lógica de Bloqueo por Falta de Pago (Suspended)
        if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
            return { active: false, reason: "subscription_inactive", settings: tenant.settings };
        }

        // Si pasa todo, está activo
        return { active: true, settings: tenant.settings || {} };

    } catch (e) {
        console.error(`❌ Error obteniendo tenant ${locationId}:`, e.message);
        // En caso de error de DB, mejor denegar acceso por seguridad o permitir con defaults
        return { active: false, reason: "db_error", settings: {} };
    }
}

// 2. Registrar un nuevo cliente con TRIAL (Se usa al instalar la App)
async function registerNewTenant(locationId) {
    try {
        const trialDays = 5; // Configurable
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + trialDays);

        // Configuración por defecto (Features iniciales)
        const defaultSettings = {
            show_source_label: true,        // Mostrar "Source: +1234"
            create_unknown_contacts: true,  // Crear contactos nuevos
            transcribe_audio: true          // Permitir IA
        };

        // Obtenemos ID del plan trial (asegurate de haber creado el plan en DB init)
        // O hardcodeamos un plan por defecto si no quieres consultar la tabla planes
        const sql = `
      INSERT INTO tenants (location_id, status, trial_ends_at, settings, created_at)
      VALUES ($1, 'trial', $2, $3::jsonb, NOW())
      ON CONFLICT (location_id) DO NOTHING -- Si reinstala, no reseteamos el trial (seguridad)
    `;

        await pool.query(sql, [locationId, trialEnd, JSON.stringify(defaultSettings)]);
        console.log(`🎉 Nuevo Tenant Registrado: ${locationId} (Trial hasta ${trialEnd.toISOString()})`);

    } catch (e) {
        console.error("❌ Error registrando tenant:", e.message);
    }
}

// 3. Actualizar configuraciones (Para tu futuro Frontend de usuario)
async function updateTenantSettings(locationId, newSettings) {
    // Implementarás esto cuando hagas tu panel de control
    // UPDATE tenants SET settings = ...
}

module.exports = {
    getTenantConfig,
    registerNewTenant,
    updateTenantSettings
};