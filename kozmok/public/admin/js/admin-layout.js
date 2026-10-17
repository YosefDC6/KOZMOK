// public/admin/js/admin-layout.js

function requireAuthAdmin() {
    const usuario = Sesion.usuario();
    const token = localStorage.getItem('kz_admin_token');
    if (!usuario || !token) { window.location.href = '/admin/login.html'; return null; }
    api('/admin/whoami')
        .then((u) => { if (u && u.rol) Sesion.guardarUsuario(u, token); })
        .catch(() => { Sesion.cerrarSesionUsuario(); window.location.href = '/admin/login.html'; });
    return usuario;
}

const ADMIN_SECCIONES = [
    { titulo: 'CRM', home: '/admin/dashboard.html', links: [
        { href: '/admin/dashboard.html',     key: 'dashboard',     ic: 'home',    label: 'Dashboard',           desc: 'Vista general del CRM' },
        { href: '/admin/clientes.html',      key: 'clientes',      ic: 'user',    label: 'Clientes',            desc: 'Fichas y etapa de cada cliente' },
        { href: '/admin/interacciones.html', key: 'interacciones', ic: 'chat',    label: 'Interacciones',       desc: 'Llamadas, correos y reuniones' },
        { href: '/admin/evaluaciones.html',  key: 'evaluaciones',  ic: 'star',    label: 'Evaluaciones',        desc: 'Reseñas de producto' },
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
        { href: '/admin/recursos.html',     key: 'recursos',     ic: 'layers',  label: 'Recursos',            desc: 'Humanos, materiales y financieros' },
        { href: '/admin/reportes-erp.html', key: 'reportes-erp', ic: 'grid',    label: 'Reportes',            desc: 'Indicadores clave del negocio' },
        { href: '/admin/panel-roles.html',  key: 'panel-roles',  ic: 'id',      label: 'Panel por rol',       desc: 'Qué ve cada rol en el menú' },
    ] },
    { titulo: 'Cuenta', links: [
        { href: '/admin/mi-actividad.html',  key: 'mi-actividad',  ic: 'clock',    label: 'Mi actividad' },
        { href: '/admin/usuarios.html',      key: 'usuarios',      ic: 'lock',     label: 'Cuentas y equipo' },
        { href: '/admin/configuracion.html', key: 'configuracion', ic: 'settings', label: 'Configuración' },
    ] },
];

// Los permisos por rol (PERMISOS, ROL_LABEL, ROL_HOME, puedeVer) viven en
// admin/js/permisos.js: es el mismo archivo que usa el servidor para
// validar cada llamada, así que el menú y el acceso real siempre coinciden.
window.ADMIN_SECCIONES = ADMIN_SECCIONES;

function renderAdminSidebar(activo) {
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

    const secciones = ADMIN_SECCIONES
        .map((s) => ({ ...s, links: s.links.filter((l) => puedeVer(rol, l.key)) }))
        .filter((s) => s.links.length > 0);

    el.innerHTML = `
        <div class="brand"><span class="brand-mark">${ic('ghost', 16)}</span> Kozmok</div>
        <button class="admin-nav-toggle" id="admin-nav-toggle" aria-label="Menú">${ic('menu', 20)}</button>
        <div class="admin-nav-links" id="admin-nav-links">
            ${secciones.map((s) => {
                const enlaces = s.links.map((l) => `<a href="${l.href}" class="${l.key === activo ? 'active' : ''}">${ic(l.ic, 17)} ${l.label}</a>`).join('');
                if (!s.home) {
                    // Grupo estático (Cuenta): sin desplegable, siempre visible.
                    return `<div class="admin-nav-sec">${s.titulo}</div>${enlaces}`;
                }
                // Grupo desplegable (CRM / SCM / ERP): el título navega a su dashboard;
                // la flecha solo muestra u oculta sus opciones. Empieza abierto
                // si la página activa pertenece a este grupo.
                const abierto = s.links.some((l) => l.key === activo);
                return `
                    <div class="admin-nav-grupo ${abierto ? 'abierto' : ''}">
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
            <div class="au-name">${usuario ? usuario.nombre : ''}</div>
            <div class="au-rol">${ROL_LABEL[rol] || rol}</div>
            <button class="btn btn-ghost btn-sm" style="padding-left:0;margin-top:4px" onclick="cerrarSesionAdmin()">Cerrar sesión</button>
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
}

function cerrarSesionAdmin() {
    Sesion.cerrarSesionUsuario();
    window.location.href = '/admin/login.html';
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
            <span class="mt-ico">${ic(l.ic, 22)}</span>
            <span class="mt-title">${l.label}</span>
            <span class="mt-desc">${l.desc || ''}</span>
        </a>
    `).join('');
}
window.renderModuloTiles = renderModuloTiles;

// Encabezado de página estándar del panel
function adminHeader(titulo, subtitulo, accionHTML) {
    return `<div class="admin-topbar">
        <div><h2>${titulo}</h2>${subtitulo ? `<p>${subtitulo}</p>` : ''}</div>
        <div class="at-actions">${accionHTML || ''}</div>
    </div>`;
}
window.adminHeader = adminHeader;

