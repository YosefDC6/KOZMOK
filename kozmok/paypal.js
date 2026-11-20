// paypal.js — cliente mínimo de la API REST de PayPal (Orders v2), sin
// dependencias: usa fetch de Node 18+.
//
// Funciona en SANDBOX (modo de prueba, sin dinero real) por defecto. Para
// el modo real habría que poner PAYPAL_MODO=live **y** PAYPAL_PERMITIR_REAL=1;
// sin las dos, aunque se escriba "live" se queda en sandbox.
//
// .env:
//   PAYPAL_CLIENT_ID=...       (de developer.paypal.com > Apps & Credentials > Sandbox)
//   PAYPAL_CLIENT_SECRET=...
//   PAYPAL_MONEDA=MXN
require('./env.js');

const real = process.env.PAYPAL_MODO === 'live' && process.env.PAYPAL_PERMITIR_REAL === '1';
const CFG = {
    clientId: (process.env.PAYPAL_CLIENT_ID || '').trim(),
    secret: (process.env.PAYPAL_CLIENT_SECRET || '').trim(),
    moneda: (process.env.PAYPAL_MONEDA || 'MXN').trim().toUpperCase(),
    modo: real ? 'live' : 'sandbox',
    base: real ? 'https://api-m.paypal.com' : (process.env.PAYPAL_API_PRUEBAS || 'https://api-m.sandbox.paypal.com'),   // PAYPAL_API_PRUEBAS: solo para pruebas automáticas
};
const configurado = () => !!(CFG.clientId && CFG.secret);

let token = null, tokenVence = 0;
async function obtenerToken() {
    if (token && Date.now() < tokenVence - 60000) return token;
    const r = await fetch(`${CFG.base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${CFG.clientId}:${CFG.secret}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) {
        throw errorPayPal(r.status === 401 ? 'PayPal rechazó las credenciales: revisa PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET en el .env' : 'No se pudo conectar con PayPal', d);
    }
    token = d.access_token;
    tokenVence = Date.now() + Number(d.expires_in || 3000) * 1000;
    return token;
}

function errorPayPal(mensaje, detalle, status) {
    const e = new Error(mensaje);
    e.paypal = detalle || null;
    e.status = status || 502;
    e.publico = true;
    return e;
}

async function llamar(metodo, ruta, cuerpo, { requestId } = {}) {
    const t = await obtenerToken();
    const r = await fetch(CFG.base + ruta, {
        method: metodo,
        headers: {
            Authorization: `Bearer ${t}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),   // idempotencia: repetir no cobra dos veces
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(20000),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, datos: d };
}

const dosDecimales = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

// Crea una orden por un monto calculado en el servidor.
//   referencia: id interno (pedido o recarga) que PayPal devuelve en custom_id
//   factura:    folio visible (numero_orden); PayPal no deja pagar dos veces el mismo
async function crearOrden({ monto, referencia, descripcion, factura, requestId }) {
    const { ok, status, datos } = await llamar('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
            reference_id: String(referencia).slice(0, 256),
            custom_id: String(referencia).slice(0, 127),
            ...(factura ? { invoice_id: String(factura).slice(0, 127) } : {}),
            description: String(descripcion || 'Compra en Kozmok').slice(0, 127),
            amount: { currency_code: CFG.moneda, value: dosDecimales(monto) },
        }],
        // Sin payment_source: así los botones del SDK pueden cobrar con cuenta
        // PayPal o con tarjeta. El envío lo maneja Kozmok, no PayPal.
        application_context: { brand_name: 'Kozmok', locale: 'es-MX', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
    }, { requestId });
    if (!ok || !datos.id) throw errorPayPal('PayPal no pudo crear la orden de pago', datos, status);
    return datos;
}

async function verOrden(id) {
    const { ok, status, datos } = await llamar('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
    if (!ok) throw errorPayPal('No se encontró la orden en PayPal', datos, status);
    return datos;
}

// Cobra una orden aprobada por el comprador. Devuelve lo esencial ya validado.
async function capturarOrden(id, { requestId } = {}) {
    const { ok, status, datos } = await llamar('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, { requestId });
    if (!ok) {
        const issue = ((datos.details || [])[0] || {}).issue || datos.name || '';
        // Tarjeta rechazada / fondos: el comprador puede intentar con otro método
        if (issue === 'INSTRUMENT_DECLINED' || issue === 'PAYER_ACTION_REQUIRED') {
            const e = errorPayPal('PayPal rechazó el método de pago. Intenta con otra tarjeta o cuenta.', datos, 402);
            e.reintentar = true;
            throw e;
        }
        if (issue === 'ORDER_ALREADY_CAPTURED') return resumenCaptura(await verOrden(id));
        throw errorPayPal('PayPal no pudo cobrar la orden', datos, status);
    }
    return resumenCaptura(datos);
}

function resumenCaptura(orden) {
    const pu = (orden.purchase_units || [])[0] || {};
    const cap = ((pu.payments || {}).captures || [])[0] || {};
    return {
        orden_id: orden.id,
        estado_orden: orden.status,                         // COMPLETED
        captura_id: cap.id || null,
        estado: cap.status || null,                         // COMPLETED | PENDING | DECLINED...
        motivo_pendiente: (cap.status_details || {}).reason || null,
        monto: cap.amount ? Number(cap.amount.value) : null,
        moneda: cap.amount ? cap.amount.currency_code : null,
        referencia: cap.custom_id || pu.custom_id || pu.reference_id || null,
        pagador: orden.payer ? { correo: orden.payer.email_address, id: orden.payer.payer_id } : null,
        crudo: orden,
    };
}

// Reembolso total (o parcial si se da monto) de un cobro.
async function reembolsar(capturaId, { monto, nota, requestId } = {}) {
    const cuerpo = { note_to_payer: String(nota || 'Reembolso de Kozmok').slice(0, 255) };
    if (monto != null) cuerpo.amount = { currency_code: CFG.moneda, value: dosDecimales(monto) };
    const { ok, status, datos } = await llamar('POST', `/v2/payments/captures/${encodeURIComponent(capturaId)}/refund`, cuerpo, { requestId });
    if (!ok) {
        const issue = ((datos.details || [])[0] || {}).issue || '';
        if (issue === 'CAPTURE_FULLY_REFUNDED') return { id: null, estado: 'COMPLETED', ya_reembolsado: true };
        throw errorPayPal('PayPal no pudo hacer el reembolso', datos, status);
    }
    return { id: datos.id, estado: datos.status };
}

module.exports = { CFG, configurado, crearOrden, verOrden, capturarOrden, reembolsar, dosDecimales };
