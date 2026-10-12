// public/admin/js/erp.js
// Utilidades compartidas por las pantallas del módulo ERP.

const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// "2026-09" -> "Sep"
function mesCorto(yyyymm) {
    const m = Number(String(yyyymm).slice(5, 7));
    return MESES_CORTOS[m - 1] || yyyymm;
}

function origenPill(origen) {
    return origen === 'erp'
        ? '<span class="origen-pill o-erp">ERP</span>'
        : '<span class="origen-pill">En línea</span>';
}

function pagoPill(estado) {
    return `<span class="estado-pill pago-pill pp-${estado}">${estado === 'pagado' ? 'Pagado' : 'Pendiente'}</span>`;
}

// Barras horizontales simples para "productos más vendidos".
function renderBarrasH(el, filas, { etiqueta = 'nombre', valor = 'unidades' } = {}) {
    if (!el) return;
    if (!filas || filas.length === 0) { el.innerHTML = '<p style="color:var(--text-muted)">Todavía no hay ventas registradas.</p>'; return; }
    const max = Math.max(...filas.map((f) => Number(f[valor]) || 0), 1);
    el.innerHTML = filas.map((f) => `
        <div class="hbar">
            <span class="hb-name" title="${f[etiqueta]}">${f[etiqueta]}</span>
            <span class="hb-track"><span class="hb-fill" style="width:${Math.round((Number(f[valor]) / max) * 100)}%;display:block"></span></span>
            <span class="hb-val">${f[valor]}</span>
        </div>`).join('');
}

// Colores del tema actual (para Chart.js, que no lee variables CSS).
function colorTema(nombre, respaldo) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
    return v || respaldo;
}

// Gráfica de ventas por mes (barras apiladas: tienda en línea + ERP).
function graficaVentasMes(canvas, ventas) {
    if (!canvas || !window.Chart) return null;
    const texto = colorTema('--text-muted', '#8A93A7');
    const linea = colorTema('--line', '#2A3446');
    return new Chart(canvas, {
        type: 'bar',
        data: {
            labels: ventas.map((v) => mesCorto(v.mes)),
            datasets: [
                { label: 'Tienda en línea', data: ventas.map((v) => v.en_linea), backgroundColor: colorTema('--accent-dim', '#33406B'), stack: 'v' },
                { label: 'Órdenes ERP', data: ventas.map((v) => v.erp), backgroundColor: colorTema('--accent', '#6E8BF0'), stack: 'v' },
            ],
        },
        options: {
            plugins: {
                legend: { position: 'bottom', labels: { color: texto } },
                tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${formatoMoneda(c.raw)}` } },
            },
            scales: {
                x: { stacked: true, ticks: { color: texto }, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, ticks: { color: texto, callback: (v) => '$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : v) }, grid: { color: linea } },
            },
        },
    });
}

// Bloque "Integración entre módulos": CRM <-> ERP <-> SCM, con un dato
// real de cada uno y enlace a su pantalla (si el rol la puede ver).
function renderIntegracion(el, k) {
    if (!el) return;
    const u = Sesion.usuario();
    const rol = (u && u.rol) || 'vendedor';
    const mod = (href, key, ic, titulo, desc, dato, central) => {
        const tag = puedeVer(rol, key) ? `a href="${href}"` : 'div';
        return `<${tag} class="integra-mod ${central ? 'central' : ''}">
            <span class="im-ico">${icon(ic, 26)}</span>
            <span><strong>${titulo}</strong><span>${desc}</span><span class="im-dato">${dato}</span></span>
        </${tag.split(' ')[0]}>`;
    };
    el.innerHTML = `
        ${mod('/admin/clientes.html', 'clientes', 'user', 'CRM', 'Clientes e interacciones', `${k.clientes_total} clientes · ${k.interacciones} interacciones`)}
        <span class="integra-sep">⇄</span>
        ${mod('/admin/ordenes-erp.html', 'ordenes-erp', 'clipboard', 'ERP', 'Órdenes de clientes, integración y reportes', `${k.ordenes_clientes} órdenes · ${k.ordenes_erp} capturadas en ERP`, true)}
        <span class="integra-sep">⇄</span>
        ${mod('/admin/scm.html', 'scm', 'package', 'SCM', 'Productos, inventario, proveedores y órdenes de compra', `${k.productos_activos} productos · ${k.ordenes_compra_abiertas} OC abiertas`)}
    `;
}

window.mesCorto = mesCorto;
window.origenPill = origenPill;
window.pagoPill = pagoPill;
window.renderBarrasH = renderBarrasH;
window.graficaVentasMes = graficaVentasMes;
window.renderIntegracion = renderIntegracion;
