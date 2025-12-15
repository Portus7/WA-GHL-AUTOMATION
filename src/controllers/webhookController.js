const { stripe } = require('../services/stripeService');
const { pool } = require('../config/db');

// MAPA DE PRECIOS -> RECURSOS
// ¡IMPORTANTE! Reemplaza estos 'price_xxx' con los IDs reales de tu Dashboard de Stripe
const PLAN_RESOURCES = {
    'price_1Q...': { subagencies: 1, slots: 5, name: 'Regular Mensual' },
    'price_TIER1_ANUAL': { subagencies: 5, slots: 25, name: 'Tier 1 Anual' },
    'price_TIER2_ANUAL': { subagencies: 10, slots: 50, name: 'Tier 2 Anual' },
    // Agrega aquí todos tus price IDs
};

const handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // Validación de firma de seguridad de Stripe
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`⚠️  Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;

            // Puedes agregar 'customer.subscription.updated' para cambios de plan en caliente
            default:
                console.log(`Unhandled event type ${event.type}`);
        }
        res.json({ received: true });
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).json({ error: "Webhook handler failed" });
    }
};

async function handleCheckoutCompleted(session) {
    const userId = session.metadata.userId;
    const subscriptionId = session.subscription;

    // Obtener la suscripción para ver qué producto/precio tiene
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const priceId = subscription.items.data[0].price.id;

    // Buscar recursos asignados a este precio
    const resources = PLAN_RESOURCES[priceId];

    if (resources) {
        console.log(`✅ Pago exitoso Usuario ${userId}. Asignando: ${resources.name}`);

        const sql = `
            UPDATE users SET 
                stripe_customer_id = $1,
                stripe_subscription_id = $2,
                plan_status = 'active',
                max_subagencies = $3,
                max_slots = $4,
                trial_ends_at = NULL -- Quitamos marca de trial
            WHERE id = $5
        `;

        await pool.query(sql, [
            session.customer,
            subscriptionId,
            resources.subagencies,
            resources.slots,
            userId
        ]);
    } else {
        console.warn(`⚠️ Pago recibido de precio desconocido (${priceId}) para usuario ${userId}`);
    }
}

async function handleSubscriptionDeleted(subscription) {
    // Buscar usuario por stripe_subscription_id y marcar como cancelado
    // OJO: stripe_customer_id está en subscription.customer
    const sql = `
        UPDATE users SET plan_status = 'canceled' 
        WHERE stripe_customer_id = $1
    `;
    await pool.query(sql, [subscription.customer]);
    console.log(`🚫 Suscripción cancelada para cliente ${subscription.customer}`);
}

module.exports = { handleWebhook };