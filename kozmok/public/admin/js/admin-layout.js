// public/admin/js/admin-layout.js

// Al volver con "atrás", el navegador puede mostrar la copia guardada de la
// pantalla (con estados viejos de tickets, pedidos…): en el panel se recarga.
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

function requireAuthAdmin() {
    // La sesión real es la cookie HttpOnly "kz_admin"; aquí solo se
    // guardan los datos para pintar el menú y se confirman con el servidor.
    const usuario = Sesion.usuario();
    if (!usuario) { window.location.href = '/admin/login.html'; return null; }
    // Pestaña nueva sin otra del panel abierta = se cerró la anterior: la
    // sesión termina y se pide entrar otra vez.
    if (!PestanaPanel.tiene()) {
        document.documentElement.style.visibility = 'hidden';
        PestanaPanel.verificar().then(async (ok) => {
            if (ok) { document.documentElement.style.visibility = ''; return; }
            await Sesion.cerrarSesionUsuario();
            window.location.replace('/admin/login.html');
        });
    } else PestanaPanel.escuchar();
    api('/admin/whoami')
        .then((u) => {
            if (!u || !u.rol) return;
            Sesion.guardarUsuario(u);
            // Contraseña de antes de la política actual: se pide cambiarla
            // (una vez por sesión; el botón del menú siempre está a la mano).
            let avisado = false;
            try { avisado = sessionStorage.getItem('kz_pass_aviso') === '1'; } catch { /* nada */ }
            if (u.password_debil && !avisado) {
                try { sessionStorage.setItem('kz_pass_aviso', '1'); } catch { /* nada */ }
                abrirCambioPassword(true);
            }
        })
        .catch(() => { Sesion.cerrarSesionUsuario(); window.location.href = '/admin/login.html'; });
    return usuario;
}

const ADMIN_SECCIONES = [
    { titulo: 'CRM', home: '/admin/dashboard.html', links: [
        { href: '/admin/dashboard.html',     key: 'dashboard',     ic: 'home',    label: 'Dashboard',           desc: 'Vista general del CRM' },
        { href: '/admin/clientes.html',      key: 'clientes',      ic: 'user',    label: 'Clientes',            desc: 'Fichas y etapa de cada cliente' },
        { href: '/admin/interacciones.html', key: 'interacciones', ic: 'chat',    label: 'Interacciones',       desc: 'Llamadas, correos y reuniones' },
        { href: '/admin/evaluaciones.html',  key: 'evaluaciones',  ic: 'star',    label: 'Evaluaciones',        desc: 'Reseñas de producto' },
        { href: '/admin/centro-soporte.html', key: 'centro-soporte', ic: 'headphones', label: 'Centro de soporte', desc: 'Todo lo pendiente de atención a clientes' },
        { href: '/admin/soporte.html',       key: 'soporte',       ic: 'help',    label: 'Soporte',             desc: 'Tickets de clientes' },
        { href: '/admin/garantias.html',     key: 'garantias',     ic: 'shield',  label: 'Garantías',           desc: 'Certificados y reclamos' },
        { href: '/admin/pedidos.html',       key: 'pedidos',       ic: 'truck',   label: 'Pedidos',             desc: 'Ventas a clientes' },
        { href: '/admin/chatbot.html',       key: 'chatbot',       ic: 'chat',    label: 'Analítica chatbot',   desc: 'Qué pide la gente al asesor' },
        { href: '/admin/reportes.html',      key: 'reportes',      ic: 'grid',    label: 'Reportes',            desc: 'Métricas e indicadores' },
    ] },
    { titulo: 'SCM', home: '/admin/scm.html', links: [
        { href: '/admin/scm.html',            key: 'scm',             ic: 'home',      label: 'Dashboard',         desc: 'Métricas de la cadena de suministro' },
        { href: '/admin/productos.html',      key: 'productos',       ic: 'laptop',    label: 'Productos',         desc: 'Catálogo: alta y edición' },
        { href: '/admin/proveedores.html',    key: 'proveedores',     ic: 'id',        label: 'Proveedores',       desc: 'Contactos y tiempos de entrega' },
        { href: '/admin/inventario.html',     key: 'inventario',      ic: 'package',   label: 'Inventario',        desc: 'Existencias y stock crítico' },
        { href: '/admin/movimientos.html',    key: 'movimientos',     ic: 'clock',     label: 'Movimientos',       desc: 'Historial de entradas y salidas' },
        { href: '/admin/ordenes-compra.html', key: 'ordenes-compra',  ic: 'undo',      label: 'Pedidos',           desc: 'Reposición y suministro' },
        { href: '/admin/logistica.html',      key: 'logistica',       ic: 'truck',     label: 'Logística',         desc: 'Estrategia push / pull' },
        { href: '/admin/nivel-scm.html',      key: 'nivel-scm',       ic: 'medal',     label: 'Nivel de madurez',  desc: 'Avance en la implementación' },
        { href: '/admin/reportes-scm.html',   key: 'reportes-scm',    ic: 'grid',      label: 'Reportes',          desc: 'Métricas y análisis de la cadena' },
    ] },
    { titulo: 'ERP', home: '/admin/erp.html', links: [
        { href: '/admin/erp.html',          key: 'erp',          ic: 'home',    label: 'Dashboard',           desc: 'Vista integrada del negocio' },
        { href: '/admin/ordenes-erp.html',  key: 'ordenes-erp',  ic: 'cart',    label: 'Órdenes de clientes', desc: 'Captura y consulta de órdenes' },
        { href: '/admin/nivel-erp.html',    key: 'nivel-erp',    ic: 'medal',   label: 'Nivel ERP',           desc: 'Avance en la integración' },
        { href: '/admin/reportes-erp.html', key: 'reportes-erp', ic: 'grid',    label: 'Reportes',            desc: 'Indicadores clave del negocio' },
        { href: '/admin/panel-roles.html',  key: 'panel-roles',  ic: 'id',      label: 'Panel por rol',       desc: 'Qué ve cada rol en el menú' },
    ] },
    { titulo: 'Tienda', home: '/admin/promociones.html', links: [
        { href: '/admin/promociones.html', key: 'promociones', ic: 'star',    label: 'Promociones', desc: 'Descuentos, vigencia y banner' },
        { href: '/admin/cupones.html',     key: 'cupones',     ic: 'tag',     label: 'Cupones',     desc: 'Bienvenida, compensaciones y su uso' },
        { href: '/admin/impuestos.html',   key: 'impuestos',   ic: 'layers',  label: 'Impuestos',   desc: 'Configuración del cálculo' },
        { href: '/admin/monedero.html',    key: 'monedero',    ic: 'wallet',  label: 'Monedero',    desc: 'Saldos, recargas y ajustes' },
        { href: '/admin/pagos.html',       key: 'pagos',       ic: 'card',    label: 'Pagos',       desc: 'Pago de cada pedido' },
        { href: '/admin/facturas.html',    key: 'facturas',    ic: 'clipboard', label: 'Facturas',  desc: 'CFDI emitidos y cancelaciones' },
        { href: '/admin/devoluciones.html', key: 'devoluciones', ic: 'undo',   label: 'Devoluciones', desc: 'Solicitudes, recepción y reembolsos' },
    ] },
    { titulo: 'Cuenta', links: [
        { href: '/admin/mi-actividad.html',  key: 'mi-actividad',  ic: 'clock',    label: 'Mi actividad' },
        { href: '/admin/usuarios.html',      key: 'usuarios',      ic: 'lock',     label: 'Cuentas y equipo' },
        { href: '/admin/seguridad.html',     key: 'seguridad',     ic: 'shield',   label: 'Seguridad' },
        { href: '/admin/auditoria.html',     key: 'auditoria',     ic: 'clock',    label: 'Auditoría' },
        { href: '/admin/configuracion.html', key: 'configuracion', ic: 'settings', label: 'Configuración' },
    ] },
];

