import React, { useState, useEffect } from 'react';
import {
    X, Check, Zap, Building2, Smartphone,
    CreditCard, FileText, Layers, PlusCircle, ExternalLink, Crown
} from 'lucide-react';

const API_URL = (import.meta.env.VITE_API_URL || "https://wa.clicandapp.com").replace(/\/$/, "");

// --- 1. CONFIGURACIÓN DE PLANES BASE (CON IDS REALES) ---
const BASE_PLANS = [
    {
        id: 'price_1SfJpk7Mhd9qo6A8AmFiKTdk', // Regular
        name: 'Regular',
        price: '20€',
        limits: { subs: 1, slots: 5 },
        features: ['1 Agencia', '5 Números incluidos'],
        color: 'bg-blue-500'
    },
    {
        id: 'price_1SfJqb7Mhd9qo6A8zP0xydlX', // Pro
        name: 'Agencia Pro',
        price: '90€', // Precio actualizado
        limits: { subs: 5, slots: 25 },
        features: ['5 Agencias', '25 Números incluidos', 'Marca Blanca'],
        color: 'bg-indigo-600',
        recommended: true
    },
    {
        id: 'price_1SfJrZ7Mhd9qo6A8WOn6BGbJ', // Enterprise
        name: 'Enterprise',
        price: '200€', // Precio actualizado
        limits: { subs: 10, slots: 50 },
        features: ['10 Agencias', '50 Números incluidos', 'API', 'Descuento VIP en Extras'],
        color: 'bg-purple-600'
    }
];

// --- 2. CONFIGURACIÓN DE ADD-ONS (MAPEO DE IDs REALES) ---
const ADDONS = {
    // Subagencia (+5 Slots)
    SUB_UNIT_STD: 'price_1SfK2d7Mhd9qo6A8AI3ZkOQT', // 20€ (Normal)
    SUB_UNIT_VIP: 'price_1SfK547Mhd9qo6A8SfvT8GF4', // 10€ (VIP)

    // Slot Individual
    SLOT_UNIT_STD: 'price_1SfK787Mhd9qo6A8WmPRs9Zy', // 5€ (Normal)
    SLOT_UNIT_VIP: 'price_1SfK827Mhd9qo6A89iZ68SRi'  // 3€ (VIP)
};

