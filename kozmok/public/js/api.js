// public/js/api.js
// Helper compartido para llamadas a la API y manejo de sesión.
//
// SEGURIDAD: la sesión vive en una cookie HttpOnly que pone el servidor
// (kz_sesion en la tienda, kz_admin en el panel). JavaScript no puede
// leerla, así que un script inyectado (XSS) no puede robarla. En
// localStorage solo se guarda lo necesario para pintar la interfaz
// (nombre, correo, rol), nunca un token ni una contraseña.

const API_BASE = '/api';

// Escapa texto antes de meterlo en innerHTML (contra XSS).
function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

async function api(path, options = {}) {
    const res = await fetch(API_BASE + path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kozmok' },
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) {
            if (location.pathname.startsWith('/admin/')) {
                // Sesión interna vencida o revocada -> de vuelta al login del panel
                if (!location.pathname.endsWith('login.html')) {
                    localStorage.removeItem('kz_usuario');
                    location.href = '/admin/login.html?vencida=1';
                }
            } else if (!path.startsWith('/auth/')) {
                // En la tienda: la sesión ya no existe en el servidor; se limpia
                // lo que se mostraba. Cada página decide si manda al login.
                localStorage.removeItem('kz_cliente');
            }
        }
        const err = new Error(data.message || data.error || 'Error en la solicitud');
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

// ---- Imagen de producto ----
// Si el producto no tiene imagen propia se usa una ilustración según su
// tipo (laptop, monitor, procesador...), con fondo transparente para que
// se integre con cualquier tema.
const ILUSTRACIONES = [
    [/aud[ií]fono|headset|diadema/, 'headphones'], [/webcam|c[aá]mara/, 'webcam'],
    [/mouse|rat[oó]n/, 'mouse'], [/teclado|keyboard/, 'keyboard'],
    [/fuente de poder|psu/, 'psu'], [/gabinete|case\b/, 'case'],
    [/memoria|ram\b|ddr/, 'ram'], [/ssd|nvme|disco|almacenamiento/, 'ssd'],
    [/^pc\b|escritorio|mini torre|workstation|servidor/, 'desktop'],
    [/placa base|motherboard|tarjeta madre/, 'board'], [/procesador|ryzen|intel core|cpu/, 'cpu'],
    [/tarjeta gr[aá]fica|rtx|gtx|radeon|gpu/, 'gpu'], [/monitor/, 'monitor'],
    [/laptop|macbook|notebook|port[aá]til/, 'laptop'],
    [/\bhub\b|adaptador|dock/, 'hub'],
    [/perif[eé]rico/, 'mouse'], [/accesorio/, 'headphones'], [/componente/, 'cpu'],
];
function ilustracionProducto(p) {
    const t = `${(p && p.nombre) || ''} ${(p && (p.categoria_nombre || p.categoria)) || ''}`.toLowerCase();
    const r = ILUSTRACIONES.find(([re]) => re.test(t));
    return `/img/productos/${r ? r[1] : 'generico'}.svg`;
}
function imagenProducto(p) {
    const u = p && p.imagen_url;
    return u && /^(https?:\/\/|\/)/i.test(u) ? esc(u) : ilustracionProducto(p);
}

// Precio con promoción: muestra el precio de lista tachado y la etiqueta.
function precioHTML(p, clase = 'product-price') {
    const promo = p && p.promocion && Number(p.precio_lista) > Number(p.precio);
    return `<span class="${clase}">${formatoMoneda(p.precio)}</span>` +
        (promo ? ` <s class="precio-lista">${formatoMoneda(p.precio_lista)}</s>` : '');
}
function etiquetaPromo(p) {
    return p && p.promocion ? `<span class="pc-badge promo" title="${esc(p.promocion.nombre)}">${esc(p.promocion.etiqueta)}</span>` : '';
}

const Sesion = {
    // El segundo parámetro (token) ya no se usa: la sesión va en la cookie.
    guardarCliente(cliente) {
        if (!cliente) return;
        const { id, nombre, correo, etapa_crm, puntos, codigo_socio } = cliente;
        localStorage.setItem('kz_cliente', JSON.stringify({ id, nombre, correo, etapa_crm, puntos, codigo_socio }));
    },
    cliente() {
        try { return JSON.parse(localStorage.getItem('kz_cliente')); } catch { return null; }
    },
    guardarUsuario(usuario) {
        if (!usuario) return;
        const { id, nombre, email, rol } = usuario;
        localStorage.setItem('kz_usuario', JSON.stringify({ id, nombre, email, rol }));
    },
    usuario() {
        try { return JSON.parse(localStorage.getItem('kz_usuario')); } catch { return null; }
    },
    // Cerrar sesión revoca la sesión en el servidor (keepalive: se manda
    // aunque la página cambie de inmediato) y borra lo local.
    cerrarSesionCliente() {
        localStorage.removeItem('kz_cliente');
        localStorage.removeItem('kz_token'); // restos de la versión anterior
        return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: 'cliente' }) }).catch(() => {});
    },
    cerrarSesionUsuario() {
        localStorage.removeItem('kz_usuario');
        localStorage.removeItem('kz_admin_token');
        return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: 'usuario' }) }).catch(() => {});
    },
    // Recupera (o limpia) la sesión de la tienda según el servidor: si la
    // cookie sigue vigente la persona aparece con sesión aunque se hayan
    // borrado los datos locales; si venció, se limpia.
    async sincronizar() {
        try {
            const r = await fetch('/api/auth/estado', { credentials: 'same-origin' }).then((x) => x.json());
            if (r && r.cliente) this.guardarCliente(r.cliente); else localStorage.removeItem('kz_cliente');
            return r ? r.cliente : null;
        } catch { return this.cliente(); }
    },
};
// Limpieza de tokens que guardaba la versión anterior en localStorage.
try { localStorage.removeItem('kz_token'); localStorage.removeItem('kz_admin_token'); } catch { /* nada */ }

