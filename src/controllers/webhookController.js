const { stripe } = require('../services/stripeService');
const { pool } = require('../config/db');

// ✅ LOS IDs DE LOS ADDONS DE SUBAGENCIA AHORA APUNTAN AL PLAN REGULAR
const STRIPE_CONFIG = {
    // Planes Base
    'price_1SfJpk7Mhd9qo6A8AmFiKTdk': { type: 'base', name: 'Regular', limits: { subagencies: 1, slots: 5 } },
    'price_1SfJqb7Mhd9qo6A8zP0xydlX': { type: 'base', name: 'Agencia Pro', limits: { subagencies: 5, slots: 25 } },
    'price_1SfJrZ7Mhd9qo6A8WOn6BGbJ': { type: 'base', name: 'Enterprise', limits: { subagencies: 10, slots: 50 } },

    // Addons (Solo Slots Extras)
    'price_1SfK787Mhd9qo6A8WmPRs9Zy': { type: 'addon', name: '+1 Número WhatsApp', increment: { slots: 1 } },
    'price_1SfK827Mhd9qo6A89iZ68SRi': { type: 'addon', name: '+1 Número WhatsApp (VIP)', increment: { slots: 1 } }
};

// --- Lógica de ACUMULACIÓN ---
async function recalculateUserLimits(client, userId) {
    const res = await client.query("SELECT stripe_price_id, quantity FROM active_subscriptions WHERE user_id = $1", [userId]);

    // Si no hay pagos, volvemos a límites Trial
    let totalSubs = res.rows.length > 0 ? 0 : 1;
    let totalSlots = res.rows.length > 0 ? 0 : 5;
    let planStatus = res.rows.length > 0 ? 'active' : 'trial';

    res.rows.forEach(sub => {
        const config = STRIPE_CONFIG[sub.stripe_price_id];
        if (config) {
            const qty = sub.quantity || 1;
            // Sumamos TODO (Base + Base + Addons)
            if (config.limits) {
                totalSubs += (config.limits.subagencies || 0) * qty;
                totalSlots += (config.limits.slots || 0) * qty;
            }
            if (config.increment) {
                totalSubs += (config.increment.subagencies || 0) * qty;
                totalSlots += (config.increment.slots || 0) * qty;
            }
        }
    });

    await client.query(
        "UPDATE users SET max_subagencies = $1, max_slots = $2, plan_status = $3 WHERE id = $4",
        [totalSubs, totalSlots, planStatus, userId]
    );
    console.log(`User ${userId} Limits: Subs=${totalSubs}, Slots=${totalSlots}`);
}

const handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }

    const client = await pool.connect();
    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.metadata.userId;
            const subId = session.subscription;

            if (userId && subId) {
                const sub = await stripe.subscriptions.retrieve(subId);
                const priceId = sub.items.data[0].price.id;
                const config = STRIPE_CONFIG[priceId];

                if (config) {
                    await client.query('BEGIN');
                    // Insertamos SIN borrar lo anterior (Acumulativo)
                    await client.query(`INSERT INTO active_subscriptions (user_id, stripe_subscription_id, stripe_price_id, product_name, type, quantity, current_period_end) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`, [userId, subId, priceId, config.name, config.type, 1, sub.current_period_end]);
                    await client.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [session.customer, userId]);
                    await recalculateUserLimits(client, userId);
                    await client.query('COMMIT');
                }
            }
        }
        // ✅ EVENTO ACTUALIZACIÓN (In-App Changes)
        else if (event.type === 'customer.subscription.updated') {
            const sub = event.data.object;
            const priceId = sub.items.data[0].price.id;
            const config = STRIPE_CONFIG[priceId];

            // Ver si la tenemos registrada
            const userRes = await client.query("SELECT user_id FROM active_subscriptions WHERE stripe_subscription_id = $1", [sub.id]);

            if (userRes.rows.length > 0 && config) {
                const userId = userRes.rows[0].user_id;
                await client.query('BEGIN');
                // Actualizamos el precio y nombre en nuestra DB local
                await client.query(`UPDATE active_subscriptions SET stripe_price_id = $1, product_name = $2, type = $3 WHERE stripe_subscription_id = $4`, [priceId, config.name, config.type, sub.id]);
                await recalculateUserLimits(client, userId);
                await client.query('COMMIT');
            }
        }
        else if (event.type === 'customer.subscription.deleted') {
            const sub = event.data.object;
            const userRes = await client.query("SELECT user_id FROM active_subscriptions WHERE stripe_subscription_id = $1", [sub.id]);
            if (userRes.rows.length > 0) {
                await client.query('BEGIN');
                await client.query("DELETE FROM active_subscriptions WHERE stripe_subscription_id = $1", [sub.id]);
                await recalculateUserLimits(client, userRes.rows[0].user_id);
                await client.query('COMMIT');
            }
        }
        res.json({ received: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
    finally { client.release(); }
};

module.exports = { handleWebhook };