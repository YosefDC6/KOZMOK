// public/admin/js/permisos.js
// Roles empresariales del ERP y qué secciones ve cada uno.
// ES LA ÚNICA FUENTE DE PERMISOS: el navegador la usa para armar el menú
// (admin-layout.js) y el servidor la carga con require() para validar
// cada llamada a /api/admin (PERMISOS_API en server.js). Así el menú y
// el control de acceso nunca se contradicen.
//
// Claves que NO son pantallas del menú (son permisos de acción):
//   'orden-nueva'       capturar órdenes de clientes en el ERP
//   'productos-editar'  dar de alta, editar o borrar productos del catálogo
//   'reposicion'        generar pedidos de reposición al proveedor desde
//                       Inventario, el Dashboard SCM o la Nueva orden
//
// Para un rol nuevo: agrégalo aquí, en ROLES_INTERNOS (server.js) y en
// el CHECK de la tabla usuarios (db/database.sql).
(function (raiz) {
    const PERMISOS = {
        // Administrador: acceso total, incluidas cuentas, Nivel ERP y Panel por rol.
        admin: '*',

        // Los menús de Ventas y Logística son los de la lámina "Panel por rol
        // (Menú dinámico)": solo esas secciones aparecen y se pueden abrir.

        // Ventas: Inicio, Clientes (CRM), Productos (SCM, solo consulta),
        // Órdenes (ERP, con captura), Reportes y Mi actividad.
        ventas: [
            'dashboard', 'clientes', 'productos',
            'ordenes-erp', 'orden-nueva', 'reportes-erp',
            'mi-actividad',
        ],

        // Logística: Inicio, Productos (SCM), Inventario (SCM), Órdenes (ERP:
        // captura órdenes nuevas, las surte y las envía) y Reportes.
        logistica: [
            'scm', 'productos', 'productos-editar', 'inventario', 'reposicion',
            'ordenes-erp', 'orden-nueva', 'reportes-erp',
        ],
    };

    const ROL_LABEL = { admin: 'Administrador', ventas: 'Ventas', logistica: 'Logística' };

    // Pantalla de inicio de cada rol (a donde llega al entrar y a donde se
    // le regresa si abre por URL una sección que no le toca).
    const ROL_HOME = { admin: '/admin/dashboard.html', ventas: '/admin/dashboard.html', logistica: '/admin/scm.html' };

    function puedeVer(rol, key) {
        const p = PERMISOS[rol];
        if (!p) return false;
        return p === '*' || p.includes(key);
    }

    function homeDe(rol) { return ROL_HOME[rol] || '/admin/login.html'; }

    const api = { PERMISOS, ROL_LABEL, ROL_HOME, puedeVer, homeDe };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else Object.assign(raiz, api);
})(typeof window !== 'undefined' ? window : this);
