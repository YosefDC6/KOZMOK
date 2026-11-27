// public/js/cuenta.js
// Barra lateral compartida de "Mi cuenta" + guardia de sesión.
// Cada página de cuenta llama:  montarCuenta('clave', async (panel, PERFIL) => { ... })

const CUENTA_LINKS = [
    { href: '/perfil.html', key: 'perfil', label: 'Resumen', ic: 'home' },
    { href: '/pedidos.html', key: 'pedidos', label: 'Mis pedidos', ic: 'package' },
    { href: '/devoluciones.html', key: 'devoluciones', label: 'Devoluciones', ic: 'undo' },
    { href: '/recompensas.html', key: 'recompensas', label: 'Club de puntos', ic: 'star' },
    { href: '/monedero.html', key: 'monedero', label: 'Mi monedero', ic: 'wallet' },
    { href: '/cupones.html', key: 'cupones', label: 'Mis cupones', ic: 'tag' },
    { href: '/favoritos.html', key: 'favoritos', label: 'Favoritos', ic: 'heart' },
    { href: '/resenas.html', key: 'resenas', label: 'Mis reseñas', ic: 'chat' },
    { href: '/garantias.html', key: 'garantias', label: 'Mis garantías', ic: 'shield' },
    { href: '/direcciones.html', key: 'direcciones', label: 'Direcciones', ic: 'pin' },
    { href: '/pagos.html', key: 'pagos', label: 'Formas de pago', ic: 'card' },
    { href: '/soporte.html', key: 'soporte', label: 'Soporte', ic: 'help' },
    { href: '/datos.html', key: 'datos', label: 'Mis datos', ic: 'id' },
    { href: '/seguridad.html', key: 'seguridad', label: 'Seguridad', ic: 'lock' },
    { href: '/preferencias.html', key: 'preferencias', label: 'Preferencias', ic: 'settings' },
];

