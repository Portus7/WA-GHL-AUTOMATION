const { stripe } = require('../services/stripeService');
const { pool } = require('../config/db');

// ==========================================
// ⚙️ CONFIGURACIÓN DE PRODUCTOS
// ==========================================
// Copia aquí los MISMOS IDs que pusiste en tu Frontend (SubscriptionModal.jsx)
const STRIPE_CONFIG = {
    // --- PLANES BASE (Resetean límites) ---
    'price_REGULAR_ID': { type: 'base', name: 'Regular', limits: { subagencies: 1, slots: 5 } },
    'price_PRO_ID': { type: 'base', name: 'Agencia Pro', limits: { subagencies: 5, slots: 25 } },
    'price_ENTERPRISE_ID': { type: 'base', name: 'Enterprise', limits: { subagencies: 10, slots: 50 } },

    // --- ADD-ONS (Suman límites) ---

    // 1. Slot Individual (Normal y VIP)
    'price_SLOT_STD_ID': { type: 'addon', name: '+1 Slot', increment: { slots: 1 } },
    'price_SLOT_VIP_ID': { type: 'addon', name: '+1 Slot (VIP)', increment: { slots: 1 } },

    // 2. Subagencia + Pack de 5 Slots (Normal y VIP)
    'price_SUB_STD_ID': {
        type: 'addon',
        name: '+1 Subagencia & 5 Slots',
        increment: { subagencies: 1, slots: 5 } // 👈 EL CAMBIO CLAVE: Suma 1 sub y 5 slots
    },
    'price_SUB_VIP_ID': {
        type: 'addon',
        name: '+1 Subagencia & 5 Slots (VIP)',
        increment: { subagencies: 1, slots: 5 } // 👈 EL CAMBIO CLAVE: Suma 1 sub y 5 slots
    }
};

const handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`⚠️ Webhook signature failed.`, err.message);
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

            // Opcional: Manejar facturas pagadas si quieres loguearlo
            case 'invoice.payment_succeeded':
                // console.log("Factura pagada recurrente");
                break;

            default:
                console.log(`Evento ignorado: ${event.type}`);
        }
        res.json({ received: true });
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).json({ error: "Handler failed" });
    }
};

async function handleCheckoutCompleted(session) {
    const userId = session.metadata.userId;
    const subscriptionId = session.subscription; // ID de la nueva suscripción generada

    if (!userId) {
        console.warn("⚠️ Webhook sin userId en metadata. Ignorando.");
        return;
    }

    // 1. Obtener el precio comprado mirando la sesión o la suscripción
    // Nota: Stripe Checkout session puede tener line_items expandidos, 
    // pero a veces hay que consultar la subscripción.
    let priceId = null;

    // Intentamos sacar el priceId de la suscripción creada
    if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        if (sub.items.data.length > 0) {
            priceId = sub.items.data[0].price.id;
        }
    }

    // 2. Buscar configuración
    const config = STRIPE_CONFIG[priceId];

    if (!config) {
        console.warn(`⚠️ Producto desconocido comprado: ${priceId} por usuario ${userId}`);
        return;
    }

    console.log(`✅ Procesando compra: ${config.name} (${config.type}) para Usuario ${userId}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (config.type === 'base') {
            // === ES UN PLAN BASE ===
            // 1. Reemplazamos los límites
            // 2. Guardamos el ID de la suscripción PRINCIPAL
            // 3. Quitamos el estado 'trial'
            const sql = `
                UPDATE users SET 
                    stripe_customer_id = $1,
                    stripe_subscription_id = $2,
                    plan_status = 'active',
                    max_subagencies = $3,
                    max_slots = $4,
                    trial_ends_at = NULL
                WHERE id = $5
            `;
            await client.query(sql, [
                session.customer,
                subscriptionId,
                config.limits.subagencies,
                config.limits.slots,
                userId
            ]);

        } else if (config.type === 'addon') {
            // === ES UN ADD-ON ===
            // 1. SUMAMOS a los límites existentes (COALESCE por si es null)
            // 2. NO sobreescribimos el stripe_subscription_id principal (para no perder referencia al base)

            let updateParts = [];
            let values = [];
            let idx = 1;

            if (config.increment.subagencies) {
                updateParts.push(`max_subagencies = COALESCE(max_subagencies, 1) + $${idx++}`);
                values.push(config.increment.subagencies);
            }
            if (config.increment.slots) {
                updateParts.push(`max_slots = COALESCE(max_slots, 5) + $${idx++}`);
                values.push(config.increment.slots);
            }

            // Aseguramos que el cliente de stripe esté guardado por si era la primera compra
            updateParts.push(`stripe_customer_id = $${idx++}`);
            values.push(session.customer);

            // ID del usuario al final
            values.push(userId);

            const sql = `UPDATE users SET ${updateParts.join(', ')} WHERE id = $${idx}`;
            await client.query(sql, values);
        }

        await client.query('COMMIT');
        console.log("🚀 Base de datos actualizada correctamente.");

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Error actualizando DB en webhook:", e);
        throw e;
    } finally {
        client.release();
    }
}

async function handleSubscriptionDeleted(subscription) {
    // Aquí hay un reto: Si cancelan un ADD-ON, deberíamos restar límites.
    // Si cancelan el PLAN BASE, deberíamos suspender la cuenta.
    // Por simplicidad en esta versión: Si cancelan algo, solo verificamos si es la "principal".

    const customerId = subscription.customer;

    // Buscamos si esta suscripción era la "Principal" guardada en la DB
    const userRes = await pool.query("SELECT id FROM users WHERE stripe_subscription_id = $1", [subscription.id]);

    if (userRes.rows.length > 0) {
        // Era el plan base -> Cancelar cuenta
        console.log(`🚫 Plan base cancelado para cliente ${customerId}. Suspendiendo cuenta.`);
        await pool.query("UPDATE users SET plan_status = 'canceled' WHERE stripe_customer_id = $1", [customerId]);
    } else {
        // Era un add-on (o no lo tenemos mapeado como principal)
        // NOTA: Para restar add-ons automáticamente necesitaríamos guardar un registro de "suscripciones activas" en otra tabla.
        // Por ahora, lo dejamos activo manual o requiere gestión manual del admin.
        console.log(`ℹ️ Add-on o suscripción secundaria cancelada (${subscription.id}). Los límites se mantienen manuales.`);
    }
}

module.exports = { handleWebhook };