// Manda al login guardando a dónde volver después
function irALogin(mensaje) {
    if (mensaje && window.toast) toast(mensaje, 'info');
    const next = encodeURIComponent(location.pathname + location.search + location.hash);
    const irYa = () => { location.href = `/login.html?next=${next}`; };
    if (mensaje) setTimeout(irYa, 800); else irYa();
}

// ---- Favoritos: cache local del set de ids para pintar corazones ----
const Favoritos = {
    _set: new Set(),
    async cargar() {
        const cliente = Sesion.cliente();
        if (!cliente) { this._set = new Set(); return this._set; }
        try {
            const favs = await api(`/clientes/${cliente.id}/favoritos`);
            this._set = new Set(favs.map((f) => f.id));
        } catch { this._set = new Set(); }
        return this._set;
    },
    tiene(productoId) { return this._set.has(Number(productoId)); },
    async alternar(productoId) {
        const cliente = Sesion.cliente();
        if (!cliente) { irALogin('Inicia sesión para guardar favoritos'); return null; }
        productoId = Number(productoId);
        if (this._set.has(productoId)) {
            await api(`/clientes/${cliente.id}/favoritos/${productoId}`, { method: 'DELETE' });
            this._set.delete(productoId);
            return false;
        }
        await api(`/clientes/${cliente.id}/favoritos`, { method: 'POST', body: { producto_id: productoId } });
        this._set.add(productoId);
        return true;
    }
};

function formatoMoneda(valor, decimales) {
    const n = Number(valor || 0);
    const d = decimales !== undefined ? decimales : (Math.round(n) === n ? 0 : 2);
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: d, maximumFractionDigits: d });
}