async function montarCuenta(key, render) {
    window.KZ_PAGINA_PRIVADA = true;
    const sesion = Sesion.cliente();
    if (!sesion || !sesion.id) { irALogin(); return; }

    const nav = document.getElementById('cuenta-nav');
    nav.innerHTML = `
        <div class="cuenta-user">
            <span class="cuenta-avatar">${(sesion.nombre[0] || 'U').toUpperCase()}</span>
            <div>
                <strong id="cn-nombre">${escHTML(sesion.nombre)}</strong>
                <span id="cn-correo">${escHTML(sesion.correo)}</span>
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
    // en el celular el menú es una fila deslizable: se centra la sección actual
    const act = nav.querySelector('.cuenta-links a.active');
    if (act && matchMedia('(max-width: 860px)').matches) act.scrollIntoView({ block: 'nearest', inline: 'center' });
    document.getElementById('cn-logout').addEventListener('click', () => {
        Sesion.cerrarSesionCliente();
        if (window.toast) toast('Sesión cerrada', 'ok');
        setTimeout(() => location.replace('/index.html'), 350);
    });

    let PERFIL;
    try {
        PERFIL = await api(`/clientes/${sesion.id}`);
    } catch (e) {
        Sesion.cerrarSesionCliente();
        irALogin();
        return;
    }
    Sesion.guardarCliente({ ...sesion, ...PERFIL });
    window.PERFIL = PERFIL;
    document.getElementById('cn-nombre').textContent = PERFIL.nombre;
    document.getElementById('cn-correo').textContent = PERFIL.correo;

    const panel = document.getElementById('cuenta-panel');
    try {
        await render(panel, PERFIL);
    } catch (e) {
        // Un 404 de la API es que esta sección todavía no existe en el servidor
        // (por ejemplo, se actualizó la página pero no se reinició el servidor).
        const msg = e.status === 404 || e.status >= 500 || !e.status
            ? 'No pudimos cargar esta sección. Intenta de nuevo en unos minutos.'
            : e.message;
        panel.innerHTML = `<div class="empty-state">${escHTML(msg)}<br><button class="btn btn-outline btn-sm" style="margin-top:12px" onclick="location.reload()">Reintentar</button></div>`;
    }
    // Se vuelve a pintar sola cuando llega un aviso que le toca (Soporte
    // respondió, cambió un pedido…). Si estás escribiendo o tienes una
    // ventana abierta no se interrumpe: sale una barra para actualizar.
    const cats = CATS_SECCION[key];
    if (cats && window.Novedades) Novedades.alCambiar(cats, () => repintarSeccion(panel, render, PERFIL));
}
window.montarCuenta = montarCuenta;

const CATS_SECCION = {
    perfil: ['pedido', 'monedero', 'cupon'], pedidos: ['pedido'], devoluciones: ['pedido'], recompensas: ['pedido'],
    monedero: ['monedero', 'pedido'], cupones: ['cupon'], favoritos: ['favoritos'], resenas: ['resena'],
    garantias: ['garantia', 'pedido'], soporte: ['soporte'], seguridad: ['seguridad'],
};
function ocupado(panel) {
    const a = document.activeElement;
    if (a && panel.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    if ([...panel.querySelectorAll('textarea')].some((t) => t.value.trim())) return true;   // un mensaje a medio escribir
    // Fotos elegidas sin enviar (las del hilo ya enviadas no cuentan).
    if ([...panel.querySelectorAll('.foto-lista')].some((l) => !l.closest('.hilo') && l.children.length)) return true;
    return !!document.querySelector('.modal.open, .modal-overlay.open, #modal-generico.open');
}
async function repintarSeccion(panel, render, perfil, forzar = false) {
    if (!forzar && ocupado(panel)) {
        if (!document.getElementById('novedades-barra')) {
            const b = document.createElement('div');
            b.id = 'novedades-barra'; b.className = 'novedades-barra';
            b.innerHTML = `<span>${icon('bell', 15)} Hay novedades en esta sección.</span><button class="btn btn-primary btn-sm">Actualizar</button>`;
            b.querySelector('button').addEventListener('click', () => { b.remove(); repintarSeccion(panel, render, perfil, true); });
            panel.prepend(b);
        }
        return;
    }
    const y = window.scrollY;
    try { await render(panel, perfil); } catch { return; }
    window.scrollTo(0, y);
}

// Helpers de dominio compartidos entre páginas de cuenta
window.ESTADO_LABEL = { pendiente: 'Pendiente', confirmado: 'Confirmado', procesando: 'En preparación', enviado: 'Enviado', entregado: 'Entregado', cancelado: 'Cancelado' };
window.NIVEL_SOCIO = { Prospecto: 'Socio nuevo', Activo: 'Nivel Plata', Frecuente: 'Nivel Oro', Inactivo: 'Inactivo' };
window.val = (id) => document.getElementById(id).value.trim();


// =========================================================
// DISEÑO DE LA TARJETA DE SOCIO / CLUB
//   'kzk'     -> diseño nuevo con el logo KZK (por defecto)
//   'clasica' -> diseño anterior (degradado del nivel con la silueta de Tibu)
//   'tiburon' -> Tibu, la mascota, sobre un degradado de mar
// Se guarda en las preferencias de la cuenta (clientes.preferencias.tarjeta)
// y una copia en el navegador para pintar sin esperar al servidor.
// =========================================================
const DisenoTarjeta = {
    opciones: [
        { clave: 'kzk', nombre: 'KZK' },
        { clave: 'clasica', nombre: 'Clásica' },
        { clave: 'tiburon', nombre: 'Tibu' },
    ],
    actual(P) {
        const v = (P && P.preferencias && P.preferencias.tarjeta) || localStorage.getItem('kz_tarjeta') || 'kzk';
        return ['clasica', 'tiburon'].includes(v) ? v : 'kzk';
    },
    // Marca de agua y logo de cada diseño (los dos van en el HTML; el CSS muestra el que toca)
    adornos(tamano = 200) {
        return `<span class="tj-marca tj-solo-kzk" aria-hidden="true">${logoKZK(Math.round(tamano * 0.55))}</span>
                <span class="tj-marca tj-solo-clasica socio-fantasma-g" aria-hidden="true">${icon('tiburon', tamano)}</span>
                <span class="tj-marca tj-solo-tiburon" aria-hidden="true">${mascotaKZK(Math.round(tamano * 0.62), { titulo: 'Tibu' })}</span>`;
    },
    logo() {
        return `<span class="tj-logo tj-solo-kzk">${logoKZK(15)}</span><span class="tj-logo tj-solo-clasica">${icon('tiburon', 16)}</span><span class="tj-logo tj-solo-tiburon">${logoKZK(15)}</span>`;
    },
    // Botones para cambiar de diseño debajo de la tarjeta
    selector(P, d) {
        return `<div class="tj-selector" role="group" aria-label="Diseño de la tarjeta">
            <span>Diseño de la tarjeta</span>
            ${this.opciones.map((o) => `<button type="button" class="tj-op ${o.clave === d ? 'on' : ''}" data-tj="${o.clave}" aria-pressed="${o.clave === d}">${o.nombre}</button>`).join('')}
        </div>`;
    },
    // Engancha los botones: cambia el diseño al instante y lo guarda
    activar(P, contenedor = document) {
        contenedor.querySelectorAll('[data-tj]').forEach((b) => b.addEventListener('click', () => this.cambiar(P, b.dataset.tj)));
    },
    async cambiar(P, d) {
        document.querySelectorAll('.tj-card').forEach((c) => { c.classList.remove('diseno-kzk', 'diseno-clasica', 'diseno-tiburon'); c.classList.add('diseno-' + d); });
        document.querySelectorAll('[data-tj]').forEach((b) => { const on = b.dataset.tj === d; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
        localStorage.setItem('kz_tarjeta', d);
        try {
            P.preferencias = { ...(P.preferencias || {}), tarjeta: d };
            await api(`/clientes/${P.id}/preferencias`, { method: 'PUT', body: P.preferencias });
            toast({ kzk: 'Tarjeta con el diseño KZK', clasica: 'Tarjeta con el diseño clásico', tiburon: 'Tarjeta con Tibu' }[d] || 'Diseño guardado', 'ok');
        } catch (e) { toast('No se pudo guardar el diseño: ' + e.message, 'error'); }
    },
};
window.DisenoTarjeta = DisenoTarjeta;