// Los permisos por rol (PERMISOS, ROL_LABEL, ROL_HOME, puedeVer) viven en
// admin/js/permisos.js: es el mismo archivo que usa el servidor para
// validar cada llamada, así que el menú y el acceso real siempre coinciden.
window.ADMIN_SECCIONES = ADMIN_SECCIONES;

const inicialesUsuario = (nombre) => String(nombre || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

// Avatar con iniciales para listas de clientes (color estable por nombre).
function avatarIni(nombre) {
    const n = String(nombre || '?');
    let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="av-ini" style="--h:${h}">${inicialesUsuario(n)}</span>`;
}
window.avatarIni = avatarIni;

const ICONO_MODULO = { CRM: 'user', SCM: 'package', ERP: 'layers', Tienda: 'cart', Cuenta: 'settings' };

function menuCorto() {
    try { return localStorage.getItem('kz_menu_corto') === '1'; } catch { return false; }
}
// Oculta (deja solo los módulos) o muestra el menú lateral completo.
function alternarMenuCorto() {
    const corto = !menuCorto();
    try { localStorage.setItem('kz_menu_corto', corto ? '1' : '0'); } catch { /* sin almacenamiento */ }
    const shell = document.querySelector('.admin-shell');
    if (shell) shell.classList.toggle('menu-corto', corto);
}
window.alternarMenuCorto = alternarMenuCorto;

// Ventana al centro con las secciones de un módulo (desde el menú corto).
function abrirMenuModulo(titulo) {
    const rol = (Sesion.usuario() || {}).rol || '';
    const ic = window.icon || (() => '');
    const grupo = ADMIN_SECCIONES.find((s) => s.titulo === titulo);
    if (!grupo) return;
    const links = grupo.links.filter((l) => puedeVer(rol, l.key));
    let ov = document.getElementById('modal-menu-modulo');
    if (!ov) {
        ov = document.createElement('div');
        ov.className = 'modal-overlay';
        ov.id = 'modal-menu-modulo';
        ov.innerHTML = '<div class="modal menu-modulo" role="dialog" aria-modal="true"></div>';
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ov.classList.remove('open'); });
        document.body.appendChild(ov);
    }
    ov.querySelector('.modal').innerHTML = `
        <button class="modal-close" onclick="document.getElementById('modal-menu-modulo').classList.remove('open')" aria-label="Cerrar">${ic('x', 20)}</button>
        <div class="mm-head"><span class="mm-ico">${ic(ICONO_MODULO[titulo] || 'grid', 20)}</span><div><h3>${titulo}</h3><p>${links.length} secciones</p></div></div>
        <div class="mm-grid">${links.map((l) => `
            <a class="modulo-tile ${l.key === window.ADMIN_ACTIVO ? 'actual' : ''}" href="${l.href}" data-key="${l.key}">
                <span class="mt-ico">${ic(l.ic, 20)}</span>
                <span class="mt-txt"><span class="mt-title">${l.label}</span>${l.desc ? `<span class="mt-desc">${l.desc}</span>` : ''}</span>
            </a>`).join('')}</div>`;
    ov.classList.add('open');
}
window.abrirMenuModulo = abrirMenuModulo;

function renderAdminSidebar(activo) {
    window.ADMIN_ACTIVO = activo;
    const el = document.getElementById('admin-sidebar-placeholder');
    if (!el) return;
    const usuario = Sesion.usuario();
    const rol = (usuario && usuario.rol) || '';
    const ic = window.icon || (() => '');

    // Rol que ya no existe (sesión vieja de antes del cambio de roles):
    // se cierra la sesión para que vuelva a entrar.
    if (!PERMISOS[rol]) { cerrarSesionAdmin(); return; }

    // Si el rol no puede ver esta sección, lo mandamos a su inicio.
    if (activo && !puedeVer(rol, activo)) {
        window.location.href = homeDe(rol);
        return;
    }
    Regreso.iniciar();

    // El título de cada módulo lleva a su dashboard; si el rol no lo ve
    // (Soporte en CRM, por ejemplo), a la primera sección que sí ve.
    const secciones = ADMIN_SECCIONES
        .map((s) => {
            const links = s.links.filter((l) => puedeVer(rol, l.key));
            const home = s.home && (links.some((l) => l.href === s.home) ? s.home : (links[0] || {}).href);
            return { ...s, links, home };
        })
        .filter((s) => s.links.length > 0);

    // Menú corto (solo íconos de módulo): se recuerda en el navegador.
    const shell = el.closest('.admin-shell');
    if (shell) shell.classList.toggle('menu-corto', menuCorto());
    const grupoActivo = (secciones.find((s) => s.links.some((l) => l.key === activo)) || {}).titulo;

    el.innerHTML = `
        <div class="brand-fila">
            <div class="brand"><span class="brand-mark">${window.logoKZK ? logoKZK(24) : ic('tiburon', 16)}</span> <span class="brand-txt">Kozmok</span></div>
            <div class="bf-acciones">
                <button type="button" class="admin-campana" id="admin-campana" onclick="Notifs.alternar(event)" aria-label="Notificaciones" title="Notificaciones">${ic('bell', 17)}<span class="campana-n" id="campana-n" hidden></span></button>
                <button type="button" class="admin-colapsar" onclick="alternarMenuCorto()" aria-label="Ocultar o mostrar el menú" title="Ocultar / mostrar menú">${ic('chevron', 16)}</button>
            </div>
        </div>
        <button class="admin-nav-toggle" id="admin-nav-toggle" aria-label="Menú">${ic('menu', 20)}</button>
        <nav class="admin-rail" aria-label="Módulos">
            ${secciones.map((s) => `
                <button type="button" class="rail-mod ${s.titulo === grupoActivo ? 'activo' : ''}" data-grupo="${s.titulo}" onclick="abrirMenuModulo('${s.titulo}')" title="${s.titulo}">
                    ${ic(ICONO_MODULO[s.titulo] || 'grid', 20)}<span>${s.titulo}</span>
                </button>`).join('')}
        </nav>
        <button type="button" class="admin-ir" onclick="abrirIrA()" title="Ir a una sección (Ctrl + K)">${ic('search', 15)} <span>Ir a…</span><kbd>Ctrl K</kbd></button>
        <div class="admin-nav-links" id="admin-nav-links">
            ${secciones.map((s) => {
                const enlaces = s.links.map((l) => `<a href="${l.href}" data-key="${l.key}" class="${l.key === activo ? 'active' : ''}">${ic(l.ic, 17)} ${l.label}</a>`).join('');
                if (!s.home) {
                    // Grupo estático (Cuenta): sin desplegable, siempre visible.
                    return `<div class="admin-nav-sec">${s.titulo}</div>${enlaces}`;
                }
                // Grupo desplegable (CRM / SCM / ERP): el título navega a su dashboard;
                // la flecha solo muestra u oculta sus opciones. Empieza abierto
                // si la página activa pertenece a este grupo.
                const abierto = s.links.some((l) => l.key === activo);
                return `
                    <div class="admin-nav-grupo ${abierto ? 'abierto' : ''}" data-grupo="${s.titulo}">
                        <div class="admin-nav-grupo-head">
                            <a href="${s.home}" class="admin-nav-sec-link">${s.titulo}</a>
                            <button type="button" class="admin-nav-sec-toggle" aria-expanded="${abierto ? 'true' : 'false'}" aria-label="Mostrar opciones de ${s.titulo}">${ic('chevron', 15)}</button>
                        </div>
                        <div class="admin-nav-grupo-links"><div class="admin-nav-grupo-links-inner">${enlaces}</div></div>
                    </div>
                `;
            }).join('')}
        </div>
        <div class="admin-user">
            <div class="au-fila">
                <span class="au-avatar">${inicialesUsuario(usuario ? usuario.nombre : '')}</span>
                <div style="min-width:0">
                    <div class="au-name">${usuario ? usuario.nombre : ''}</div>
                    <div class="au-rol">${ROL_LABEL[rol] || rol}</div>
                </div>
            </div>
            <button class="btn btn-ghost btn-sm au-salir" onclick="abrirCambioPassword()" title="Cambiar mi contraseña">${ic('lock', 15)} <span>Cambiar contraseña${usuario && usuario.password_debil ? ' <span class="au-alerta" title="Tu contraseña es muy sencilla">!</span>' : ''}</span></button>
            <button class="btn btn-ghost btn-sm au-salir" onclick="Notifs.preferencias()" title="Qué avisos recibes en el panel y por correo">${ic('bell', 15)} <span>Notificaciones</span></button>
            <button class="btn btn-ghost btn-sm au-salir" onclick="abrirDosPasos()" title="Verificación en dos pasos">${ic('shield', 15)} <span>Verificación en dos pasos</span></button>
            <button class="btn btn-ghost btn-sm au-salir" onclick="cerrarSesionAdmin()" title="Cerrar sesión">${ic('logout', 15)} <span>Cerrar sesión</span></button>
        </div>
    `;
    const t = document.getElementById('admin-nav-toggle');
    if (t) t.addEventListener('click', () => document.getElementById('admin-nav-links').classList.toggle('open'));

    document.querySelectorAll('.admin-nav-sec-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
            const grupo = btn.closest('.admin-nav-grupo');
            const abierto = grupo.classList.toggle('abierto');
            btn.setAttribute('aria-expanded', abierto ? 'true' : 'false');
        });
    });
    Avisos.iniciar(activo);
}

// ---------------------------------------------------------
// Puntitos de aviso en el menú: una sección se marca cuando llegó algo
// después de la última vez que la abriste (un ticket con mensaje nuevo,
// una devolución, un pago reportado…). Al abrirla, el punto se quita.
// Se revisa cada minuto y al volver a la pestaña.
// ---------------------------------------------------------
const Avisos = {
    datos: {},
    _clave() { return 'kz_avisos_visto_' + ((Sesion.usuario() || {}).id || ''); },
    _visto() { try { return JSON.parse(localStorage.getItem(this._clave()) || '{}') || {}; } catch { return {}; } },
    _guardar(v) { try { localStorage.setItem(this._clave(), JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
    nuevo(k) {
        const a = this.datos[k];
        if (!a || !a.n) return false;
        const v = this._visto()[k];
        if (!v) return true;
        if (a.ultimo) return new Date(a.ultimo).getTime() > (v.t || 0);
        return a.n > (v.n || 0);
    },
    marcarVisto(k) {
        if (!k) return;
        const v = this._visto();
        v[k] = { t: Date.now(), n: (this.datos[k] || {}).n || 0 };
        this._guardar(v);
    },
    pintar() {
        const nuevos = new Set(Object.keys(this.datos).filter((k) => this.nuevo(k)));
        document.querySelectorAll('[data-key]').forEach((el) => {
            const k = el.dataset.key;
            const on = nuevos.has(k);
            let p = el.querySelector(':scope > .aviso-punto');
            if (on && !p) { p = document.createElement('span'); p.className = 'aviso-punto'; el.appendChild(p); }
            if (!on && p) p.remove();
            if (p) p.title = `${this.datos[k].n} por atender`;
        });
        // Módulos (CRM, SCM…): punto si alguna de sus secciones tiene algo nuevo.
        (window.ADMIN_SECCIONES || []).forEach((sec) => {
            const on = sec.links.some((l) => nuevos.has(l.key));
            document.querySelectorAll(`[data-grupo="${sec.titulo}"]`).forEach((el) => {
                const destino = el.classList.contains('rail-mod') ? el : el.querySelector('.admin-nav-sec-link, .admin-nav-grupo-head');
                if (!destino) return;
                let p = destino.querySelector(':scope > .aviso-punto');
                if (on && !p) { p = document.createElement('span'); p.className = 'aviso-punto'; destino.appendChild(p); }
                if (!on && p) p.remove();
            });
        });
    },
    async actualizar() {
        if (window.Notifs) Notifs.actualizar();
        try { this.datos = await api('/admin/avisos'); } catch { return; }
        if (this.activo) this.marcarVisto(this.activo);
        this.pintar();
    },
    iniciar(activo) {
        this.activo = activo;
        this.actualizar();
        if (this._reloj) return;
        this._reloj = setInterval(() => { if (!document.hidden) this.actualizar(); }, 60000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.actualizar(); });
    },
};
window.Avisos = Avisos;

// ---------------------------------------------------------
// "Ir a…" (Ctrl + K): busca una sección por nombre y entra con Enter,
// sin abrir los grupos del menú. Muestra los puntos de aviso.
// ---------------------------------------------------------
function abrirIrA() {
    const rol = (Sesion.usuario() || {}).rol || '';
    const ic = window.icon || (() => '');
    const lista = [];
    (window.ADMIN_SECCIONES || []).forEach((sec) => sec.links.forEach((l) => { if (puedeVer(rol, l.key)) lista.push({ ...l, modulo: sec.titulo }); }));
    let ov = document.getElementById('modal-ir-a');
    if (!ov) {
        ov = document.createElement('div');
        ov.className = 'modal-overlay';
        ov.id = 'modal-ir-a';
        ov.innerHTML = `<div class="modal ir-a" role="dialog" aria-modal="true" aria-label="Ir a una sección">
            <div class="ir-a-buscar">${ic('search', 18)}<input id="ir-a-q" placeholder="¿A dónde vas? Pedidos, soporte, inventario…" autocomplete="off" /><kbd>Esc</kbd></div>
            <div class="ir-a-lista" id="ir-a-lista" role="listbox"></div></div>`;
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); });
        document.body.appendChild(ov);
    }
    const q = ov.querySelector('#ir-a-q');
    const cont = ov.querySelector('#ir-a-lista');
    const sinAcentos = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    let sel = 0, vis = [];
    const pintar = () => {
        const t = sinAcentos(q.value.trim());
        vis = lista.filter((l) => !t || sinAcentos(`${l.label} ${l.modulo} ${l.desc || ''}`).includes(t));
        // Primero las que tienen algo nuevo; después en el orden del menú.
        vis.sort((a, b) => Number(Avisos.nuevo(b.key)) - Number(Avisos.nuevo(a.key)));
        sel = Math.min(sel, Math.max(0, vis.length - 1));
        cont.innerHTML = vis.length ? vis.map((l, i) => `
            <a class="ir-a-op ${i === sel ? 'sel' : ''}" href="${l.href}" role="option" data-i="${i}">
                <span class="ir-a-ic">${ic(l.ic, 17)}</span>
                <span class="ir-a-txt"><strong>${l.label}</strong><small>${l.modulo}${l.desc ? ' · ' + l.desc : ''}</small></span>
                ${Avisos.nuevo(l.key) ? `<span class="ir-a-nuevo">${Avisos.datos[l.key].n} por atender</span>` : ''}
            </a>`).join('') : '<p class="ir-a-vacio">Ninguna sección coincide.</p>';
        const actual = cont.querySelector('.sel'); if (actual) actual.scrollIntoView({ block: 'nearest' });
    };
    q.oninput = () => { sel = 0; pintar(); };
    q.onkeydown = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, vis.length - 1); pintar(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); pintar(); }
        else if (e.key === 'Enter' && vis[sel]) { e.preventDefault(); location.href = vis[sel].href; }
        else if (e.key === 'Escape') ov.classList.remove('open');
    };
    q.value = ''; sel = 0; pintar();
    ov.classList.add('open');
    setTimeout(() => q.focus(), 30);
}
window.abrirIrA = abrirIrA;
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && document.getElementById('admin-sidebar-placeholder')) {
        e.preventDefault(); abrirIrA();
    }
});

// Ventana "Cambiar mi contraseña" (cualquier rol). aviso = true cuando se
// abre sola porque la contraseña actual no cumple las reglas.
function abrirCambioPassword(aviso = false) {
    let m = document.getElementById('modal-mi-pass');
    if (!m) {
        m = document.createElement('div');
        m.className = 'modal-overlay';
        m.id = 'modal-mi-pass';
        document.body.appendChild(m);
        m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
    }
    m.innerHTML = `<div class="modal" style="max-width:440px">
        <h3 style="margin-top:0">Cambiar mi contraseña</h3>
        ${aviso ? `<p class="mp-aviso">${window.icon ? icon('lock', 15) : ''} Tu contraseña es temporal o muy sencilla. Cámbiala por una que solo tú conozcas para proteger el panel.</p>` : ''}
        <div class="field"><label for="mp-actual">Contraseña actual</label><input type="password" id="mp-actual" autocomplete="current-password" /></div>
        <div class="field"><label for="mp-nueva">Nueva contraseña</label><input type="password" id="mp-nueva" maxlength="72" autocomplete="new-password" />${ReglasPass.html('mp-reglas')}</div>
        <div class="field"><label for="mp-rep">Repetir nueva contraseña</label><input type="password" id="mp-rep" autocomplete="new-password" /></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">
            <button class="btn btn-ghost" type="button" id="mp-cancelar">${aviso ? 'Ahora no' : 'Cancelar'}</button>
            <button class="btn btn-primary" type="button" id="mp-guardar">Guardar contraseña</button>
        </div></div>`;
    ReglasPass.enlazar(document.getElementById('mp-nueva'), document.getElementById('mp-reglas'));
    document.getElementById('mp-cancelar').onclick = () => m.classList.remove('open');
    document.getElementById('mp-guardar').onclick = async () => {
        const actual = document.getElementById('mp-actual').value;
        const nueva = document.getElementById('mp-nueva').value;
        if (!actual) return toast('Escribe tu contraseña actual', 'warn');
        const falta = ReglasPass.faltante(nueva);
        if (falta) return toast(falta, 'warn');
        if (nueva !== document.getElementById('mp-rep').value) return toast('Las contraseñas nuevas no coinciden', 'warn');
        const btn = document.getElementById('mp-guardar');
        btn.disabled = true;
        try {
            const r = await api('/admin/mi-password', { method: 'PUT', body: { actual, nueva } });
            Sesion.guardarUsuario({ ...Sesion.usuario(), password_debil: false });
            document.querySelectorAll('.au-alerta').forEach((x) => x.remove());
            m.classList.remove('open');
            toast(r.message, 'ok');
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    };
    m.classList.add('open');
    setTimeout(() => document.getElementById('mp-actual').focus(), 50);
}
window.abrirCambioPassword = abrirCambioPassword;

// Ventana "Verificación en dos pasos" (cualquier rol): elegir app o correo.
// Carga dos-pasos.js y el generador de QR solo cuando se abre.
function cargarScript(src) {
    return new Promise((ok, mal) => {
        if (document.querySelector(`script[src="${src}"]`)) return ok();
        const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => mal(new Error('No se pudo cargar ' + src));
        document.head.appendChild(s);
    });
}
async function abrirDosPasos() {
    try { await cargarScript('/js/vendor/qrcode-generator.js'); await cargarScript('/js/dos-pasos.js'); }
    catch (e) { return toast(e.message, 'error'); }
    let m = document.getElementById('modal-2fa');
    if (!m) {
        m = document.createElement('div');
        m.className = 'modal-overlay';
        m.id = 'modal-2fa';
        document.body.appendChild(m);
        m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
    }
    m.innerHTML = `<div class="modal" style="max-width:620px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><h3 style="margin:0">Verificación en dos pasos</h3>
            <button class="btn btn-ghost btn-sm" type="button" style="margin-left:auto" onclick="document.getElementById('modal-2fa').classList.remove('open')">Cerrar</button></div>
        <div id="dp-panel"></div></div>`;
    m.classList.add('open');
    DosPasos.montarConfig(document.getElementById('dp-panel'), '/admin/mi-2fa');
}
window.abrirDosPasos = abrirDosPasos;

async function cerrarSesionAdmin() {
    await Sesion.cerrarSesionUsuario();
    window.location.replace('/admin/login.html');
}

// Exporta un array de objetos a CSV y lo descarga.
function descargarCSV(nombreArchivo, filas) {
    if (!filas || filas.length === 0) { if (window.toast) toast('No hay datos para exportar', 'warn'); return; }
    const cols = Object.keys(filas[0]);
    const esc = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [cols.join(','), ...filas.map((f) => cols.map((c) => esc(f[c])).join(','))].join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombreArchivo.endsWith('.csv') ? nombreArchivo : nombreArchivo + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    if (window.toast) toast('CSV descargado', 'ok');
}
window.descargarCSV = descargarCSV;

// Menú de iconos grandes para la página de inicio de un módulo (CRM/SCM/ERP):
// un acceso directo a cada sección del grupo, sin la que ya estás viendo.
function renderModuloTiles(elId, grupoTitulo, excluirKey) {
    const el = document.getElementById(elId);
    if (!el) return;
    const usuario = Sesion.usuario();
    const rol = (usuario && usuario.rol) || '';
    const ic = window.icon || (() => '');
    const grupo = ADMIN_SECCIONES.find((s) => s.titulo === grupoTitulo);
    if (!grupo) return;
    const tiles = grupo.links.filter((l) => l.key !== excluirKey && puedeVer(rol, l.key));
    el.innerHTML = tiles.map((l) => `
        <a class="modulo-tile" href="${l.href}">
            <span class="mt-ico">${ic(l.ic, 20)}</span>
            <span class="mt-txt">
                <span class="mt-title">${l.label}</span>
                <span class="mt-desc">${l.desc || ''}</span>
            </span>
        </a>
    `).join('');
}
window.renderModuloTiles = renderModuloTiles;

// Encabezado de página estándar del panel
// Muestra arriba del título el módulo de la pantalla (CRM, SCM, ERP o Cuenta).
function adminHeader(titulo, subtitulo, accionHTML) {
    const grupo = ADMIN_SECCIONES.find((s) => s.links.some((l) => l.key === window.ADMIN_ACTIVO));
    return `<div class="admin-topbar">
        <div>${grupo ? `<span class="at-modulo">${grupo.titulo}</span>` : ''}<h2>${titulo}</h2>${subtitulo ? `<p>${subtitulo}</p>` : ''}</div>
        <div class="at-actions">${accionHTML || ''}</div>
    </div>`;
}
window.adminHeader = adminHeader;


// ---------------------------------------------------------
// Botón "Regresar": recuerda las pantallas del panel por las que pasaste
// en esta pestaña y te devuelve a la anterior (con sus filtros), sin
// buscarla en la barra lateral. Cambiar solo la búsqueda de la misma
// pantalla (?reclamo=, ?dev=…) no cuenta como otra pantalla.
// ---------------------------------------------------------
const Regreso = {
    CLAVE: 'kz_panel_ruta',
    leer() { try { return JSON.parse(sessionStorage.getItem(this.CLAVE)) || []; } catch { return []; } },
    guardar(r) { try { sessionStorage.setItem(this.CLAVE, JSON.stringify(r.slice(-25))); } catch { /* nada */ } },
    nombre() {
        const link = ADMIN_SECCIONES.flatMap((s) => s.links).find((l) => l.href === location.pathname);
        return link ? link.label : (document.title.split('·')[0].trim() || 'pantalla anterior');
    },
    iniciar() {
        if (this._listo) return; this._listo = true;
        const aqui = { ruta: location.pathname, url: location.pathname + location.search, nombre: this.nombre() };
        let r = this.leer();
        const prev = r[r.length - 2];
        if (prev && prev.ruta === aqui.ruta) { r.pop(); r[r.length - 1] = aqui; }   // volvimos a la anterior
        else if (r.length && r[r.length - 1].ruta === aqui.ruta) r[r.length - 1] = aqui; // recarga
        else r.push(aqui);
        this.guardar(r);
        this.anterior = r[r.length - 2] || null;
        // Si la pantalla cambia su ?búsqueda sin recargar, se actualiza la entrada.
        ['pushState', 'replaceState'].forEach((m) => {
            const orig = history[m].bind(history);
            history[m] = (...args) => { orig(...args); const x = this.leer(); if (x.length && x[x.length - 1].ruta === location.pathname) { x[x.length - 1].url = location.pathname + location.search; this.guardar(x); } };
        });
        this.pintar();
    },
    volver() {
        const a = this.anterior; if (!a) return;
        let ref = null; try { ref = new URL(document.referrer); } catch { /* nada */ }
        // Si venimos justo de ahí, el navegador conserva el scroll y el estado.
        if (ref && ref.origin === location.origin && ref.pathname === a.ruta && history.length > 1) history.back();
        else location.href = a.url;
    },
    pintar() {
        const main = document.querySelector('.admin-main');
        if (!main || !this.anterior) return;
        const poner = () => {
            if (main.querySelector(':scope > .at-volver')) return;
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'at-volver';
            b.title = 'Regresar a la pantalla anterior (Alt + ←)';
            b.innerHTML = `${window.icon ? icon('arrow', 14) : '←'} <span>Regresar a <strong></strong></span>`;
            b.querySelector('strong').textContent = this.anterior.nombre;
            b.onclick = () => this.volver();
            main.prepend(b);
        };
        poner();
        // Algunas pantallas redibujan todo el contenido: se vuelve a poner.
        new MutationObserver(poner).observe(main, { childList: true });
    },
};
window.Regreso = Regreso;


// ---------------------------------------------------------
// Notificaciones del equipo (campana del menú). El servidor las crea cada
// minuto según el rol (tickets, reclamos, devoluciones, pedidos, pagos,
// stock, seguridad…) y también las manda por correo. Aquí se ve la lista,
// se marcan como leídas y se eligen las preferencias.
// ---------------------------------------------------------
const Notifs = {
    datos: null,
    ultimo: null,           // último id visto (para avisar de las nuevas)
    async actualizar() {
        let d;
        try { d = await api('/admin/notificaciones?limite=30'); } catch { return; }
        const nuevas = this.ultimo !== null ? d.items.filter((n) => !n.leida && n.id > this.ultimo) : [];
        this.datos = d;
        this.ultimo = Math.max(this.ultimo || 0, d.ultimo_id || 0, ...d.items.map((n) => Number(n.id)));
        this.pintarContador();
        if (nuevas.length) this.avisar(nuevas);
        const p = document.getElementById('notif-panel');
        if (p && p.classList.contains('open')) this.pintarPanel();
    },
    pintarContador() {
        const el = document.getElementById('campana-n');
        if (!el || !this.datos) return;
        const n = this.datos.no_leidas;
        el.hidden = !n;
        el.textContent = n > 99 ? '99+' : n;
        const b = document.getElementById('admin-campana');
        if (b) b.title = n ? `${n} notificación(es) sin leer` : 'Notificaciones';
    },
    // Aviso en la página (y del sistema operativo si la pestaña no está a la vista).
    avisar(nuevas) {
        const n = nuevas[0];
        if (window.toast) toast(nuevas.length === 1 ? n.titulo : `${nuevas.length} notificaciones nuevas`, 'info', 5000);
        let escritorio = false;
        try { escritorio = localStorage.getItem('kz_notif_escritorio') === '1'; } catch { /* nada */ }
        if (escritorio && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            try {
                const w = new Notification(nuevas.length === 1 ? n.titulo : `Kozmok: ${nuevas.length} notificaciones nuevas`,
                    { body: nuevas.length === 1 ? (n.cuerpo || '') : nuevas.slice(0, 3).map((x) => x.titulo).join('\n'), icon: '/img/kzk.svg', tag: 'kz-panel' });
                w.onclick = () => { window.focus(); if (nuevas.length === 1 && n.url) this.abrir(n.id, n.url); w.close(); };
            } catch { /* el navegador no lo permite */ }
        }
    },
    alternar(ev) {
        if (ev) ev.stopPropagation();
        let p = document.getElementById('notif-panel');
        if (!p) {
            p = document.createElement('div');
            p.id = 'notif-panel';
            p.className = 'notif-panel';
            p.setAttribute('role', 'dialog');
            p.setAttribute('aria-label', 'Notificaciones');
            p.addEventListener('click', (e) => e.stopPropagation());
            document.body.appendChild(p);
            document.addEventListener('click', () => p.classList.remove('open'));
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') p.classList.remove('open'); });
            window.addEventListener('resize', () => p.classList.remove('open'));
        }
        if (p.classList.contains('open')) { p.classList.remove('open'); return; }
        const b = document.getElementById('admin-campana').getBoundingClientRect();
        const ancho = Math.min(380, window.innerWidth - 16);
        p.style.width = ancho + 'px';
        p.style.left = Math.max(8, Math.min(b.left, window.innerWidth - ancho - 8)) + 'px';
        p.style.top = (b.bottom + 8) + 'px';
        p.classList.add('open');
        this.pintarPanel();
        this.actualizar();
    },
    pintarPanel() {
        const p = document.getElementById('notif-panel');
        const ic = window.icon || (() => '');
        const d = this.datos;
        const hace = (f) => {
            const min = Math.max(0, Math.floor((Date.now() - new Date(f).getTime()) / 60000));
            if (min < 1) return 'ahora';
            if (min < 60) return `hace ${min} min`;
            const h = Math.floor(min / 60);
            return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
        };
        const ICO = { tickets: 'help', garantias: 'shield', devoluciones: 'undo', resenas: 'star', pedidos: 'cart', pagos: 'card',
            monedero: 'wallet', inventario: 'package', bajas: 'clipboard', seguridad: 'lock' };
        p.innerHTML = `
            <div class="np-head">
                <strong>Notificaciones</strong>
                <div>
                    ${d && d.no_leidas ? `<button type="button" class="link-btn" onclick="Notifs.leerTodas()">Marcar todas como leídas</button>` : ''}
                    <button type="button" class="np-ajustes" onclick="Notifs.preferencias()" title="Preferencias" aria-label="Preferencias">${ic('settings', 15)}</button>
                </div>
            </div>
            <div class="np-lista">
                ${!d ? '<p class="np-vacio">Cargando…</p>' : !d.items.length ? `<p class="np-vacio">${ic('bell', 22)}<br>No tienes notificaciones todavía.</p>` : d.items.map((n) => `
                    <button type="button" class="np-item ${n.leida ? '' : 'nueva'}" onclick="Notifs.abrir(${n.id}, ${n.url ? `'${String(n.url).replace(/['"\\<>]/g, '')}'` : 'null'})">
                        <span class="np-ico">${ic(ICO[n.categoria] || 'bell', 16)}</span>
                        <span class="np-txt">
                            <span class="np-titulo">${escHTML(n.titulo)}</span>
                            ${n.cuerpo ? `<span class="np-cuerpo">${escHTML(n.cuerpo)}</span>` : ''}
                            <span class="np-meta">${escHTML((d.categorias || {})[n.categoria] || '')} · ${hace(n.fecha)}</span>
                        </span>
                    </button>`).join('')}
            </div>`;
    },
    async abrir(id, url) {
        try { await api('/admin/notificaciones/leer', { method: 'POST', body: { ids: [id] } }); } catch { /* sigue */ }
        if (url) { location.href = url; return; }
        this.actualizar();
    },
    async leerTodas() {
        try { await api('/admin/notificaciones/leer', { method: 'POST', body: { todas: true } }); } catch (e) { toast(e.message, 'error'); return; }
        this.actualizar();
    },
    async preferencias() {
        const p = document.getElementById('notif-panel');
        if (p) p.classList.remove('open');
        let pr;
        try { pr = await api('/admin/notificaciones/preferencias'); } catch (e) { toast(e.message, 'error'); return; }
        let m = document.getElementById('modal-notif-prefs');
        if (!m) {
            m = document.createElement('div');
            m.className = 'modal-overlay';
            m.id = 'modal-notif-prefs';
            document.body.appendChild(m);
            m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
        }
        let escritorio = false;
        try { escritorio = localStorage.getItem('kz_notif_escritorio') === '1'; } catch { /* nada */ }
        const soportado = 'Notification' in window;
        m.innerHTML = `<div class="modal" style="max-width:560px">
            <button class="modal-close" type="button" onclick="document.getElementById('modal-notif-prefs').classList.remove('open')" aria-label="Cerrar">${icon('x', 20)}</button>
            <h3 style="margin-top:0">Notificaciones</h3>
            <p style="margin:0 0 14px;font-size:.88rem">Te avisamos en la campana del panel y por correo a <strong>${escHTML(pr.email)}</strong>. Si llegan varias juntas, te mandamos un solo correo.</p>
            <label class="np-switch"><input type="checkbox" id="np-correo" ${pr.correo ? 'checked' : ''}/> Recibir notificaciones por correo</label>
            <div class="table-wrap" style="margin:12px 0">
                <table class="np-tabla">
                    <thead><tr><th>Aviso</th><th>En el panel</th><th>Por correo</th></tr></thead>
                    <tbody>${pr.categorias.map((c) => `<tr>
                        <td><strong>${escHTML(c.label)}</strong><div style="font-size:.76rem;color:var(--text-muted)">${escHTML(c.desc)}</div></td>
                        <td><input type="checkbox" data-panel="${c.clave}" ${c.panel ? 'checked' : ''} aria-label="${escHTML(c.label)} en el panel"/></td>
                        <td><input type="checkbox" data-correo="${c.clave}" ${c.correo ? 'checked' : ''} aria-label="${escHTML(c.label)} por correo"/></td>
                    </tr>`).join('')}</tbody>
                </table>
            </div>
            ${soportado ? `<label class="np-switch"><input type="checkbox" id="np-escritorio" ${escritorio && Notification.permission === 'granted' ? 'checked' : ''}/> Avisos del navegador cuando el panel está en otra pestaña (solo en este equipo)</label>` : ''}
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
                <button class="btn btn-ghost" type="button" onclick="document.getElementById('modal-notif-prefs').classList.remove('open')">Cancelar</button>
                <button class="btn btn-primary" type="button" id="np-guardar">Guardar</button>
            </div></div>`;
        const sincronizar = () => m.querySelectorAll('[data-correo]').forEach((c) => { c.disabled = !document.getElementById('np-correo').checked; });
        document.getElementById('np-correo').onchange = sincronizar;
        sincronizar();
        document.getElementById('np-guardar').onclick = async () => {
            const body = {
                correo: document.getElementById('np-correo').checked,
                panel_off: [...m.querySelectorAll('[data-panel]')].filter((c) => !c.checked).map((c) => c.dataset.panel),
                correo_off: [...m.querySelectorAll('[data-correo]')].filter((c) => !c.checked).map((c) => c.dataset.correo),
            };
            const esc = document.getElementById('np-escritorio');
            if (esc) {
                let quiere = esc.checked;
                if (quiere && Notification.permission !== 'granted') {
                    try { quiere = (await Notification.requestPermission()) === 'granted'; } catch { quiere = false; }
                    if (!quiere) toast('El navegador no dio permiso para mostrar avisos', 'warn');
                }
                try { localStorage.setItem('kz_notif_escritorio', quiere ? '1' : '0'); } catch { /* nada */ }
            }
            try { const r = await api('/admin/notificaciones/preferencias', { method: 'PUT', body }); toast(r.message, 'ok'); m.classList.remove('open'); }
            catch (e) { toast(e.message, 'error'); }
        };
        m.classList.add('open');
    },
};
window.Notifs = Notifs;
