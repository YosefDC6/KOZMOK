// public/js/compra.js
// Piezas compartidas del flujo de compra: Carrito → Checkout y pago →
// (Pago con Monedero) → Confirmación.

const PASOS_COMPRA = [
    { k: 'carrito', label: 'Carrito' },
    { k: 'checkout', label: 'Datos y pago' },
    { k: 'confirmacion', label: 'Confirmación' },
];
function pasosCompra(actual) {
    const i = PASOS_COMPRA.findIndex((p) => p.k === actual);
    return `<ol class="pasos-compra" aria-label="Pasos de la compra">${PASOS_COMPRA.map((p, n) => `
        <li class="${n < i ? 'hecho' : n === i ? 'actual' : ''}" ${n === i ? 'aria-current="step"' : ''}>
            <span class="pc-num">${n < i ? icon('check', 13) : n + 1}</span>${p.label}
        </li>`).join('')}</ol>`;
}

// Resumen de la compra calculado por el servidor (subtotal, promociones,
// impuestos configurados, envío, puntos y total).
function resumenHTML(r, { puntos = true } = {}) {
    const imp = (r.impuestos_detalle || []).map((i) =>
        `<div class="resumen-linea muted"><span>${esc(i.nombre)} (${Number(i.porcentaje)}%)</span><span class="mono">${formatoMoneda(i.monto, 2)}</span></div>`).join('');
    return `
        <div class="resumen-linea muted"><span>Productos (${r.piezas} pieza${r.piezas === 1 ? '' : 's'})</span><span class="mono">${formatoMoneda(r.productos, 2)}</span></div>
        ${r.garantias > 0 ? `<div class="resumen-linea muted"><span>Garantías extendidas</span><span class="mono">${formatoMoneda(r.garantias, 2)}</span></div>` : ''}
        ${r.ahorro_promociones > 0 ? `<div class="resumen-linea ok"><span>Ahorro por promociones</span><span class="mono">-${formatoMoneda(r.ahorro_promociones, 2)}</span></div>` : ''}
        <div class="resumen-linea"><span>Subtotal</span><span class="mono">${formatoMoneda(r.subtotal, 2)}</span></div>
        ${imp}
        <div class="resumen-linea muted"><span>Envío</span><span class="mono">${r.envio === 0 ? 'Gratis' : formatoMoneda(r.envio, 2)}</span></div>
        ${puntos && r.descuento_puntos > 0 ? `<div class="resumen-linea ok"><span>Descuento por puntos</span><span class="mono">-${formatoMoneda(r.descuento_puntos, 2)}</span></div>` : ''}
        <div class="resumen-linea total"><span>Total</span><span class="mono">${formatoMoneda(r.total, 2)}</span></div>`;
}

window.pasosCompra = pasosCompra;
window.resumenHTML = resumenHTML;