export default function SubscriptionModal({ onClose, token, accountInfo }) {
    const [activeTab, setActiveTab] = useState('new_subscription');
    const [loading, setLoading] = useState(false);

    // Estado para suscripciones reales traídas de Stripe/DB
    const [realSubscriptions, setRealSubscriptions] = useState([]);

    // 1. Estado Actual del Cliente (Límites Totales para calcular descuentos)
    const totalSubs = accountInfo?.limits?.max_subagencies || 0;

    // --- LÓGICA DE DESCUENTO DINÁMICO ---
    // Si tiene 10 o más agencias (ya sea por plan Enterprise o acumuladas), es VIP.
    const hasVolumeDiscount = totalSubs >= 10;

    // Seleccionamos ID y Precio a mostrar según el descuento
    const subPriceId = hasVolumeDiscount ? ADDONS.SUB_UNIT_VIP : ADDONS.SUB_UNIT_STD;
    const subDisplayPrice = hasVolumeDiscount ? "10€ (VIP)" : "20€";

    const slotPriceId = hasVolumeDiscount ? ADDONS.SLOT_UNIT_VIP : ADDONS.SLOT_UNIT_STD;
    const slotDisplayPrice = hasVolumeDiscount ? "3€ (VIP)" : "5€";

    // --- EFECTO: Cargar suscripciones reales al cambiar de tab ---
    useEffect(() => {
        if (activeTab === 'my_subscriptions') {
            fetchRealSubscriptions();
        }
    }, [activeTab]);

    const fetchRealSubscriptions = async () => {
        try {
            const res = await fetch(`${API_URL}/payments/my-subscriptions`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setRealSubscriptions(data);
            }
        } catch (e) { console.error("Error cargando suscripciones:", e); }
    };

    // --- ACCIONES ---
    const handlePortal = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API_URL}/payments/portal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (data.url) window.location.href = data.url;
            else alert("Error al abrir portal");
        } catch (e) { alert("Error de conexión"); } finally { setLoading(false); }
    };

    const handlePurchase = async (priceId) => {
        setLoading(true);
        try {
            const res = await fetch(`${API_URL}/payments/subscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ priceId })
            });
            const data = await res.json();
            if (data.url) window.location.href = data.url;
            else alert("Error: " + (data.error || "Fallo al iniciar pago"));
        } catch (e) { alert("Error de conexión"); } finally { setLoading(false); }
    };

    // --- RENDER ---
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-gray-900 w-full max-w-6xl rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[90vh] border border-gray-200 dark:border-gray-800">

                {/* HEADER + TABS */}
                <div className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
                    <div className="flex justify-between items-center px-8 py-5">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg text-indigo-600">
                                <Layers size={24} />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-gray-900 dark:text-white">Gestión de Suscripción</h2>
                                <p className="text-xs text-gray-500">
                                    Nivel Actual: <span className={`font-bold ${hasVolumeDiscount ? 'text-purple-600' : 'text-gray-600'}`}>{hasVolumeDiscount ? "VIP (Precios con Descuento)" : "Estándar"}</span>
                                </p>
                            </div>
                        </div>
                        <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition text-gray-500">
                            <X size={20} />
                        </button>
                    </div>

                    <div className="flex px-8 gap-8 overflow-x-auto no-scrollbar">
                        <TabButton id="new_subscription" label="Nueva Suscripción" active={activeTab} onClick={setActiveTab} highlight />
                        <TabButton id="my_subscriptions" label="Mis Servicios Activos" active={activeTab} onClick={setActiveTab} />
                        <TabButton id="payment_methods" label="Métodos de Pago" active={activeTab} onClick={setActiveTab} />
                        <TabButton id="invoices" label="Facturas" active={activeTab} onClick={setActiveTab} />
                    </div>
                </div>

                {/* CONTENIDO PRINCIPAL */}
                <div className="flex-1 overflow-y-auto p-8 bg-gray-50 dark:bg-[#0B0D12]">

                    {/* --- TAB 1: NUEVA SUSCRIPCIÓN (Marketplace) --- */}
                    {activeTab === 'new_subscription' && (
                        <div className="max-w-5xl mx-auto space-y-12">

                            {/* A. ADD-ONS (Prioridad Alta) */}
                            <div>
                                <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                                    <Zap size={18} className="text-yellow-500 fill-current" /> Ampliación Flexible
                                    {hasVolumeDiscount && <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full border border-purple-200">Descuento Activado</span>}
                                </h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    {/* Tarjeta Subagencia */}
                                    <AddonCard
                                        title="Subcuenta Adicional"
                                        desc="Incluye licencia de agencia + 5 Slots WhatsApp gratis."
                                        price={subDisplayPrice}
                                        icon={Building2}
                                        color="indigo"
                                        features={['Acceso CRM completo', 'Gestión independiente', '5 Números incluidos']}
                                        onBuy={() => handlePurchase(subPriceId)}
                                    />
                                    {/* Tarjeta Slot */}
                                    <AddonCard
                                        title="WhatsApp Adicional"
                                        desc="Añade más números a cualquier subcuenta existente."
                                        price={slotDisplayPrice}
                                        icon={Smartphone}
                                        color="emerald"
                                        features={['Línea dedicada', 'Multi-dispositivo', 'Reconexión automática']}
                                        onBuy={() => handlePurchase(slotPriceId)}
                                    />
                                </div>
                            </div>

                            {/* B. PLANES BASE (Upgrades) */}
                            <div>
                                <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
                                    <Crown size={18} className="text-indigo-600" /> Niveles de Suscripción
                                </h3>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                    {BASE_PLANS.map((plan) => {
                                        // Simple lógica visual para marcar el plan actual aproximado
                                        let isCurrent = false;
                                        if (plan.name === 'Regular' && totalSubs >= 1 && totalSubs < 5) isCurrent = true;
                                        if (plan.name === 'Agencia Pro' && totalSubs >= 5 && totalSubs < 10) isCurrent = true;
                                        if (plan.name === 'Enterprise' && totalSubs >= 10) isCurrent = true;

                                        return (
                                            <div key={plan.id} className={`relative flex flex-col p-6 rounded-2xl transition-all duration-300 border ${isCurrent ? 'border-emerald-500 bg-emerald-50/10' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'}`}>

                                                {isCurrent && (
                                                    <div className="absolute top-4 right-4 text-emerald-600 font-bold text-xs bg-emerald-100 px-2 py-1 rounded">ACTUAL</div>
                                                )}

                                                <h4 className="text-lg font-bold text-gray-900 dark:text-white">{plan.name}</h4>
                                                <div className="text-3xl font-extrabold mt-2 text-gray-900 dark:text-white">{plan.price} <span className="text-sm font-normal text-gray-500">/mes</span></div>

                                                <ul className="mt-6 space-y-3 flex-1">
                                                    {plan.features.map((f, i) => (
                                                        <li key={i} className="flex gap-2 text-sm text-gray-600 dark:text-gray-300">
                                                            <Check size={16} className="text-emerald-500" /> {f}
                                                        </li>
                                                    ))}
                                                </ul>

                                                {/* Botón Principal */}
                                                {!isCurrent && (
                                                    <button
                                                        onClick={() => handlePurchase(plan.id)}
                                                        className={`mt-8 w-full py-3 rounded-xl font-bold transition-all text-white hover:opacity-90 hover:scale-[1.02] ${plan.color}`}
                                                    >
                                                        Cambiar a {plan.name}
                                                    </button>
                                                )}

                                                {isCurrent && (
                                                    <button disabled className="mt-8 w-full py-3 rounded-xl font-bold bg-gray-100 text-gray-400 cursor-default">
                                                        Plan Activo
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                        </div>
                    )}

                    {/* --- TAB 2: MIS SUSCRIPCIONES (DATA REAL DE STRIPE) --- */}
                    {activeTab === 'my_subscriptions' && (
                        <div className="space-y-4 max-w-5xl mx-auto">
                            <div className="mb-6 flex justify-between items-center">
                                <div>
                                    <h3 className="text-lg font-bold text-gray-900 dark:text-white">Servicios Contratados</h3>
                                    <p className="text-sm text-gray-500">Listado sincronizado automáticamente con Stripe.</p>
                                </div>
                                <button onClick={handlePortal} className="text-sm font-medium text-red-500 hover:text-red-600 flex items-center gap-1">
                                    <ExternalLink size={14} /> Gestionar en Stripe
                                </button>
                            </div>

                            {realSubscriptions.length === 0 ? (
                                <div className="text-center py-12 bg-gray-50 dark:bg-gray-800 rounded-xl border border-dashed border-gray-300 dark:border-gray-700">
                                    <div className="mx-auto w-12 h-12 bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center mb-3 text-gray-400">
                                        <Layers size={24} />
                                    </div>
                                    <p className="text-gray-500 dark:text-gray-400 font-medium">No se encontraron suscripciones activas.</p>
                                    <p className="text-xs text-gray-400 mt-1">Si acabas de pagar, espera unos segundos y recarga.</p>
                                </div>
                            ) : (
                                realSubscriptions.map((sub) => (
                                    <div key={sub.id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 flex flex-col md:flex-row items-center justify-between shadow-sm animate-in fade-in slide-in-from-bottom-2">
                                        <div className="flex items-center gap-4 w-full md:w-auto">
                                            <div className={`p-3 rounded-xl ${sub.type === 'base' ? 'bg-yellow-50 text-yellow-600 dark:bg-yellow-900/20 dark:text-yellow-400' : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400'}`}>
                                                {sub.type === 'base' ? <Crown size={24} /> : <Building2 size={24} />}
                                            </div>
                                            <div>
                                                <h4 className="font-bold text-gray-900 dark:text-white text-lg">{sub.product_name}</h4>
                                                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 font-mono text-xs">
                                                    <span>ID: {sub.stripe_subscription_id?.slice(-8)}</span>
                                                    {sub.quantity > 1 && (
                                                        <span className="bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded text-gray-700 dark:text-gray-300 font-bold">x{sub.quantity}</span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-8 mt-4 md:mt-0 w-full md:w-auto justify-between md:justify-end">
                                            <div className="text-center">
                                                <p className="text-xs text-gray-400 uppercase font-bold mb-1">Renovación</p>
                                                <span className="text-gray-700 dark:text-gray-300 text-sm font-medium">
                                                    {sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString() : 'N/A'}
                                                </span>
                                            </div>
                                            <div className="text-center">
                                                <p className="text-xs text-gray-400 uppercase font-bold mb-1">Estado</p>
                                                <span className={`text-xs font-bold px-2 py-1 rounded capitalize ${sub.status === 'active'
                                                        ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400'
                                                        : 'bg-red-50 text-red-600 dark:bg-red-900/20'
                                                    }`}>
                                                    {sub.status}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}

                    {/* --- TABS 3 & 4: REDIRECCIÓN SEGURA --- */}
                    {(activeTab === 'payment_methods' || activeTab === 'invoices') && (
                        <div className="max-w-2xl mx-auto text-center py-20">
                            <div className="w-20 h-20 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-6">
                                {activeTab === 'invoices' ? <FileText size={40} className="text-gray-400" /> : <CreditCard size={40} className="text-gray-400" />}
                            </div>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                                {activeTab === 'invoices' ? 'Historial de Facturación' : 'Métodos de Pago'}
                            </h3>
                            <p className="text-gray-500 dark:text-gray-400 mb-8 max-w-md mx-auto">
                                Por seguridad, esta información se gestiona en nuestro portal encriptado.
                            </p>
                            <button
                                onClick={handlePortal}
                                className="px-8 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition shadow-lg flex items-center gap-2 mx-auto"
                            >
                                <ExternalLink size={18} /> Ir al Portal Seguro
                            </button>
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
}

// --- SUBCOMPONENTES ---

const TabButton = ({ id, label, active, onClick, highlight }) => (
    <button
        onClick={() => onClick(id)}
        className={`relative pb-4 px-2 text-sm font-bold transition-colors whitespace-nowrap outline-none
            ${active === id
                ? 'text-indigo-600 dark:text-indigo-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }
        `}
    >
        {label}
        {active === id && (
            <span className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 dark:bg-indigo-400 rounded-t-full"></span>
        )}
        {highlight && active !== id && (
            <span className="absolute top-0 right-0 w-2 h-2 bg-indigo-500 rounded-full"></span>
        )}
    </button>
);

const AddonCard = ({ title, desc, price, icon: Icon, color, features, onBuy }) => (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-6 hover:border-indigo-300 transition-all shadow-sm hover:shadow-md">
        <div className="flex-1">
            <div className="flex items-center gap-4 mb-3">
                <div className={`p-3 rounded-lg ${color === 'indigo' ? 'bg-indigo-50 text-indigo-600' : 'bg-emerald-50 text-emerald-600'}`}>
                    <Icon size={24} />
                </div>
                <div>
                    <h4 className="text-lg font-bold text-gray-900 dark:text-white">{title}</h4>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{desc}</p>
                </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 ml-14">
                {features.map((f, i) => (
                    <span key={i} className="text-xs text-gray-600 dark:text-gray-300 flex items-center gap-1">
                        <Check size={12} className="text-indigo-500" /> {f}
                    </span>
                ))}
            </div>
        </div>

        <div className="text-center min-w-[140px] border-l border-gray-100 dark:border-gray-700 pl-6">
            <div className="mb-3">
                <span className="text-2xl font-extrabold text-gray-900 dark:text-white block">{price}</span>
                <span className="text-xs text-gray-400 font-medium">/mensual</span>
            </div>
            <button
                onClick={onBuy}
                className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold text-sm transition shadow-md flex items-center justify-center gap-2"
            >
                <PlusCircle size={16} /> Añadir
            </button>
        </div>
    </div>
);