const Stripe = require('stripe');
const { pool } = require('../config/db');
require('dotenv').config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// Ajusta esto a tu URL real del frontend
const BASE_URL = process.env.API_PUBLIC_URL_FRONT || 'https://clicandapp-frontend-web-wa.aqdlt2.easypanel.host';

async function createCheckoutSession(userId, priceId) {
    const userRes = await pool.query("SELECT email, stripe_customer_id FROM users WHERE id = $1", [userId]);
    const user = userRes.rows[0];
    if (!user) throw new Error("Usuario no encontrado");

    let customerId = user.stripe_customer_id;
    if (!customerId) {
        const customer = await stripe.customers.create({ email: user.email, metadata: { userId: userId.toString() } });
        customerId = customer.id;
        await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customerId, userId]);
    }

    const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${BASE_URL}/admin/agency/dashboard?payment=success`,
        cancel_url: `${BASE_URL}/admin/agency/dashboard?payment=cancelled`,
        metadata: { userId: userId.toString() }
    });
    return session.url;
}

async function createPortalSession(userId) {
    const userRes = await pool.query("SELECT stripe_customer_id FROM users WHERE id = $1", [userId]);
    if (!userRes.rows[0]?.stripe_customer_id) throw new Error("Sin cuenta de facturación.");
    const session = await stripe.billingPortal.sessions.create({
        customer: userRes.rows[0].stripe_customer_id,
        return_url: `${BASE_URL}/admin/agency/dashboard`,
    });
    return session.url;
}

// ✅ NUEVA FUNCIÓN: CAMBIO DE PLAN IN-APP
async function changeSubscriptionPlan(userId, subscriptionId, newPriceId) {
    // 1. Verificar que la suscripción pertenezca al usuario en nuestra DB
    const subRes = await pool.query(
        "SELECT stripe_subscription_id FROM active_subscriptions WHERE user_id = $1 AND stripe_subscription_id = $2",
        [userId, subscriptionId]
    );
    if (subRes.rows.length === 0) throw new Error("Suscripción no válida.");

    // 2. Obtener el item de la suscripción en Stripe
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const itemId = subscription.items.data[0].id;

    // 3. Aplicar el cambio (Cobra/Devuelve la diferencia al instante)
    const updated = await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: 'always_invoice',
    });

    return updated;
}

module.exports = { createCheckoutSession, createPortalSession, changeSubscriptionPlan, stripe };