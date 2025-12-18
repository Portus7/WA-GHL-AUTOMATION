const { createCheckoutSession, createPortalSession, changeSubscriptionPlan } = require('../services/stripeService');

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

module.exports = { subscribe, manageBilling, updatePlan };