const { createCheckoutSession, createPortalSession } = require('../services/stripeService');

// Aquí podrías tener un mapa de precios si quieres validarlos
// const VALID_PRICES = ['price_xxx_tier1', 'price_xxx_tier2'];

async function subscribe(req, res) {
    const { priceId } = req.body; // El frontend envía qué plan quiere comprar
    const userId = req.user.id;

    if (!priceId) return res.status(400).json({ error: "Falta priceId" });

    try {
        const url = await createCheckoutSession(userId, priceId);
        res.json({ url });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
}

async function manageBilling(req, res) {
    const userId = req.user.id;
    try {
        const url = await createPortalSession(userId);
        res.json({ url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

module.exports = { subscribe, manageBilling };