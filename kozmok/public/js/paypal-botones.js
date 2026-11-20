// public/js/paypal-botones.js
// Carga el SDK de PayPal (una sola vez) con el client-id que da el servidor
// y pinta los botones "PayPal" y "Tarjeta de débito o crédito".
//
//   PayPalKZ.botones('#contenedor', {
//     crearOrden: async () => idDeLaOrden,      // el servidor la crea con su monto
//     alAprobar:  async (ordenId) => { ... },  // el servidor la cobra
//     alCancelar: () => { ... },
//   });
// Si PayPal rechaza la tarjeta al cobrar, se reinicia para elegir otra.
(function () {
    let cfg = null, sdk = null;

    async function config() {
        if (!cfg) cfg = await api('/pagos/paypal/config').catch(() => ({ activo: false }));
        return cfg;
    }

    async function cargarSDK() {
        const c = await config();
        if (!c.activo) throw new Error('El pago con PayPal o tarjeta no está disponible por ahora.');
        if (window.paypal && window.paypal.Buttons) return window.paypal;
        if (!sdk) {
            sdk = new Promise((ok, mal) => {
                const s = document.createElement('script');
                const q = new URLSearchParams({ 'client-id': c.client_id, currency: c.moneda || 'MXN', intent: 'capture', locale: 'es_MX', components: 'buttons' });
                s.src = 'https://www.paypal.com/sdk/js?' + q.toString();
                s.onload = () => (window.paypal ? ok(window.paypal) : mal(new Error('PayPal no cargó')));
                s.onerror = () => { sdk = null; mal(new Error('No se pudo cargar PayPal. Revisa tu conexión e intenta de nuevo.')); };
                document.head.appendChild(s);
            });
        }
        return sdk;
    }

    async function botones(selector, { crearOrden, alAprobar, alCancelar } = {}) {
        const cont = typeof selector === 'string' ? document.querySelector(selector) : selector;
        if (!cont) return;
        let pp;
        try { pp = await cargarSDK(); } catch (e) {
            cont.innerHTML = `<div class="aviso-pago">${escHTML(e.message)}</div>`;
            return;
        }
        cont.innerHTML = '';
        pp.Buttons({
            style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 45 },
            createOrder: async () => {
                try { return await crearOrden(); } catch (e) { toast(e.message, 'error'); throw e; }
            },
            onApprove: async (data, actions) => {
                try { await alAprobar(data.orderID); } catch (e) {
                    // Tarjeta o cuenta rechazada al cobrar: que elija otra forma de pago
                    if (e.datos && e.datos.reintentar && actions && actions.restart) { toast(e.message, 'warn'); return actions.restart(); }
                    toast(e.message, 'error');
                }
            },
            onCancel: () => { if (alCancelar) alCancelar(); },
            onError: (err) => { console.error('PayPal:', err); toast('PayPal tuvo un problema. Intenta de nuevo en un momento.', 'error'); },
        }).render(cont).catch(() => { cont.innerHTML = '<div class="aviso-pago">No se pudieron mostrar los botones de PayPal.</div>'; });
    }

    window.PayPalKZ = { config, botones };
})();
