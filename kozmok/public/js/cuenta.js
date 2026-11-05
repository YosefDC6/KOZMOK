// public/js/cuenta.js
// Barra lateral compartida de "Mi cuenta" + guardia de sesión.
// Cada página de cuenta llama:  montarCuenta('clave', async (panel, PERFIL) => { ... })

const CUENTA_LINKS = [
    { href: '/perfil.html', key: 'perfil', label: 'Mi cuenta', ic: 'home' },
    { href: '/pedidos.html', key: 'pedidos', label: 'Mis pedidos', ic: 'package' },
    { href: '/monedero.html', key: 'monedero', label: 'Mi monedero', ic: 'wallet' },
    { href: '/recompensas.html', key: 'recompensas', label: 'Club de puntos', ic: 'star' },
    { href: '/favoritos.html', key: 'favoritos', label: 'Favoritos', ic: 'heart' },
    { href: '/resenas.html', key: 'resenas', label: 'Mis reseñas', ic: 'chat' },
    { href: '/garantias.html', key: 'garantias', label: 'Mis garantías', ic: 'shield' },
    { href: '/direcciones.html', key: 'direcciones', label: 'Direcciones', ic: 'pin' },
    { href: '/pagos.html', key: 'pagos', label: 'Métodos de pago', ic: 'card' },
    { href: '/soporte.html', key: 'soporte', label: 'Atención a clientes', ic: 'help' },
    { href: '/datos.html', key: 'datos', label: 'Mis datos', ic: 'id' },
    { href: '/seguridad.html', key: 'seguridad', label: 'Seguridad', ic: 'lock' },
    { href: '/preferencias.html', key: 'preferencias', label: 'Preferencias', ic: 'settings' },
];

async function montarCuenta(key, render) {
    // La sesión se valida contra el servidor (cookie HttpOnly), no solo
    // contra lo guardado en el navegador.
    const sesion = Sesion.cliente() || await Sesion.sincronizar();
    if (!sesion || !sesion.id) { irALogin(); return; }

    const nav = document.getElementById('cuenta-nav');
    nav.innerHTML = `
        <div class="cuenta-user">
            <span class="cuenta-avatar">${esc((sesion.nombre[0] || 'U').toUpperCase())}</span>
            <div>
                <strong id="cn-nombre">${esc(sesion.nombre)}</strong>
                <span id="cn-correo">${esc(sesion.correo)}</span>
            </div>
        </div>
        <div class="cuenta-links">
            ${CUENTA_LINKS.map((l) =>
                `<a href="${l.href}" class="${l.key === key ? 'active' : ''}">${icon(l.ic)}<span>${l.label}</span></a>`
            ).join('')}
        </div>
        <a href="/ayuda.html" class="cuenta-help">${icon('help')}<span>Ayuda y soporte</span></a>
        <button class="menu-logout" id="cn-logout">${icon('logout')}<span>Cerrar sesión</span></button>
    `;
    document.getElementById('cn-logout').addEventListener('click', async () => {
        await Sesion.cerrarSesionCliente();
        if (window.toast) toast('Sesión cerrada', 'ok');
        setTimeout(() => location.href = '/index.html', 350);
    });

    let PERFIL;
    try {
        PERFIL = await api(`/clientes/${sesion.id}`);
    } catch (e) {
        if (e.status === 401 || e.status === 403) { localStorage.removeItem('kz_cliente'); irALogin('Tu sesión terminó. Inicia sesión de nuevo.'); return; }
        throw e;
    }
    Sesion.guardarCliente({ ...sesion, ...PERFIL });
    window.PERFIL = PERFIL;
    document.getElementById('cn-nombre').textContent = PERFIL.nombre;
    document.getElementById('cn-correo').textContent = PERFIL.correo;

    const panel = document.getElementById('cuenta-panel');
    try {
        await render(panel, PERFIL);
    } catch (e) {
        panel.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
    }
}
window.montarCuenta = montarCuenta;

// Helpers de dominio compartidos entre páginas de cuenta
window.ESTADO_LABEL = { pendiente: 'Pendiente de pago', confirmado: 'Procesada', procesando: 'En preparación', enviado: 'En envío', entregado: 'Entregada', cancelado: 'Cancelada' };
window.METODO_LABEL = { tarjeta: 'Tarjeta', paypal: 'PayPal', transferencia: 'Transferencia', monedero: 'Monedero', efectivo: 'Efectivo', tienda: 'Pago en tienda' };
window.NIVEL_SOCIO = { Prospecto: 'Socio nuevo', Activo: 'Nivel Plata', Frecuente: 'Nivel Oro', Inactivo: 'Inactivo' };
window.val = (id) => document.getElementById(id).value.trim();
