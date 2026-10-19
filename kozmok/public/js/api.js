// public/js/api.js
// Helper compartido para llamadas a la API y manejo de sesión.

const API_BASE = '/api';

async function api(path, options = {}) {
    // En páginas del equipo interno (/admin/*) se usa el token de admin;
    // en la tienda, el token del cliente. Nunca se mezclan: si se hiciera
    // `admin_token || token`, un token de admin viejo en el navegador se
    // mandaría en la tienda, el servidor lo rechazaría (401) y el guardia
    // de cuenta rebotaría al login una y otra vez.
    const esPanel = location.pathname.startsWith('/admin/');
    const token = esPanel
        ? localStorage.getItem('kz_admin_token')
        : localStorage.getItem('kz_token');
    const res = await fetch(API_BASE + path, {
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // Sesión interna vencida/ inválida -> de vuelta al login del panel
        if (res.status === 401 && location.pathname.startsWith('/admin/') && !location.pathname.endsWith('login.html')) {
            localStorage.removeItem('kz_usuario');
            localStorage.removeItem('kz_admin_token');
            location.href = '/admin/login.html';
        }
        throw new Error(data.message || data.error || 'Error en la solicitud');
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
function imagenProducto(p) { return (p && p.imagen_url) || ilustracionProducto(p); }

const Sesion = {
    guardarCliente(cliente, token) {
        localStorage.setItem('kz_cliente', JSON.stringify(cliente));
        localStorage.setItem('kz_token', token);
    },
    cliente() {
        try { return JSON.parse(localStorage.getItem('kz_cliente')); } catch { return null; }
    },
    guardarUsuario(usuario, token) {
        localStorage.setItem('kz_usuario', JSON.stringify(usuario));
        localStorage.setItem('kz_admin_token', token);
    },
    usuario() {
        try { return JSON.parse(localStorage.getItem('kz_usuario')); } catch { return null; }
    },
    cerrarSesionCliente() {
        localStorage.removeItem('kz_cliente');
        localStorage.removeItem('kz_token');
    },
    cerrarSesionUsuario() {
        localStorage.removeItem('kz_usuario');
        localStorage.removeItem('kz_admin_token');
    }
};

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

function formatoMoneda(valor) {
    return Number(valor || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
}

function formatoFecha(fecha) {
    if (!fecha) return '—';
    return new Date(fecha).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ---- Carrito sin sesión ----
// Lo que agrega un visitante sin cuenta se guarda en el navegador y se pasa
// a su carrito real (servidor) en cuanto inicia sesión o crea su cuenta.
const CarritoInvitado = {
    CLAVE: 'kz_carrito_invitado',
    leer() { try { return JSON.parse(localStorage.getItem(this.CLAVE) || '[]'); } catch { return []; } },
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
                await api('/carrito', { method: 'POST', body: { producto_id: it.producto_id, cantidad: it.cantidad, garantia: it.garantia } });
                res.pasados += it.cantidad;
            } catch (e) { res.avisos.push(e.message); }
        }
        this.vaciar();
        return res;
    },
};
window.CarritoInvitado = CarritoInvitado;

// Agregar al carrito desde cualquier parte de la tienda (catálogo, ficha,
// Arma tu PC, asesor, comparador, favoritos). Con sesión va al servidor;
// sin sesión se guarda en el navegador sin pasarse del stock.
async function agregarProducto(productoId, cantidad = 1, garantia = 'none') {
    if (Sesion.cliente()) {
        await api('/carrito', { method: 'POST', body: { producto_id: productoId, cantidad, garantia } });
    } else {
        const p = await api(`/productos/${productoId}`);
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
    if (!cliente) {
        const n = CarritoInvitado.total();
        el.style.display = n > 0 ? 'flex' : 'none';
        el.textContent = n;
        return;
    }
    api(`/carrito/${cliente.id}`).then((items) => {
        const total = items.reduce((acc, i) => acc + i.cantidad, 0);
        el.style.display = total > 0 ? 'flex' : 'none';
        el.textContent = total;
    }).catch(() => {});
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
window.Sesion = Sesion;
window.Favoritos = Favoritos;
window.irALogin = irALogin;
window.formatoMoneda = formatoMoneda;
window.formatoFecha = formatoFecha;
window.actualizarBadgeCarrito = actualizarBadgeCarrito;
