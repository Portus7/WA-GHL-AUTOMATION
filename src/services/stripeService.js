const Stripe = require('stripe');
const { pool } = require('../config/db');
require('dotenv').config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const BASE_URL = process.env.API_PUBLIC_URL || 'http://localhost:5000';

/**
 * Crea una sesión de Checkout para comprar un plan
 * @param {string} userId - ID interno del usuario (agencia)
 * @param {string} priceId - ID del precio en Stripe (price_...)
 */
async function createCheckoutSession(userId, priceId) {
    // 1. Obtener datos del usuario
    const userRes = await pool.query("SELECT email, stripe_customer_id FROM users WHERE id = $1", [userId]);
    const user = userRes.rows[0];
    if (!user) throw new Error("Usuario no encontrado");

    let customerId = user.stripe_customer_id;

    // 2. Si no tiene ID de Stripe, lo creamos
    if (!customerId) {
        const customer = await stripe.customers.create({
            email: user.email,
            metadata: { userId: userId.toString() } // Importante para el webhook
        });
        customerId = customer.id;
        await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customerId, userId]);
    }

    // 3. Crear sesión
    const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${BASE_URL}/admin/agency/dashboard?payment=success`, // Ajusta esta URL a tu frontend
        cancel_url: `${BASE_URL}/admin/agency/dashboard?payment=cancelled`,
        metadata: {
            userId: userId.toString(),
            type: 'plan_subscription'
        }
    });

    return session.url;
}

/**
 * Crea enlace al Portal de Cliente (Para cancelar, ver facturas, cambiar tarjeta)
 */
async function createPortalSession(userId) {
    const userRes = await pool.query("SELECT stripe_customer_id FROM users WHERE id = $1", [userId]);
    const customerId = userRes.rows[0]?.stripe_customer_id;

    if (!customerId) throw new Error("No tienes una cuenta de facturación asociada.");

    const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${BASE_URL}/admin/agency/dashboard`,
    });

    return portalSession.url;
}

module.exports = { createCheckoutSession, createPortalSession, stripe };