function formatoFecha(fecha) {
    if (!fecha) return '—';
    return new Date(fecha).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatoFechaHora(fecha) {
    if (!fecha) return '—';
    return new Date(fecha).toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Navegador legible a partir del User-Agent (para "sesiones abiertas").
function navegadorDe(ua) {
    ua = String(ua || '');
    const nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|node|python|axios|Postman/i.test(ua) ? 'Script / API' : 'Navegador';
    const so = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return so ? `${nav} en ${so}` : nav;
}

// ---- Carrito sin sesión ----
// Lo que agrega un visitante sin cuenta se guarda en el navegador y se pasa
// a su carrito real (servidor) en cuanto inicia sesión o crea su cuenta.
const CarritoInvitado = {
    CLAVE: 'kz_carrito_invitado',
    leer() {
        try {
            const l = JSON.parse(localStorage.getItem(this.CLAVE) || '[]');
            return Array.isArray(l) ? l.filter((x) => Number.isInteger(x.producto_id) && x.cantidad > 0) : [];
        } catch { return []; }
    },
    guardar(lista) { try { localStorage.setItem(this.CLAVE, JSON.stringify(lista)); } catch { /* sin almacenamiento */ } },
    total() { return this.leer().reduce((a, i) => a + i.cantidad, 0); },
    cantidadDe(id) { const it = this.leer().find((x) => x.producto_id === Number(id)); return it ? it.cantidad : 0; },
    agregar(id, cantidad = 1, garantia = 'none') {
        const lista = this.leer();
        const it = lista.find((x) => x.producto_id === Number(id));
        if (it) { it.cantidad += cantidad; if (garantia && garantia !== 'none') it.garantia = garantia; }
        else lista.push({ producto_id: Number(id), cantidad, garantia: garantia || 'none' });
        this.guardar(lista);
    },
    cambiar(id, cambios) {
        const lista = this.leer();
        const it = lista.find((x) => x.producto_id === Number(id));
        if (it) Object.assign(it, cambios);
        this.guardar(lista);
    },
    quitar(id) { this.guardar(this.leer().filter((x) => x.producto_id !== Number(id))); },
    vaciar() { try { localStorage.removeItem(this.CLAVE); } catch { /* nada */ } },
    // Pasa lo guardado al carrito de la cuenta. Lo que ya no tenga stock se avisa.
    async fusionar() {
        const lista = this.leer();
        const res = { pasados: 0, avisos: [] };
        for (const it of lista) {
            try {
                await api('/carrito/agregar', { method: 'POST', body: { producto_id: it.producto_id, cantidad: it.cantidad, garantia: it.garantia } });
                res.pasados += it.cantidad;
            } catch (e) { res.avisos.push(e.message); }
        }
        this.vaciar();
        return res;
    },
};
window.CarritoInvitado = CarritoInvitado;

// Agregar al carrito desde cualquier parte de la tienda (catálogo, ficha,
// Arma tu PC, asesor, comparador, favoritos). Con sesión va al servidor
// (POST /carrito/agregar); sin sesión se guarda en el navegador sin
// pasarse del stock.
async function agregarProducto(productoId, cantidad = 1, garantia = 'none') {
    if (Sesion.cliente()) {
        try {
            await api('/carrito/agregar', { method: 'POST', body: { producto_id: productoId, cantidad, garantia } });
        } catch (e) {
            if (e.status !== 401) throw e;
            return agregarProducto(productoId, cantidad, garantia); // la sesión venció: se guarda como invitado
        }
    } else {
        const p = await api(`/catalogo/${productoId}`);
        const ya = CarritoInvitado.cantidadDe(productoId);
        if (Number(p.stock) <= 0) throw new Error(`"${p.nombre}" está agotado`);
        if (ya + cantidad > Number(p.stock)) throw new Error(ya ? `Solo hay ${p.stock} disponibles y ya tienes ${ya} en tu carrito` : `Solo hay ${p.stock} disponibles`);
        CarritoInvitado.agregar(productoId, cantidad, garantia);
    }
    actualizarBadgeCarrito();
}
window.agregarProducto = agregarProducto;

function actualizarBadgeCarrito() {
    const cliente = Sesion.cliente();
    const el = document.getElementById('cart-badge');
    if (!el) return;
    const pintar = (n) => { el.style.display = n > 0 ? 'flex' : 'none'; el.textContent = n; };
    if (!cliente) { pintar(CarritoInvitado.total()); return; }
    api(`/carrito/${cliente.id}`).then((c) => pintar(c.resumen ? c.resumen.piezas : 0)).catch(() => pintar(CarritoInvitado.total()));
}

document.addEventListener('DOMContentLoaded', actualizarBadgeCarrito);

// Red de seguridad: si una promesa (normalmente una llamada a la API) falla
// sin que nadie la atrape, se avisa con un toast — nunca con texto crudo en
// la consola, que se ve fuera de contexto para el usuario final.
window.addEventListener('unhandledrejection', (e) => {
    const msg = (e && e.reason && e.reason.message) ? e.reason.message : '';
    if (window.toast) toast(msg || 'Hubo un problema de conexión. Intenta de nuevo.', 'error');
    e.preventDefault();
});

// Exponer en window: las declaraciones `const` NO se vuelven propiedades
// de window por sí solas, y layout.js / chatbot.js hacen `window.Sesion`.
window.api = api;
window.esc = esc;
window.Sesion = Sesion;
window.Favoritos = Favoritos;
window.irALogin = irALogin;
window.formatoMoneda = formatoMoneda;
window.formatoFecha = formatoFecha;
window.formatoFechaHora = formatoFechaHora;
window.navegadorDe = navegadorDe;
window.precioHTML = precioHTML;
window.etiquetaPromo = etiquetaPromo;
window.actualizarBadgeCarrito = actualizarBadgeCarrito;
