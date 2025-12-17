const { stripe } = require('../services/stripeService');
const { pool } = require('../config/db');

// Configuración de Productos (Misma que tenías)
const STRIPE_CONFIG = {
    'price_REGULAR_ID': { type: 'base', name: 'Regular', limits: { subagencies: 1, slots: 5 } },
    'price_PRO_ID': { type: 'base', name: 'Agencia Pro', limits: { subagencies: 5, slots: 25 } },
    'price_ENTERPRISE_ID': { type: 'base', name: 'Enterprise', limits: { subagencies: 10, slots: 50 } },
    'price_SLOT_STD_ID': { type: 'addon', name: '+1 Slot', increment: { slots: 1 } },
    'price_SLOT_VIP_ID': { type: 'addon', name: '+1 Slot (VIP)', increment: { slots: 1 } },
    'price_SUB_STD_ID': { type: 'addon', name: '+1 Subagencia & 5 Slots', increment: { subagencies: 1, slots: 5 } },
    'price_SUB_VIP_ID': { type: 'addon', name: '+1 Subagencia & 5 Slots (VIP)', increment: { subagencies: 1, slots: 5 } }
};

// --- FUNCIÓN HELPER: Recalcular Límites Reales ---
async function recalculateUserLimits(client, userId) {
    // 1. Obtener todas las suscripciones activas de la DB
    const res = await client.query("SELECT stripe_price_id, quantity FROM active_subscriptions WHERE user_id = $1", [userId]);
    const subs = res.rows;

    let totalSubs = 0; // Default mínimo (o lo que quieras dar gratis)
    let totalSlots = 0; // Default mínimo
    let planStatus = 'free'; // O 'trial' si manejas esa lógica aparte

    // 2. Sumar según configuración
    subs.forEach(sub => {
        const config = STRIPE_CONFIG[sub.stripe_price_id];
        if (config) {
            if (config.type === 'base') {
                planStatus = 'active';
                // Los planes base REEMPLAZAN o definen la base, aquí asumimos que suman si tuviera múltiples,
                // pero normalmente solo hay un base. Tomamos el mayor si hubiera conflicto.
                totalSubs = Math.max(totalSubs, config.limits.subagencies);
                totalSlots = Math.max(totalSlots, config.limits.slots);
            } else if (config.type === 'addon') {
                if (config.increment.subagencies) totalSubs += (config.increment.subagencies * sub.quantity);
                if (config.increment.slots) totalSlots += (config.increment.slots * sub.quantity);
            }
        }
    });

    // 3. Actualizar la tabla Users con la realidad calculada
    await client.query(
        "UPDATE users SET max_subagencies = $1, max_slots = $2, plan_status = $3 WHERE id = $4",
        [totalSubs, totalSlots, planStatus, userId]
    );
    console.log(`🔄 Límites recalculados User ${userId}: Subs=${totalSubs}, Slots=${totalSlots}`);
}

const handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const client = await pool.connect();

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.metadata.userId;
            const subscriptionId = session.subscription;

            if (userId && subscriptionId) {
                // Obtener detalles reales de Stripe (Items)
                const sub = await stripe.subscriptions.retrieve(subscriptionId);
                const priceId = sub.items.data[0].price.id;
                const config = STRIPE_CONFIG[priceId];

                if (config) {
                    await client.query('BEGIN');

                    // A. Insertar en tabla de registro detallado
                    // Si es plan base, quizás quieras borrar otros planes base activos anteriores
                    if (config.type === 'base') {
                        await client.query("DELETE FROM active_subscriptions WHERE user_id = $1 AND type = 'base'", [userId]);
                    }

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

                    // B. Actualizar Stripe Customer ID en users si no existe
                    await client.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [session.customer, userId]);

                    // C. Recalcular límites
                    await recalculateUserLimits(client, userId);

                    await client.query('COMMIT');
                }
            }
        }
        else if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            // Buscar a quién pertenece esta suscripción
            const userRes = await client.query("SELECT user_id FROM active_subscriptions WHERE stripe_subscription_id = $1", [subscription.id]);

            if (userRes.rows.length > 0) {
                const userId = userRes.rows[0].user_id;
                await client.query('BEGIN');

                // A. Borrar de la tabla activa
                await client.query("DELETE FROM active_subscriptions WHERE stripe_subscription_id = $1", [subscription.id]);

                // B. Recalcular (Si borró el base, los límites bajarán a 0 o default)
                await recalculateUserLimits(client, userId);

                await client.query('COMMIT');
                console.log(`🗑️ Suscripción eliminada para User ${userId}`);
            }
        }

        res.json({ received: true });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error Webhook:", error);
        res.status(500).json({ error: "Handler failed" });
    } finally {
        client.release();
    }
};

module.exports = { handleWebhook };