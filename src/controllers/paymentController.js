const { createCheckoutSession, createPortalSession, changeSubscriptionPlan } = require('../services/stripeService');
const { cancelSubscriptionAtPeriodEnd } = require('../services/stripeService');

async function subscribe(req, res) {
    const { priceId } = req.body;
    if (!priceId) return res.status(400).json({ error: "Falta priceId" });
    try {
        const url = await createCheckoutSession(req.user.id, priceId);
        res.json({ url });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

async function manageBilling(req, res) {
    try {
        const url = await createPortalSession(req.user.id);
        res.json({ url });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

// ✅ NUEVO CONTROLADOR
async function updatePlan(req, res) {
    const { subscriptionId, newPriceId } = req.body;
    if (!subscriptionId || !newPriceId) return res.status(400).json({ error: "Datos incompletos" });
    try {
        await changeSubscriptionPlan(req.user.id, subscriptionId, newPriceId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

// 1. Obtener impacto de la cancelación
async function getCancellationPreview(req, res) {
    const { subscriptionId } = req.query;
    try {
        // Buscar Tenants vinculados a esta suscripción
        const tenantsRes = await pool.query(
            "SELECT location_id, name FROM tenants WHERE linked_subscription_id = $1 AND status != 'cancelled'",
            [subscriptionId]
        );

        const affected = [];

        for (const tenant of tenantsRes.rows) {
            // Buscar Slots (números) conectados en ese tenant
            const slotsRes = await pool.query(
                "SELECT slot_name, phone_number FROM location_slots WHERE location_id = $1 AND phone_number IS NOT NULL",
                [tenant.location_id]
            );

            affected.push({
                name: tenant.name || tenant.location_id,
                numbers: slotsRes.rows.map(s => s.phone_number) // Lista de números
            });
        }

        res.json({ affected });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

async function cancelSubscription(req, res) {
    const { subscriptionId } = req.body;
    try {
        // 🔥 Usamos la función que espera al vencimiento
        await cancelSubscriptionAtPeriodEnd(req.user.id, subscriptionId);

        res.json({ success: true, message: "Tu plan se cancelará automáticamente al finalizar el periodo actual." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

module.exports = { subscribe, manageBilling, updatePlan, cancelSubscription, getCancellationPreview };