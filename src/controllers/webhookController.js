const { stripe } = require('../services/stripeService');
const { pool } = require('../config/db');

// ✅ CONFIGURACIÓN REAL DE PRODUCTOS STRIPE (BACKEND)
const STRIPE_CONFIG = {
    // --- PLANES BASE ---
    'price_1SfJpk7Mhd9qo6A8AmFiKTdk': { type: 'base', name: 'Regular', limits: { subagencies: 1, slots: 5 } },
    'price_1SfJqb7Mhd9qo6A8zP0xydlX': { type: 'base', name: 'Agencia Pro', limits: { subagencies: 5, slots: 25 } },
    'price_1SfJrZ7Mhd9qo6A8WOn6BGbJ': { type: 'base', name: 'Enterprise', limits: { subagencies: 10, slots: 50 } },

    // --- ADD-ONS (Suman límites) ---
    // Subagencia (+5 Slots) - Normal y VIP
    'price_1SfK2d7Mhd9qo6A8AI3ZkOQT': { type: 'addon', name: '+1 Subagencia (Pack)', increment: { subagencies: 1, slots: 5 } },
    'price_1SfK547Mhd9qo6A8SfvT8GF4': { type: 'addon', name: '+1 Subagencia (Pack VIP)', increment: { subagencies: 1, slots: 5 } },

    // Slot Extra - Normal y VIP
    'price_1SfK787Mhd9qo6A8WmPRs9Zy': { type: 'addon', name: '+1 Número WhatsApp', increment: { slots: 1 } },
    'price_1SfK827Mhd9qo6A89iZ68SRi': { type: 'addon', name: '+1 Número WhatsApp (VIP)', increment: { slots: 1 } }
};

// --- HELPER: Recalcular Límites Reales ---
async function recalculateUserLimits(client, userId) {
    // 1. Obtener todas las suscripciones activas
    const res = await client.query("SELECT stripe_price_id, quantity FROM active_subscriptions WHERE user_id = $1", [userId]);
    const subs = res.rows;

    // Valores por defecto (Trial/Gratis)
    let totalSubs = 1;
    let totalSlots = 5;
    let planStatus = 'trial';

    // 2. Sumar según configuración
    subs.forEach(sub => {
        const config = STRIPE_CONFIG[sub.stripe_price_id];
        if (config) {
            if (config.type === 'base') {
                planStatus = 'active';
                // El plan base define el piso
                totalSubs = Math.max(totalSubs, config.limits.subagencies);
                totalSlots = Math.max(totalSlots, config.limits.slots);
            } else if (config.type === 'addon') {
                // Los addons suman al total
                if (config.increment.subagencies) totalSubs += (config.increment.subagencies * sub.quantity);
                if (config.increment.slots) totalSlots += (config.increment.slots * sub.quantity);
            }
        }
    });

    // 3. Actualizar la tabla Users
    await client.query(
        "UPDATE users SET max_subagencies = $1, max_slots = $2, plan_status = $3 WHERE id = $4",
        [totalSubs, totalSlots, planStatus, userId]
    );
    console.log(`🔄 Límites recalculados User ${userId}: Subs=${totalSubs}, Slots=${totalSlots}`);
}

// --- HANDLER DEL WEBHOOK ---
const handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`⚠️ Webhook Error de Firma: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const client = await pool.connect();

    try {
        // EVENTO 1: Pago Exitoso (Checkout)
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.metadata.userId; // ID interno nuestro
            const subscriptionId = session.subscription;

            if (userId && subscriptionId) {
                // Obtener detalles de la suscripción creada en Stripe
                const sub = await stripe.subscriptions.retrieve(subscriptionId);
                const priceId = sub.items.data[0].price.id; // El ID del precio comprado (price_...)
                const config = STRIPE_CONFIG[priceId];

                if (config) {
                    await client.query('BEGIN');

                    // Si es un plan base nuevo, borramos los anteriores bases para evitar conflictos
                    if (config.type === 'base') {
                        await client.query("DELETE FROM active_subscriptions WHERE user_id = $1 AND type = 'base'", [userId]);
                    }

                    // Insertar en nuestra tabla espejo
                    await client.query(`
                        INSERT INTO active_subscriptions 
                        (user_id, stripe_subscription_id, stripe_price_id, product_name, type, quantity, current_period_end)
                        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))
                    `, [
                        userId,
                        subscriptionId,
                        priceId,
                        config.name,
                        config.type,
                        1,
                        sub.current_period_end
                    ]);

                    // Vincular Customer ID si no existía
                    await client.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [session.customer, userId]);

                    // Recalcular
                    await recalculateUserLimits(client, userId);

                    await client.query('COMMIT');
                    console.log(`✅ Webhook: Suscripción activada (${config.name}) para User ${userId}`);
                }
            }
        }
        // EVENTO 2: Cancelación / Eliminación
        else if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;

            // Buscar a quién pertenece esta suscripción
            const userRes = await client.query("SELECT user_id FROM active_subscriptions WHERE stripe_subscription_id = $1", [subscription.id]);

            if (userRes.rows.length > 0) {
                const userId = userRes.rows[0].user_id;
                await client.query('BEGIN');

                // Borrar de nuestra tabla
                await client.query("DELETE FROM active_subscriptions WHERE stripe_subscription_id = $1", [subscription.id]);

                // Recalcular para bajar los límites
                await recalculateUserLimits(client, userId);

                await client.query('COMMIT');
                console.log(`🗑️ Webhook: Suscripción eliminada para User ${userId}`);
            }
        }

        res.json({ received: true });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("❌ Error Procesando Webhook:", error);
        res.status(500).json({ error: "Handler failed" });
    } finally {
        client.release();
    }
};

module.exports = { handleWebhook };