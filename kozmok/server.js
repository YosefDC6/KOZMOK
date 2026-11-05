// =========================================================
//  Kozmok - Backend (Express + PostgreSQL)
//  CRM (Etapa 1) · SCM (Etapa 2) · ERP (Etapa 3) ·
//  Negocio electrónico: catálogo, carrito, pagos, monedero,
//  promociones, impuestos y atención a clientes (Etapa 4) ·
//  Seguridad (Etapa 5): ver seguridad.js
// =========================================================
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const dbConfig = require('./db.config.js');
const seg = require('./seguridad.js');
// Permisos por rol: el mismo archivo que arma el menú del panel.
const { PERMISOS, puedeVer } = require('./public/admin/js/permisos.js');

const app = express();
const PORT = process.env.PORT || 3000;

const { usaValoresPorDefecto, ...configPg } = dbConfig;
const pool = new Pool(configPg);

// Cabeceras de seguridad en todas las respuestas (CSP, nosniff, DENY...).
seg.instalar(app, pool);
app.use(express.static(path.join(__dirname, 'public')));
// Cuerpos JSON de máximo 100 KB (evita peticiones gigantes).
app.use(express.json({ limit: '100kb' }));

// Capas de protección de la API, en orden:
//   1) límite de peticiones por IP, 2) origen (CSRF),
//   3) detector de inyección SQL, 4) limpieza de HTML (XSS).
app.use('/api', seg.limitador({ nombre: 'api', ventanaMs: 60000, max: 600 }));
app.use('/api', seg.verificarOrigen);
app.use('/api', seg.filtroInyeccionSQL);
app.use('/api', seg.sanitizarEntrada);
// Límite más estricto para login, registro y recuperación de contraseña.
const limiteAuth = seg.limitador({
    nombre: 'auth', ventanaMs: 60000, max: 15,
    mensaje: 'Demasiados intentos en poco tiempo desde tu conexión. Espera un minuto e intenta de nuevo.',
});
const limiteDinero = seg.limitador({ nombre: 'pagos', ventanaMs: 60000, max: 12 });

// Los identificadores de las rutas deben ser números: "/clientes/1 OR 1=1"
// se rechaza aquí, antes de llegar a la base.
['id', 'clienteId', 'ticketId', 'dirId', 'mpId', 'garId', 'pedidoId', 'productoId', 'cliente_id', 'movId'].forEach((p) => {
    app.param(p, (req, res, next, valor) => {
        if (seg.esId(valor)) return next();
        return res.status(400).json({ message: 'Identificador no válido' });
    });
});

// Solo se registran errores reales del servidor en la consola. Al usuario
// nunca se le muestra el detalle (SQL, tablas, pila): solo un mensaje
// genérico y un folio para buscarlo en la consola.
const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch((err) => {
    const folio = crypto.randomBytes(3).toString('hex').toUpperCase();
    console.error(`[${folio}]`, req.method, req.originalUrl, '->', err.message);
    if (res.headersSent) return;
    if (err.code && String(err.code).startsWith('22')) return res.status(400).json({ message: seg.mensajeSeguro(err) });
    res.status(500).json({ error: 'Error del servidor', message: 'Ocurrió un error interno. Intenta de nuevo.', folio });
});
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// =========================================================
// MIDDLEWARE DE AUTENTICACIÓN (equipo interno)
// La sesión es un token aleatorio en la cookie HttpOnly "kz_admin" (o en
// el header Authorization: Bearer). Se valida contra la tabla sesiones:
// que exista, no esté revocada ni vencida y sea del mismo navegador.
// =========================================================
async function requireUsuario(req, res, next) {
    try {
        const s = await seg.leerSesion(req, 'usuario');
        if (!s) return res.status(401).json({ message: 'Sesión no encontrada o vencida. Inicia sesión de nuevo.' });
        const result = await pool.query('SELECT id, nombre, email, rol, activo FROM usuarios WHERE id = $1', [s.usuario_id]);
        if (result.rows.length === 0 || !result.rows[0].activo) {
            await seg.revocarSesion(s.id, 'cuenta inactiva');
            return res.status(403).json({ message: 'Cuenta inactiva o inexistente' });
        }
        req.usuario = result.rows[0];
        req.sesion = s;
        next();
    } catch (e) {
        console.error('requireUsuario ->', e.message);
        return res.status(401).json({ message: 'No autenticado' });
    }
}

function requireAdmin(req, res, next) {
    if (!req.usuario || req.usuario.rol !== 'admin') {
        return res.status(403).json({ message: 'Esta acción requiere rol de administrador' });
    }
    next();
}

// Roles empresariales del ERP (como en SAP, Odoo o Dynamics): administrador,
// ventas y logística. Para agregar uno nuevo: añádelo aquí, en el CHECK de
// la tabla usuarios (db/database.sql) y en PERMISOS (public/admin/js/permisos.js).
const ROLES_INTERNOS = {
    admin:     { nombre: 'Administrador', descripcion: 'Acceso total: CRM, SCM, ERP y tienda en línea, cuentas, seguridad, Nivel ERP y Panel por rol.' },
    ventas:    { nombre: 'Ventas',        descripcion: 'Clientes (CRM), consulta de productos (SCM), captura de órdenes de clientes (ERP), reportes y su actividad.' },
    logistica: { nombre: 'Logística',     descripcion: 'Productos e inventario con su reposición (SCM), captura, surtido y envío de las órdenes de clientes (ERP) y reportes.' },
};

// Middleware: el rol del usuario debe tener AL MENOS UNO de estos permisos
// (claves de PERMISOS en permisos.js).
function requirePermiso(...claves) {
    return (req, res, next) => {
        if (req.usuario && claves.some((k) => puedeVer(req.usuario.rol, k))) return next();
        return res.status(403).json({ message: 'Tu rol no tiene acceso a esta sección' });
    };
}

// =========================================================
// MIDDLEWARE DE AUTENTICACIÓN (cliente / tienda)
// Cookie HttpOnly "kz_sesion" que emiten /auth/login y /auth/registro.
// Obliga a iniciar sesión para el carrito, los pedidos y el perfil.
// =========================================================
async function requireCliente(req, res, next) {
    try {
        const s = await seg.leerSesion(req, 'cliente');
        if (!s) return res.status(401).json({ message: 'Inicia sesión para continuar' });
        const r = await pool.query(
            "SELECT id, nombre, correo FROM clientes WHERE id = $1 AND estado_cliente = 'activo'",
            [s.cliente_id]
        );
        if (r.rows.length === 0) {
            await seg.revocarSesion(s.id, 'cliente inactivo');
            return res.status(401).json({ message: 'Sesión no válida' });
        }
        req.cliente = r.rows[0];
        req.sesion = s;
        next();
    } catch (e) {
        console.error('requireCliente ->', e.message);
        return res.status(401).json({ message: 'Inicia sesión para continuar' });
    }
}

// El :id de la ruta debe ser el propio cliente autenticado.
function mismoCliente(req, res, next) {
    const pedido = req.params.id ?? req.params.clienteId ?? req.params.cliente_id;
    if (String(req.cliente.id) !== String(pedido)) {
        seg.registrarEvento(req, { tipo: 'acceso_ajeno', severidad: 'media', cliente_id: req.cliente.id, detalle: `El cliente ${req.cliente.id} intentó usar datos del cliente ${pedido}` });
        return res.status(403).json({ message: 'No puedes ver ni modificar datos de otra cuenta' });
    }
    next();
}

// Id del cliente de una sesión opcional (rutas públicas), o null.
async function clienteDeSesion(req) {
    try { const s = await seg.leerSesion(req, 'cliente'); return s ? Number(s.cliente_id) : null; }
    catch { return null; }
}

// Correos que manda el sistema. Sin servidor SMTP quedan en la tabla
// correos_salida (se ven en el panel: Tienda → Correos enviados).
async function enviarCorreo(db, { para, asunto, cuerpo, tipo = 'general', cliente_id = null, pedido_id = null }) {
    if (!para) return;
    await db.query(
        `INSERT INTO correos_salida (para, asunto, cuerpo, tipo, cliente_id, pedido_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [para, String(asunto).slice(0, 200), cuerpo, tipo, cliente_id, pedido_id]);
    console.log(`Correo (${tipo}) para ${para}: ${asunto}`);
}

// =========================================================
// CLUB KOZMOK (recompensas por puntos)
//   - Se gana: floor(subtotal / 20) * multiplicador del nivel
//   - Se canjea: 100 puntos = $10  (VALOR_PUNTO = 0.10)
//   - Nivel: el mayor entre el que dan las compras totales ($)
//     y el que dan la frecuencia (número de compras).
// =========================================================
const VALOR_PUNTO = 0.10;
const NIVELES = [
    { clave: 'bronce',  nombre: 'Bronce',  multiplicador: 1.0,  minGasto: 0,      minCompras: 0 },
    { clave: 'plata',   nombre: 'Plata',   multiplicador: 1.15, minGasto: 15000,  minCompras: 2 },
    { clave: 'oro',     nombre: 'Oro',     multiplicador: 1.3,  minGasto: 50000,  minCompras: 5 },
    { clave: 'platino', nombre: 'Platino', multiplicador: 1.6,  minGasto: 120000, minCompras: 10 },
];
function nivelRecompensas(valorTotal = 0, totalCompras = 0) {
    let idx = 0;
    for (let i = 0; i < NIVELES.length; i++) {
        if (Number(valorTotal) >= NIVELES[i].minGasto || Number(totalCompras) >= NIVELES[i].minCompras) idx = i;
    }
    const actual = NIVELES[idx];
    const siguiente = NIVELES[idx + 1] || null;
    return { indice: idx, actual, siguiente };
}

// Código único de socio para el QR de la tarjeta virtual (formato KZMX-XXXXXX).
function generarCodigoSocio() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin I/O/0/1 para que sea legible
    let s = '';
    for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return 'KZMX-' + s;
}

// Detecta la marca de una tarjeta por su número (solo para guardar la marca;
// el número completo y el CVV NUNCA se almacenan).
function marcaTarjeta(numero) {
    const n = String(numero || '').replace(/\D/g, '');
    if (/^4/.test(n)) return 'visa';
    if (/^(5[1-5]|2[2-7])/.test(n)) return 'mastercard';
    if (/^3[47]/.test(n)) return 'amex';
    return 'otra';
}
async function estadoRecompensas(clienteId) {
    const c = await pool.query('SELECT puntos FROM clientes WHERE id = $1', [clienteId]);
    if (c.rows.length === 0) return null;
    const m = await pool.query(
        'SELECT COALESCE(valor_total_compras,0) AS gasto, COALESCE(total_compras,0) AS compras FROM metricas_clientes WHERE cliente_id = $1',
        [clienteId]
    );
    const gasto = Number(m.rows[0]?.gasto || 0);
    const compras = Number(m.rows[0]?.compras || 0);
    const { actual, siguiente } = nivelRecompensas(gasto, compras);
    let progreso = 1;
    if (siguiente) {
        const porGasto = Math.min(1, gasto / siguiente.minGasto);
        const porCompras = Math.min(1, compras / siguiente.minCompras);
        progreso = Math.max(porGasto, porCompras);
    }
    return {
        puntos: c.rows[0].puntos,
        valor_en_dinero: Math.round(c.rows[0].puntos * VALOR_PUNTO * 100) / 100,
        valor_punto: VALOR_PUNTO,
        gasto_total: gasto,
        compras_total: compras,
        nivel: actual,
        siguiente_nivel: siguiente,
        progreso: Math.round(progreso * 100),
        niveles: NIVELES,
    };
}

// =========================================================
// AUTENTICACIÓN (4.3 Registro y autenticación de clientes)
//   POST /auth/registro   POST /auth/login   POST /auth/logout
//   GET  /auth/perfil     PUT  /auth/perfil  GET  /auth/estado
//   POST /auth/recuperar  POST /auth/restablecer
//   GET  /auth/sesiones   DELETE /auth/sesiones/:id   GET /auth/actividad
// =========================================================

const CAMPOS_CLIENTE = `id, nombre, correo, telefono, empresa, direccion, ciudad, estado, codigo_postal,
                        etapa_crm, puntos, codigo_socio, fecha_registro`;

// Monedero del cliente (se crea la primera vez que se necesita).
async function monederoDe(db, clienteId, { bloquear = false } = {}) {
    await db.query('INSERT INTO monederos (cliente_id) VALUES ($1) ON CONFLICT (cliente_id) DO NOTHING', [clienteId]);
    const r = await db.query(`SELECT * FROM monederos WHERE cliente_id = $1 ${bloquear ? 'FOR UPDATE' : ''}`, [clienteId]);
    return r.rows[0];
}

// Mensaje de "cuenta / IP bloqueada" con los minutos que faltan.
function respuestaBloqueo(res, bloqueo) {
    const min = seg.minutosRestantes(bloqueo.hasta);
    res.setHeader('Retry-After', String(min * 60));
    return res.status(429).json({
        message: bloqueo.tipo === 'ip'
            ? `Se detectaron demasiados intentos fallidos desde tu conexión. El acceso está bloqueado ${min} minuto(s).`
            : `Cuenta bloqueada temporalmente por demasiados intentos fallidos. Intenta de nuevo en ${min} minuto(s) o recupera tu contraseña.`,
        bloqueado: true, minutos: min,
    });
}

// Login de cliente (tienda). Mismo mensaje y mismo tiempo exista o no
// el correo; cada fallo cuenta para el bloqueo por fuerza bruta.
const loginCliente = asyncRoute(async (req, res) => {
    const correo = seg.normalizarCorreo(req.body.correo || req.body.email);
    const password = String(req.body.password || '');
    if (!correo || !password) return res.status(400).json({ message: 'Correo y contraseña son requeridos' });
    if (!seg.correoValido(correo) || password.length > 200) return res.status(400).json({ message: 'Correo o contraseña con formato no válido' });

    const bloqueo = await seg.bloqueoActivo({ ambito: 'cliente', correo, ip: seg.ipDe(req) });
    if (bloqueo) {
        await seg.registrarIntento(req, { ambito: 'cliente', correo, exito: false, motivo: 'bloqueado' });
        return respuestaBloqueo(res, bloqueo);
    }

    const result = await pool.query('SELECT * FROM clientes WHERE LOWER(correo) = $1', [correo]);
    const cliente = result.rows[0];
    const valido = await seg.compararPassword(password, cliente && cliente.password);
    if (!valido || cliente.estado_cliente !== 'activo') {
        const r = await seg.registrarFallo(req, { ambito: 'cliente', correo, motivo: valido ? 'cuenta_inactiva' : 'credenciales' });
        if (r.bloqueo) return respuestaBloqueo(res, { tipo: r.bloqueo.tipo, hasta: new Date(Date.now() + r.bloqueo.minutos * 60000) });
        return res.status(401).json({
            message: 'Correo o contraseña incorrectos.' + (r.restantes <= 3 ? ` Te quedan ${r.restantes} intento(s) antes de que la cuenta se bloquee ${seg.CONFIG.bloqueoCuentaMin} minutos.` : ''),
            intentos_restantes: r.restantes,
        });
    }

    await seg.registrarIntento(req, { ambito: 'cliente', correo, exito: true });
    await pool.query('UPDATE clientes SET ultimo_login = CURRENT_TIMESTAMP WHERE id = $1', [cliente.id]);
    const s = await seg.crearSesion(req, res, 'cliente', cliente.id);
    const datos = (await pool.query(`SELECT ${CAMPOS_CLIENTE} FROM clientes WHERE id = $1`, [cliente.id])).rows[0];
    // El token va en la cookie HttpOnly. Solo se devuelve en el cuerpo si
    // lo pide un cliente de API (Postman, pruebas): { "modo": "token" }.
    res.json({ success: true, cliente: datos, expira: s.expira, ...(req.body.modo === 'token' ? { token: s.token } : {}) });
});

// Registro de cliente: correo único, contraseña fuerte cifrada con bcrypt,
// sesión iniciada y monedero creado.
const registroCliente = asyncRoute(async (req, res) => {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    const correo = seg.normalizarCorreo(b.correo || b.email);
    const password = String(b.password || '');
    if (!nombre || !correo || !password) return res.status(400).json({ message: 'Nombre, correo y contraseña son obligatorios' });
    if (!seg.nombreValido(nombre)) return res.status(400).json({ message: 'Escribe tu nombre solo con letras (2 a 150 caracteres)' });
    if (!seg.correoValido(correo)) return res.status(400).json({ message: 'El correo no tiene un formato válido' });
    if (!seg.telefonoValido(b.telefono)) return res.status(400).json({ message: 'El teléfono no es válido' });
    const errPass = seg.validarPassword(password, { correo, nombre });
    if (errPass) return res.status(400).json({ message: errPass });

    const existe = await pool.query('SELECT id FROM clientes WHERE LOWER(correo) = $1', [correo]);
    if (existe.rows.length > 0) return res.status(409).json({ message: 'Este correo ya está registrado. Inicia sesión o recupera tu contraseña.' });

    const hash = await seg.hashPassword(password);
    let codigoSocio;
    for (let intento = 0; intento < 5; intento++) {
        codigoSocio = generarCodigoSocio();
        const dup = await pool.query('SELECT 1 FROM clientes WHERE codigo_socio = $1', [codigoSocio]);
        if (dup.rows.length === 0) break;
    }
    const txt = (v, n) => (v ? String(v).trim().slice(0, n) || null : null);
    const db = await pool.connect();
    let cliente;
    try {
        await db.query('BEGIN');
        const result = await db.query(
            `INSERT INTO clientes (nombre, correo, password, telefono, empresa, ciudad, estado, direccion, codigo_postal, codigo_socio, estado_cliente, etapa_crm)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'activo','Prospecto')
             RETURNING ${CAMPOS_CLIENTE}`,
            [nombre.slice(0, 150), correo, hash, txt(b.telefono, 30), txt(b.empresa, 150), txt(b.ciudad, 100), txt(b.estado, 100),
                txt(b.direccion, 200), txt(b.codigo_postal, 15), codigoSocio]
        );
        cliente = result.rows[0];
        await db.query('INSERT INTO metricas_clientes (cliente_id) VALUES ($1) ON CONFLICT (cliente_id) DO NOTHING', [cliente.id]);
        await monederoDe(db, cliente.id);
        await enviarCorreo(db, {
            para: correo, tipo: 'registro', cliente_id: cliente.id,
            asunto: '¡Bienvenido a Kozmok!',
            cuerpo: `Hola ${nombre}:\n\nTu cuenta quedó creada. Ya puedes comprar, recargar tu monedero y seguir tus pedidos.\nTu código de socio es ${codigoSocio}.\n\nSi no fuiste tú, responde este correo.`,
        });
        await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }

    await seg.registrarIntento(req, { ambito: 'cliente', correo, exito: true, motivo: 'registro' });
    const s = await seg.crearSesion(req, res, 'cliente', cliente.id);
    res.status(201).json({ success: true, cliente, expira: s.expira, ...(b.modo === 'token' ? { token: s.token } : {}) });
});

// Login de usuario interno (admin / ventas / logística). Responde también
// con los permisos del rol para armar el menú dinámico.
const loginUsuario = asyncRoute(async (req, res) => {
    const email = seg.normalizarCorreo(req.body.email || req.body.correo);
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ message: 'Email y contraseña son requeridos' });
    if (!seg.correoValido(email) || password.length > 200) return res.status(400).json({ message: 'Credenciales con formato no válido' });

    const bloqueo = await seg.bloqueoActivo({ ambito: 'usuario', correo: email, ip: seg.ipDe(req) });
    if (bloqueo) {
        await seg.registrarIntento(req, { ambito: 'usuario', correo: email, exito: false, motivo: 'bloqueado' });
        return respuestaBloqueo(res, bloqueo);
    }

    const result = await pool.query('SELECT * FROM usuarios WHERE LOWER(email) = $1', [email]);
    const usuario = result.rows[0];
    const valido = await seg.compararPassword(password, usuario && usuario.password_hash);
    if (!valido || !usuario.activo) {
        const r = await seg.registrarFallo(req, { ambito: 'usuario', correo: email, motivo: valido ? 'cuenta_inactiva' : 'credenciales' });
        if (r.bloqueo) return respuestaBloqueo(res, { tipo: r.bloqueo.tipo, hasta: new Date(Date.now() + r.bloqueo.minutos * 60000) });
        return res.status(401).json({
            message: 'Credenciales incorrectas.' + (r.restantes <= 3 ? ` Quedan ${r.restantes} intento(s) antes del bloqueo.` : ''),
            intentos_restantes: r.restantes,
        });
    }

    await seg.registrarIntento(req, { ambito: 'usuario', correo: email, exito: true });
    await pool.query('UPDATE usuarios SET ultimo_login = CURRENT_TIMESTAMP WHERE id = $1', [usuario.id]);
    const s = await seg.crearSesion(req, res, 'usuario', usuario.id);
    const datos = { id: usuario.id, nombre: usuario.nombre, email: usuario.email, telefono: usuario.telefono, rol: usuario.rol, activo: usuario.activo };
    res.json({ success: true, usuario: datos, permisos: PERMISOS[usuario.rol] || [], expira: s.expira, ...(req.body.modo === 'token' ? { token: s.token } : {}) });
});

app.post('/api/auth/login-cliente', limiteAuth, loginCliente);
app.post('/api/auth/registro-cliente', limiteAuth, registroCliente);
app.post('/api/auth/registro', limiteAuth, registroCliente);
app.post('/api/auth/login-usuario', limiteAuth, loginUsuario);
// POST /auth/login: el documento de la Etapa 3 lo usa para el equipo
// interno y el de la Etapa 4 para los clientes. Se distingue con
// { "tipo": "cliente" | "usuario" }; sin tipo, "email" = equipo y
// "correo" = cliente.
app.post('/api/auth/login', limiteAuth, (req, res, next) => {
    const tipo = req.body.tipo || (req.body.correo ? 'cliente' : 'usuario');
    return (tipo === 'cliente' ? loginCliente : loginUsuario)(req, res, next);
});

// Cerrar sesión: la sesión se revoca en el servidor (aunque alguien haya
// copiado la cookie, ya no sirve) y se borra la cookie.
app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    const tipos = req.body && ['cliente', 'usuario'].includes(req.body.tipo) ? [req.body.tipo] : ['cliente', 'usuario'];
    for (const tipo of tipos) {
        const token = seg.tokenDe(req, tipo);
        if (token) await pool.query(
            `UPDATE sesiones SET revocada = CURRENT_TIMESTAMP, motivo_revocacion = 'cerró sesión'
             WHERE token_hash = $1 AND revocada IS NULL`, [seg.sha256(token)]);
        seg.borrarCookie(req, res, seg.COOKIE[tipo]);
    }
    res.json({ message: 'Sesión cerrada' });
}));

// Estado de la sesión de la tienda sin dar 401: lo usa la barra de
// navegación para recuperar la sesión al volver (o limpiarla si venció).
app.get('/api/auth/estado', asyncRoute(async (req, res) => {
    const id = await clienteDeSesion(req);
    if (!id) return res.json({ cliente: null });
    const r = await pool.query(`SELECT ${CAMPOS_CLIENTE} FROM clientes WHERE id = $1 AND estado_cliente = 'activo'`, [id]);
    res.json({ cliente: r.rows[0] || null });
}));

app.get('/api/auth/perfil', requireCliente, asyncRoute(async (req, res) => {
    const r = await pool.query(`SELECT ${CAMPOS_CLIENTE}, preferencias, ultimo_login FROM clientes WHERE id = $1`, [req.cliente.id]);
    const m = await monederoDe(pool, req.cliente.id);
    res.json({ ...r.rows[0], monedero: { saldo: Number(m.saldo), estado: m.estado } });
}));

app.put('/api/auth/perfil', requireCliente, asyncRoute(async (req, res) => {
    const b = req.body || {};
    if (b.nombre !== undefined && !seg.nombreValido(b.nombre)) return res.status(400).json({ message: 'Escribe tu nombre solo con letras (2 a 150 caracteres)' });
    if (!seg.telefonoValido(b.telefono)) return res.status(400).json({ message: 'El teléfono no es válido' });
    if (b.codigo_postal && !/^\d{4,6}$/.test(String(b.codigo_postal))) return res.status(400).json({ message: 'El código postal debe tener 5 dígitos' });
    const t = (v, n) => (v === undefined ? null : String(v).trim().slice(0, n));
    const r = await pool.query(
        `UPDATE clientes SET nombre = COALESCE($1, nombre), telefono = COALESCE($2, telefono), empresa = COALESCE($3, empresa),
                direccion = COALESCE($4, direccion), ciudad = COALESCE($5, ciudad), estado = COALESCE($6, estado),
                codigo_postal = COALESCE($7, codigo_postal)
         WHERE id = $8 RETURNING ${CAMPOS_CLIENTE}`,
        [t(b.nombre, 150), t(b.telefono, 30), t(b.empresa, 150), t(b.direccion, 200), t(b.ciudad, 100), t(b.estado, 100), t(b.codigo_postal, 15), req.cliente.id]);
    res.json({ message: 'Datos actualizados', cliente: r.rows[0] });
}));

// Recuperar contraseña: siempre responde lo mismo (no revela si el correo
// existe). Si existe, "envía" un enlace de un solo uso que vence en 30 min.
app.post('/api/auth/recuperar', limiteAuth, asyncRoute(async (req, res) => {
    const correo = seg.normalizarCorreo(req.body.correo);
    const generico = { message: 'Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña. Revisa tu bandeja.' };
    if (!seg.correoValido(correo)) return res.status(400).json({ message: 'Escribe un correo válido' });
    const c = await pool.query(`SELECT id, nombre, correo FROM clientes WHERE LOWER(correo) = $1 AND estado_cliente = 'activo'`, [correo]);
    if (!c.rows[0]) { await seg.registrarEvento(req, { tipo: 'recuperacion', severidad: 'baja', detalle: `Recuperación pedida para un correo no registrado: ${correo}` }); return res.json(generico); }
    const recientes = await pool.query(`SELECT COUNT(*)::int AS n FROM recuperaciones WHERE cliente_id = $1 AND fecha > CURRENT_TIMESTAMP - INTERVAL '1 hour'`, [c.rows[0].id]);
    if (recientes.rows[0].n >= 3) return res.json(generico);
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO recuperaciones (cliente_id, token_hash, expira, ip) VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '30 minutes', $3)`,
        [c.rows[0].id, seg.sha256(token), seg.ipDe(req)]);
    const enlace = `${req.protocol}://${req.headers.host}/restablecer.html?token=${token}`;
    await enviarCorreo(pool, {
        para: c.rows[0].correo, tipo: 'recuperacion', cliente_id: c.rows[0].id,
        asunto: 'Restablece tu contraseña de Kozmok',
        cuerpo: `Hola ${c.rows[0].nombre}:\n\nRecibimos una solicitud para restablecer tu contraseña. Abre este enlace (vence en 30 minutos y solo sirve una vez):\n${enlace}\n\nSi no fuiste tú, ignora este correo: tu contraseña no cambia.`,
    });
    res.json(generico);
}));

app.post('/api/auth/restablecer', limiteAuth, asyncRoute(async (req, res) => {
    const token = String(req.body.token || '');
    const nueva = String(req.body.nueva || req.body.password || '');
    if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return res.status(400).json({ message: 'El enlace no es válido' });
    const r = await pool.query(
        `SELECT r.id, r.cliente_id, c.correo, c.nombre FROM recuperaciones r JOIN clientes c ON c.id = r.cliente_id
         WHERE r.token_hash = $1 AND r.usado IS NULL AND r.expira > CURRENT_TIMESTAMP`, [seg.sha256(token)]);
    const rec = r.rows[0];
    if (!rec) {
        await seg.registrarEvento(req, { tipo: 'recuperacion', severidad: 'media', detalle: 'Se usó un enlace de recuperación inválido, vencido o ya usado' });
        return res.status(400).json({ message: 'El enlace ya venció o ya se usó. Pide uno nuevo.' });
    }
    const err = seg.validarPassword(nueva, { correo: rec.correo, nombre: rec.nombre });
    if (err) return res.status(400).json({ message: err });
    await pool.query('UPDATE clientes SET password = $1 WHERE id = $2', [await seg.hashPassword(nueva), rec.cliente_id]);
    await pool.query('UPDATE recuperaciones SET usado = CURRENT_TIMESTAMP WHERE cliente_id = $1 AND usado IS NULL', [rec.cliente_id]);
    const cerradas = await seg.revocarSesionesDe('cliente', rec.cliente_id, 'contraseña restablecida');
    await pool.query(`UPDATE bloqueos SET levantado = CURRENT_TIMESTAMP WHERE tipo = 'cuenta' AND valor = $1 AND levantado IS NULL`, [`cliente:${rec.correo}`]);
    await seg.registrarEvento(req, { tipo: 'cambio_password', severidad: 'baja', cliente_id: rec.cliente_id, detalle: `Contraseña restablecida por enlace; ${cerradas} sesión(es) cerradas` });
    await enviarCorreo(pool, { para: rec.correo, tipo: 'seguridad', cliente_id: rec.cliente_id, asunto: 'Tu contraseña cambió',
        cuerpo: `Hola ${rec.nombre}:\n\nTu contraseña se restableció y cerramos tus sesiones abiertas. Si no fuiste tú, contáctanos de inmediato.` });
    res.json({ message: 'Contraseña actualizada. Inicia sesión con tu nueva contraseña.' });
}));

// Sesiones abiertas del cliente (Seguridad de su cuenta).
app.get('/api/auth/sesiones', requireCliente, asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT id, ip, user_agent, creada, ultimo_uso, expira FROM sesiones
         WHERE cliente_id = $1 AND revocada IS NULL AND expira > CURRENT_TIMESTAMP ORDER BY ultimo_uso DESC`, [req.cliente.id]);
    res.json(r.rows.map((s) => ({ ...s, actual: s.id === req.sesion.id })));
}));
app.delete('/api/auth/sesiones/:id', requireCliente, asyncRoute(async (req, res) => {
    const r = await pool.query(
        `UPDATE sesiones SET revocada = CURRENT_TIMESTAMP, motivo_revocacion = 'cerrada por el cliente'
         WHERE id = $1 AND cliente_id = $2 AND revocada IS NULL RETURNING id`, [req.params.id, req.cliente.id]);
    if (!r.rows[0]) return res.status(404).json({ message: 'Sesión no encontrada' });
    res.json({ message: 'Sesión cerrada' });
}));
app.post('/api/auth/sesiones/cerrar-otras', requireCliente, asyncRoute(async (req, res) => {
    const n = await seg.revocarSesionesDe('cliente', req.cliente.id, 'cerrada por el cliente', req.sesion.id);
    res.json({ message: n ? `Se cerraron ${n} sesión(es) en otros dispositivos` : 'No había otras sesiones abiertas' });
}));
// Últimos inicios de sesión (buenos y fallidos) para que el cliente
// note si alguien está intentando entrar a su cuenta.
app.get('/api/auth/actividad', requireCliente, asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT fecha, ip, user_agent, exito, motivo FROM intentos_login
         WHERE tipo = 'cliente' AND correo = LOWER($1) ORDER BY fecha DESC LIMIT 15`, [req.cliente.correo]);
    res.json(r.rows);
}));

// =========================================================
// PROMOCIONES E IMPUESTOS: cálculo de precios (4.1.4 y 4.1.5)
// =========================================================

// Promociones vigentes: activas y con hoy dentro de sus fechas. Se
// guardan 5 segundos en memoria; al pagar se leen de nuevo dentro de la
// transacción para que el precio cobrado sea el real.
let CACHE_PROMOS = { t: 0, lista: [] };
async function promocionesVigentes(db = pool, { fresco = false } = {}) {
    if (!fresco && db === pool && Date.now() - CACHE_PROMOS.t < 5000) return CACHE_PROMOS.lista;
    const r = await db.query(`
        SELECT p.id, p.nombre, p.descripcion, p.tipo_descuento, p.valor::float AS valor, p.alcance, p.categoria_id,
               p.fecha_inicio, p.fecha_fin, p.banner,
               COALESCE(array_agg(pp.producto_id) FILTER (WHERE pp.producto_id IS NOT NULL), '{}') AS productos
        FROM promociones p LEFT JOIN promocion_productos pp ON pp.promocion_id = p.id
        WHERE p.estado = 'activa' AND CURRENT_DATE BETWEEN p.fecha_inicio AND p.fecha_fin
        GROUP BY p.id ORDER BY p.fecha_fin`);
    if (db === pool) CACHE_PROMOS = { t: Date.now(), lista: r.rows };
    return r.rows;
}
const invalidarPromos = () => { CACHE_PROMOS.t = 0; };

const etiquetaPromo = (p) => (p.tipo_descuento === 'porcentaje' ? `-${Number(p.valor)}%` : `-$${Number(p.valor).toLocaleString('es-MX')}`);

// Mejor precio de un producto con las promociones que le aplican (si hay
// varias, la que deja el precio más bajo). Nunca baja de 10 % del precio.
function precioConPromocion(prod, promos) {
    const lista = round2(prod.precio);
    let mejor = null;
    for (const pr of promos) {
        const aplica = pr.alcance === 'todos'
            || (pr.alcance === 'categoria' && Number(pr.categoria_id) === Number(prod.categoria_id))
            || (pr.alcance === 'productos' && pr.productos.map(Number).includes(Number(prod.id)));
        if (!aplica) continue;
        let final = pr.tipo_descuento === 'porcentaje' ? lista * (1 - pr.valor / 100) : lista - pr.valor;
        final = Math.max(round2(final), round2(lista * 0.1));
        if (!mejor || final < mejor.final) mejor = { final, pr };
    }
    if (!mejor || mejor.final >= lista) return { precio: lista, precio_lista: lista, promocion: null };
    return {
        precio: mejor.final, precio_lista: lista,
        promocion: { id: mejor.pr.id, nombre: mejor.pr.nombre, tipo_descuento: mejor.pr.tipo_descuento, valor: mejor.pr.valor,
            etiqueta: etiquetaPromo(mejor.pr), fecha_fin: mejor.pr.fecha_fin },
    };
}

// Agrega a cada producto los campos comerciales del catálogo:
// precio (final, con promoción), precio_lista, promocion, ahorro,
// stock_actual, estado y si es novedad.
function conPrecios(productos, promos) {
    const hace30 = Date.now() - 30 * 86400000;
    return productos.map((p) => {
        const pc = precioConPromocion(p, promos);
        return {
            ...p, ...pc,
            ahorro: round2(pc.precio_lista - pc.precio),
            stock_actual: p.stock,
            estado: p.activo ? 'activo' : 'inactivo',
            nuevo: p.fecha_creacion ? new Date(p.fecha_creacion).getTime() > hace30 : false,
        };
    });
}

async function impuestosActivos(db = pool) {
    const r = await db.query(`SELECT id, nombre, porcentaje::float AS porcentaje FROM impuestos WHERE estado = 'activo' ORDER BY id`);
    return r.rows;
}
const ENVIO_COSTO = 199;
const ENVIO_GRATIS_DESDE = 10000;

// Resumen de una compra: subtotal → impuestos configurados → envío →
// descuento por puntos → total. Lo usan el carrito, el checkout, el pago
// y las órdenes del ERP, así el cálculo es uno solo.
function calcularResumen({ lineas, impuestos, descuentoPuntos = 0 }) {
    const productos = round2(lineas.reduce((a, l) => a + Number(l.precio) * l.cantidad, 0));
    const garantias = round2(lineas.reduce((a, l) => a + Number(l.garantia_costo || 0), 0));
    const ahorro = round2(lineas.reduce((a, l) => a + (Number(l.precio_lista || l.precio) - Number(l.precio)) * l.cantidad, 0));
    const subtotal = round2(productos + garantias);
    const impuestos_detalle = impuestos.map((i) => ({ nombre: i.nombre, porcentaje: Number(i.porcentaje), monto: round2(subtotal * Number(i.porcentaje) / 100) }));
    const totalImpuestos = round2(impuestos_detalle.reduce((a, i) => a + i.monto, 0));
    const envio = subtotal === 0 || subtotal >= ENVIO_GRATIS_DESDE ? 0 : ENVIO_COSTO;
    const descuento = round2(Math.min(descuentoPuntos, subtotal));
    const total = round2(subtotal + totalImpuestos + envio - descuento);
    return {
        piezas: lineas.reduce((a, l) => a + l.cantidad, 0),
        productos, garantias, subtotal, ahorro_promociones: ahorro,
        impuestos: totalImpuestos, impuestos_detalle,
        tasa_impuestos: round2(impuestos.reduce((a, i) => a + Number(i.porcentaje), 0)),
        envio, envio_gratis_desde: ENVIO_GRATIS_DESDE, descuento_puntos: descuento, total,
    };
}

// =========================================================
// CATÁLOGO DE ARTÍCULOS (4.1.1) — público
// =========================================================

app.get('/api/categorias', asyncRoute(async (req, res) => {
    const result = await pool.query(`
        SELECT c.*, COUNT(p.id) FILTER (WHERE p.activo)::int AS productos
        FROM categorias c LEFT JOIN productos p ON p.categoria_id = c.id
        GROUP BY c.id ORDER BY c.id ASC`);
    res.json(result.rows);
}));

const SELECT_PRODUCTO = `
    SELECT p.*, c.nombre AS categoria_nombre, c.icono AS categoria_icono
    FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id`;

// GET /catalogo  ?categoria= (nombre o id)  ?buscar=  ?marca=  ?uso=
//                ?precio_min= ?precio_max=  ?destacado=1  ?promocion=1
//                ?novedades=1  ?orden=nombre|precio_asc|precio_desc|recientes|mas_vendidos
//                ?limite=
// (GET /productos es el mismo catálogo con los nombres de filtros que ya
// usaban las pantallas: busqueda en vez de buscar.)
const listarCatalogo = asyncRoute(async (req, res) => {
    const q = req.query;
    // Atajo para el comparador: ?ids=1,2,3 (máximo 4)
    if (q.ids) {
        const ids = String(q.ids).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 4);
        if (ids.length === 0) return res.json([]);
        const r = await pool.query(`${SELECT_PRODUCTO} WHERE p.id = ANY($1::int[])`, [ids]);
        const lista = conPrecios(r.rows, await promocionesVigentes());
        return res.json(ids.map((id) => lista.find((x) => x.id === id)).filter(Boolean));
    }
    const cond = ['p.activo = true'];
    const values = [];
    const v = (x) => { values.push(x); return `$${values.length}`; };
    const categoria = q.categoria;
    if (categoria) cond.push(/^\d+$/.test(String(categoria)) ? `p.categoria_id = ${v(Number(categoria))}` : `c.nombre = ${v(String(categoria))}`);
    if (q.uso) cond.push(`${v(String(q.uso))} = ANY(p.uso_recomendado)`);
    if (q.marca) cond.push(`p.marca ILIKE ${v(`%${String(q.marca)}%`)}`);
    if (q.precio_min && Number.isFinite(Number(q.precio_min))) cond.push(`p.precio >= ${v(Number(q.precio_min))}`);
    if (q.precio_max && Number.isFinite(Number(q.precio_max))) cond.push(`p.precio <= ${v(Number(q.precio_max))}`);
    const buscar = String(q.buscar || q.busqueda || '').trim().slice(0, 80);
    if (buscar) { const ph = v(`%${buscar}%`); cond.push(`(p.nombre ILIKE ${ph} OR p.descripcion ILIKE ${ph} OR p.marca ILIKE ${ph} OR c.nombre ILIKE ${ph})`); }
    if (q.destacado === '1' || q.destacado === 'true') cond.push('p.destacado = true');
    if (q.novedades === '1') cond.push(`p.fecha_creacion > CURRENT_TIMESTAMP - INTERVAL '30 days'`);

    // El orden solo puede ser uno de estos (lista blanca): nunca se arma
    // ORDER BY con texto del usuario.
    const ORDENES = {
        nombre: 'p.nombre ASC', precio_asc: 'p.precio ASC', precio_desc: 'p.precio DESC',
        recientes: 'p.fecha_creacion DESC, p.id DESC', mas_vendidos: 'vendidos DESC, p.nombre ASC',
    };
    const orden = ORDENES[q.orden] || ORDENES.nombre;
    const r = await pool.query(`
        SELECT p.*, c.nombre AS categoria_nombre, c.icono AS categoria_icono,
               COALESCE((SELECT SUM(pd.cantidad) FROM pedido_detalle pd JOIN pedidos pe ON pe.id = pd.pedido_id
                          WHERE pd.producto_id = p.id AND pe.estado <> 'cancelado'), 0)::int AS vendidos
        FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id
        WHERE ${cond.join(' AND ')}
        ORDER BY ${orden}`, values);
    let lista = conPrecios(r.rows, await promocionesVigentes());
    if (q.promocion === '1') lista = lista.filter((p) => p.promocion);
    const limite = Math.min(Math.max(Number(q.limite) || 0, 0), 100);
    res.json(limite ? lista.slice(0, limite) : lista);
});
app.get('/api/catalogo', listarCatalogo);
app.get('/api/productos', listarCatalogo);

// GET /catalogo/{id}: ficha comercial con promoción y planes de garantía.
const detalleCatalogo = asyncRoute(async (req, res) => {
    const result = await pool.query(`${SELECT_PRODUCTO} WHERE p.id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    const [p] = conPrecios(result.rows, await promocionesVigentes());
    res.json({ ...p, garantias: planesParaProducto(p.precio) });
});
app.get('/api/catalogo/:id', detalleCatalogo);
app.get('/api/productos/:id', detalleCatalogo);

// Planes de garantía para un producto (los usa el modal del catálogo)
app.get('/api/productos/:id/garantias', asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT id, precio, categoria_id FROM productos WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(planesParaProducto(precioConPromocion(r.rows[0], await promocionesVigentes()).precio));
}));

// Promociones vigentes para el banner de la tienda (públicas).
app.get('/api/promociones', asyncRoute(async (req, res) => {
    const promos = await promocionesVigentes();
    const prods = (await pool.query('SELECT id, categoria_id, precio FROM productos WHERE activo = true')).rows;
    res.json(promos.map((pr) => ({
        id: pr.id, nombre: pr.nombre, descripcion: pr.descripcion, tipo_descuento: pr.tipo_descuento, valor: pr.valor,
        etiqueta: etiquetaPromo(pr), alcance: pr.alcance, categoria_id: pr.categoria_id, fecha_inicio: pr.fecha_inicio, fecha_fin: pr.fecha_fin,
        banner: pr.banner, productos: prods.filter((p) => precioConPromocion(p, [pr]).promocion).length,
    })));
}));

// Impuestos activos (los muestra el checkout: "IVA 16 %").
app.get('/api/impuestos', asyncRoute(async (req, res) => {
    res.json(await impuestosActivos());
}));

// Reseñas públicas de un producto (promedio + lista)
app.get('/api/productos/:id/resenas', asyncRoute(async (req, res) => {
    const stats = await pool.query(
        'SELECT ROUND(AVG(calificacion), 1) AS promedio, COUNT(*)::int AS total FROM resenas WHERE producto_id = $1',
        [req.params.id]
    );
    const lista = await pool.query(
        `SELECT re.calificacion, re.comentario, re.fecha, c.nombre AS cliente_nombre
         FROM resenas re JOIN clientes c ON re.cliente_id = c.id
         WHERE re.producto_id = $1 ORDER BY re.fecha DESC LIMIT 30`,
        [req.params.id]
    );
    // Si viene la sesión de un cliente: su reseña (si tiene) y si puede
    // reseñar, que es solo cuando ya recibió el producto.
    let mi_resena = null;
    let puede_resenar = false;
    const cid = await clienteDeSesion(req);
    if (cid) {
        const [mia, compra] = await Promise.all([
            pool.query('SELECT calificacion, comentario, fecha FROM resenas WHERE cliente_id = $1 AND producto_id = $2', [cid, req.params.id]),
            clienteRecibioProducto(cid, req.params.id),
        ]);
        mi_resena = mia.rows[0] || null;
        puede_resenar = compra;
    }
    res.json({
        promedio: Number(stats.rows[0].promedio) || 0,
        total: stats.rows[0].total,
        resenas: lista.rows,
        mi_resena,
        puede_resenar,
        sesion: Boolean(cid),
    });
}));

// Una reseña solo la deja quien recibió el producto (pedido entregado).
async function clienteRecibioProducto(clienteId, productoId) {
    const r = await pool.query(
        `SELECT 1 FROM pedido_detalle pi JOIN pedidos p ON p.id = pi.pedido_id
          WHERE p.cliente_id = $1 AND pi.producto_id = $2 AND p.estado = 'entregado' LIMIT 1`,
        [clienteId, productoId]);
    return r.rows.length > 0;
}

// =========================================================
// CHATBOT DE RECOMENDACIONES
// Reglas: filtra por presupuesto + categoría explícitos (los
// que vienen de los chips) + stock, e infiere uso/presupuesto/
// categoría/palabras clave del texto libre para puntuar por
// relevancia. Nunca deja al cliente sin respuesta: si nada
// calza perfecto, regresa lo más cercano disponible.
// =========================================================
const USO_PALABRAS = {
    gaming: ['gam', 'jueg', 'jugar', 'jugad', 'fps', 'videojueg'],
    oficina: ['oficin', 'trabaj', 'excel', 'documento', 'ofimatic', 'ofimátic'],
    diseno: ['diseñ', 'diseno', 'edicion', 'edición', 'photoshop', 'illustrator', 'render', 'fotograf', 'video'],
    programacion: ['programa', 'codigo', 'código', 'desarroll', 'software', 'compilar'],
    estudiante: ['estudi', 'escuela', 'tarea', 'universidad', 'clases', 'carrera'],
    streaming: ['streaming', 'transmit', 'twitch', 'directo', 'stream'],
    servidor: ['servidor', 'server', 'nas'],
};
const CATEGORIA_PALABRAS = {
    'Laptops': ['laptop', 'portátil', 'portatil', 'notebook'],
    'PC de Escritorio': ['de escritorio', 'torre', 'pc de escritorio', 'computadora de escritorio'],
    'Monitores': ['monitor', 'pantalla'],
    'Componentes': ['tarjeta gráfica', 'tarjeta grafica', 'procesador', 'memoria ram', 'componente', 'ssd', 'disco duro', 'placa base', 'gabinete', 'fuente de poder'],
    'Periféricos': ['teclado', 'mouse', 'periférico', 'periferico'],
    'Accesorios': ['audífonos', 'audifonos', 'webcam', 'accesorio', 'bocina'],
};
const STOP_PALABRAS = new Set([
    'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'para', 'con', 'que', 'y', 'o',
    'en', 'a', 'mi', 'me', 'quiero', 'busco', 'necesito', 'algo', 'por', 'favor', 'es', 'del', 'al',
    'tengo', 'hola', 'buenas', 'buenos', 'dias', 'días', 'gracias', 'quisiera', 'puedes', 'puede',
]);

function analizarMensajeLibre(mensaje) {
    if (!mensaje || typeof mensaje !== 'string') return { presupuesto: null, uso: null, categoria: null, palabras: [] };
    const texto = mensaje.toLowerCase();

    // Presupuesto: "15 mil", "15,000", "$15000", "20k"
    let presupuesto = null;
    const milMatch = texto.match(/(\d+(?:[.,]\d+)?)\s*(mil|k\b)/);
    const numMatch = texto.match(/\$?\s?(\d[\d,.]{2,7})/);
    if (milMatch) presupuesto = Math.round(parseFloat(milMatch[1].replace(',', '.')) * 1000);
    else if (numMatch) presupuesto = Number(numMatch[1].replace(/[,.]/g, ''));

    let uso = null;
    for (const [clave, kws] of Object.entries(USO_PALABRAS)) {
        if (kws.some((k) => texto.includes(k))) { uso = clave; break; }
    }

    let categoria = null;
    for (const [nombre, kws] of Object.entries(CATEGORIA_PALABRAS)) {
        if (kws.some((k) => texto.includes(k))) { categoria = nombre; break; }
    }

    const palabras = texto
        .replace(/[^\p{L}0-9\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_PALABRAS.has(w) && isNaN(Number(w)));

    return { presupuesto, uso, categoria, palabras };
}

app.post('/api/chatbot/recomendar', asyncRoute(async (req, res) => {
    const { uso, categoria } = req.body;
    const presupuesto = Number(req.body.presupuesto) > 0 ? Number(req.body.presupuesto) : null;
    const mensaje = req.body.mensaje ? String(req.body.mensaje).slice(0, 500) : null;
    // El cliente sale de su sesión, no del cuerpo: así nadie puede registrar
    // interacciones a nombre de otro cliente.
    const cliente_id = await clienteDeSesion(req);
    const inferido = analizarMensajeLibre(mensaje);

    // Los valores explícitos (chips) siguen siendo filtro duro, igual que antes.
    // Lo inferido del texto libre solo suma puntaje: nunca deja la búsqueda en cero.
    const cond = ['p.activo = true', 'p.stock > 0'];
    const values = [];
    let i = 1;
    if (presupuesto) { cond.push(`p.precio <= $${i++}`); values.push(presupuesto); }
    if (categoria) { cond.push(`c.nombre = $${i++}`); values.push(categoria); }

    const query = `
        SELECT p.*, c.nombre AS categoria_nombre
        FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id
        WHERE ${cond.join(' AND ')}
        ORDER BY p.precio DESC
    `;
    const result = await pool.query(query, values);
    result.rows = conPrecios(result.rows, await promocionesVigentes());

    const usoFinal = uso || inferido.uso;
    const presupuestoFinal = presupuesto || inferido.presupuesto;

    // Puntaje: coincidencia de uso, cercanía al presupuesto, categoría y
    // palabras sueltas inferidas del texto libre, y disponibilidad de stock.
    let productos = result.rows.map((p) => {
        let score = 0;
        if (usoFinal && p.uso_recomendado && p.uso_recomendado.includes(usoFinal)) score += 3;
        if (presupuestoFinal) {
            const cercania = 1 - Math.abs(presupuestoFinal - p.precio) / presupuestoFinal;
            score += Math.max(cercania, 0) * 2;
        }
        if (!categoria && inferido.categoria && p.categoria_nombre === inferido.categoria) score += 2;
        if (inferido.palabras.length) {
            const texto = `${p.nombre} ${p.marca || ''} ${p.descripcion || ''} ${p.procesador || ''} ${p.tarjeta_grafica || ''}`.toLowerCase();
            score += inferido.palabras.filter((w) => texto.includes(w)).length * 1.2;
        }
        if (p.stock > p.stock_minimo) score += 0.5;
        return { ...p, score };
    });

    // Ordenado por puntaje: si nada es un match perfecto, esto ya deja
    // arriba lo más cercano disponible en vez de no regresar nada.
    productos.sort((a, b) => b.score - a.score);
    const sugerencias = productos.slice(0, 5);

    // Mensaje conversacional según lo que se entendió del texto/chips
    let respuesta;
    if (sugerencias.length === 0) {
        respuesta = presupuesto
            ? `No encontré equipo${categoria ? ` de ${categoria.toLowerCase()}` : ''} disponible con ese presupuesto (hasta $${Number(presupuesto).toLocaleString('es-MX')}). ¿Quieres que busque un rango más amplio?`
            : 'No encontré productos disponibles en inventario ahora mismo. ¿Puedes darme más detalles?';
    } else {
        const piezas = [];
        if (usoFinal) piezas.push(`para ${usoFinal}`);
        if (presupuestoFinal) piezas.push(`con un presupuesto cercano a $${Number(presupuestoFinal).toLocaleString('es-MX')}`);
        respuesta = piezas.length
            ? `Buscando ${piezas.join(' y ')}, esto es lo más cercano que tengo disponible:`
            : 'Con base en lo que escribiste, esto es lo más cercano que tengo disponible:';
    }

    try {
        await pool.query(
            `INSERT INTO chatbot_consultas (cliente_id, presupuesto, uso, categoria, mensaje, productos_sugeridos)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [cliente_id || null, presupuestoFinal || null, usoFinal || null, categoria || inferido.categoria || null, mensaje || null, sugerencias.map((s) => s.id)]
        );
        // Si hay cliente logueado, esto también cuenta como una interacción CRM
        if (cliente_id) {
            await pool.query(
                `INSERT INTO interacciones (cliente_id, tipo, descripcion) VALUES ($1, 'chat', $2)`,
                [cliente_id, `Consulta al chatbot: ${mensaje || `uso=${usoFinal || 'N/A'}, presupuesto=${presupuestoFinal || 'N/A'}`}`]
            );
        }
    } catch (e) {
        // Registrar la consulta es opcional; si falla no se interrumpe la respuesta.
    }

    res.json({ respuesta, sugerencias });
}));

// =========================================================
// CARRITO DE COMPRAS (4.1.3) — requiere sesión de cliente
//   Carrito (id, cliente_id, estado) + CarritoDetalle (id, carrito_id,
//   producto_id, cantidad, precio_unitario).
//   POST /carrito/agregar          GET /carrito/{cliente_id}
//   PUT  /carrito/item/{id}        DELETE /carrito/item/{id}
//   DELETE /carrito/vaciar/{cliente_id}
// =========================================================
app.use('/api/carrito', requireCliente);

// Carrito activo del cliente; si no tiene, se crea (uno solo por cliente).
async function carritoActivo(db, clienteId, { crear = true } = {}) {
    const sel = () => db.query(`SELECT * FROM carrito WHERE cliente_id = $1 AND estado = 'activo'`, [clienteId]);
    let r = await sel();
    if (r.rows[0] || !crear) return r.rows[0] || null;
    await db.query(`INSERT INTO carrito (cliente_id) VALUES ($1) ON CONFLICT (cliente_id) WHERE estado = 'activo' DO NOTHING`, [clienteId]);
    r = await sel();
    return r.rows[0];
}

// Lee el carrito con precios vigentes (promociones), stock y el resumen
// de la compra. Si un precio cambió desde que se agregó, se actualiza.
async function leerCarrito(db, clienteId, { bloquear = false, promos = null } = {}) {
    const carrito = await carritoActivo(db, clienteId, { crear: false });
    if (!carrito) return { carrito: null, items: [], resumen: calcularResumen({ lineas: [], impuestos: await impuestosActivos(db) }) };
    const r = await db.query(`
        SELECT cd.id, cd.producto_id, cd.cantidad, cd.precio_unitario, cd.garantia_clave, cd.garantia_plan, cd.garantia_meses,
               cd.garantia_costo, cd.fecha_agregado,
               p.nombre, p.marca, p.precio, p.categoria_id, p.imagen_url, p.stock, p.stock_minimo, p.activo, c.nombre AS categoria_nombre
        FROM carrito_detalle cd JOIN productos p ON p.id = cd.producto_id
        LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE cd.carrito_id = $1 ORDER BY cd.fecha_agregado DESC, cd.id DESC
        ${bloquear ? 'FOR UPDATE OF cd, p' : ''}`, [carrito.id]);
    const vigentes = promos || await promocionesVigentes(db, { fresco: db !== pool });
    const items = [];
    for (const row of r.rows) {
        const pc = precioConPromocion({ id: row.producto_id, precio: row.precio, categoria_id: row.categoria_id }, vigentes);
        const gCosto = costoGarantia(pc.precio, row.garantia_clave) * row.cantidad;
        if (Number(row.precio_unitario) !== pc.precio || Number(row.garantia_costo) !== gCosto) {
            await db.query('UPDATE carrito_detalle SET precio_unitario = $1, garantia_costo = $2 WHERE id = $3', [pc.precio, gCosto, row.id]);
        }
        items.push({
            id: row.id, producto_id: row.producto_id, nombre: row.nombre, marca: row.marca, categoria_nombre: row.categoria_nombre,
            imagen_url: row.imagen_url, stock: row.stock, activo: row.activo, cantidad: row.cantidad,
            precio: pc.precio, precio_unitario: pc.precio, precio_lista: pc.precio_lista, promocion: pc.promocion,
            subtotal: round2(pc.precio * row.cantidad), garantia_clave: row.garantia_clave, garantia_plan: row.garantia_plan,
            garantia_meses: row.garantia_meses, garantia_costo: gCosto,
            disponible: row.activo && row.stock >= row.cantidad,
        });
    }
    return { carrito, items, resumen: calcularResumen({ lineas: items, impuestos: await impuestosActivos(db) }) };
}

// GET /carrito/{cliente_id}: solo el propio (el id de la URL debe ser el de la sesión).
app.get('/api/carrito/:clienteId', mismoCliente, asyncRoute(async (req, res) => {
    const c = await leerCarrito(pool, req.cliente.id);
    res.json({ carrito_id: c.carrito ? c.carrito.id : null, estado: c.carrito ? c.carrito.estado : 'activo', items: c.items, resumen: c.resumen });
}));

const agregarAlCarrito = asyncRoute(async (req, res) => {
    const producto_id = Number(req.body.producto_id);
    const cantidad = Math.floor(Number(req.body.cantidad ?? 1));
    if (!seg.esId(producto_id)) return res.status(400).json({ message: 'Producto no válido' });
    if (!(cantidad >= 1 && cantidad <= 99)) return res.status(400).json({ message: 'La cantidad debe estar entre 1 y 99' });
    const gClave = planGarantia(req.body.garantia).clave;

    const prod = await pool.query('SELECT id, precio, stock, nombre, categoria_id FROM productos WHERE id = $1 AND activo = true', [producto_id]);
    if (prod.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    const p = prod.rows[0];
    const precio = precioConPromocion(p, await promocionesVigentes()).precio;
    const carrito = await carritoActivo(pool, req.cliente.id);

    const existente = await pool.query('SELECT id, cantidad, garantia_clave FROM carrito_detalle WHERE carrito_id = $1 AND producto_id = $2', [carrito.id, producto_id]);
    // No se aparta más de lo que hay en inventario.
    const yaEnCarrito = existente.rows.length ? existente.rows[0].cantidad : 0;
    const disponible = Number(p.stock);
    if (disponible <= 0) return res.status(400).json({ message: `"${p.nombre}" está agotado` });
    if (yaEnCarrito + cantidad > disponible) {
        return res.status(400).json({ message: yaEnCarrito
            ? `Solo hay ${disponible} disponibles y ya tienes ${yaEnCarrito} en tu carrito`
            : `Solo hay ${disponible} disponibles` });
    }
    if (yaEnCarrito + cantidad > 99) return res.status(400).json({ message: 'Máximo 99 piezas por producto' });
    if (existente.rows.length > 0) {
        const row = existente.rows[0];
        const nuevaCantidad = row.cantidad + cantidad;
        // si se pidió una garantía explícita se toma esa; si no, se conserva la que ya tenía
        const claveFinal = (gClave !== 'none') ? gClave : row.garantia_clave;
        const pf = planGarantia(claveFinal);
        await pool.query(
            `UPDATE carrito_detalle SET cantidad = $1, precio_unitario = $2, garantia_clave = $3, garantia_plan = $4,
                 garantia_meses = $5, garantia_costo = $6 WHERE id = $7`,
            [nuevaCantidad, precio, claveFinal, pf.meses ? pf.label : null, pf.meses, costoGarantia(precio, claveFinal) * nuevaCantidad, row.id]
        );
    } else {
        const gPlan = planGarantia(gClave);
        await pool.query(
            `INSERT INTO carrito_detalle (carrito_id, producto_id, cantidad, precio_unitario, garantia_clave, garantia_plan, garantia_meses, garantia_costo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [carrito.id, producto_id, cantidad, precio, gClave, gPlan.meses ? gPlan.label : null, gPlan.meses, costoGarantia(precio, gClave) * cantidad]
        );
    }
    await pool.query('UPDATE carrito SET fecha_actualizacion = CURRENT_TIMESTAMP WHERE id = $1', [carrito.id]);
    const c = await leerCarrito(pool, req.cliente.id);
    res.status(201).json({ message: 'Agregado al carrito', piezas: c.resumen.piezas, resumen: c.resumen });
});
app.post('/api/carrito/agregar', agregarAlCarrito);
app.post('/api/carrito', agregarAlCarrito);

// PUT /carrito/item/{id}: cantidad y/o garantía de una línea propia.
const actualizarItem = asyncRoute(async (req, res) => {
    const cur = await pool.query(
        `SELECT cd.id, cd.cantidad, cd.garantia_clave, cd.precio_unitario, p.stock
         FROM carrito_detalle cd JOIN carrito ca ON ca.id = cd.carrito_id JOIN productos p ON p.id = cd.producto_id
         WHERE cd.id = $1 AND ca.cliente_id = $2 AND ca.estado = 'activo'`,
        [req.params.id, req.cliente.id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ message: 'Ítem no encontrado en tu carrito' });
    const row = cur.rows[0];
    let cantidad = row.cantidad;
    if (req.body.cantidad !== undefined) {
        cantidad = Math.floor(Number(req.body.cantidad));
        if (!(cantidad >= 1 && cantidad <= 99)) return res.status(400).json({ message: 'La cantidad debe estar entre 1 y 99' });
        if (cantidad > Number(row.stock)) return res.status(400).json({ message: `Solo hay ${row.stock} disponibles` });
    }
    const gClave = req.body.garantia !== undefined ? planGarantia(req.body.garantia).clave : row.garantia_clave;
    const pf = planGarantia(gClave);
    await pool.query(
        `UPDATE carrito_detalle SET cantidad = $1, garantia_clave = $2, garantia_plan = $3,
             garantia_meses = $4, garantia_costo = $5 WHERE id = $6`,
        [cantidad, gClave, pf.meses ? pf.label : null, pf.meses, costoGarantia(row.precio_unitario, gClave) * cantidad, req.params.id]
    );
    const c = await leerCarrito(pool, req.cliente.id);
    res.json({ message: 'Carrito actualizado', items: c.items, resumen: c.resumen });
});
app.put('/api/carrito/item/:id', actualizarItem);
app.put('/api/carrito/:id', actualizarItem);

const quitarItem = asyncRoute(async (req, res) => {
    const r = await pool.query(
        `DELETE FROM carrito_detalle cd USING carrito ca
         WHERE cd.carrito_id = ca.id AND cd.id = $1 AND ca.cliente_id = $2 AND ca.estado = 'activo' RETURNING cd.id`,
        [req.params.id, req.cliente.id]);
    if (!r.rows[0]) return res.status(404).json({ message: 'Ítem no encontrado en tu carrito' });
    res.json({ message: 'Producto eliminado del carrito' });
});
app.delete('/api/carrito/item/:id', quitarItem);

const vaciarCarrito = asyncRoute(async (req, res) => {
    await pool.query(
        `DELETE FROM carrito_detalle WHERE carrito_id IN (SELECT id FROM carrito WHERE cliente_id = $1 AND estado = 'activo')`,
        [req.cliente.id]);
    res.json({ message: 'Carrito vaciado' });
});
app.delete('/api/carrito/vaciar/:clienteId', mismoCliente, vaciarCarrito);
app.delete('/api/carrito', vaciarCarrito);
app.delete('/api/carrito/:id', quitarItem);

// =========================================================
// PEDIDOS (checkout + seguimiento)
// =========================================================

// Aplica el "cobro" de un pedido al Club: otorga puntos ganados, actualiza
// las métricas del cliente y su etapa CRM. Se usa al pagar con tarjeta (al
// instante) o al registrar el pago de un pedido SPEI / en tienda.
// opciones.metricas = false cuando el UPDATE de estado del pedido ya va a
// disparar el trigger trg_pedido_metricas (así no se cuenta dos veces).
async function aplicarCobroPedido(client, pedido, opciones = {}) {
    const sumarMetricas = opciones.metricas !== false;
    const cliente_id = pedido.cliente_id;
    const subtotal = Number(pedido.subtotal);
    const total = Number(pedido.total);
    const m = await client.query(
        'SELECT COALESCE(valor_total_compras,0) AS gasto, COALESCE(total_compras,0) AS compras FROM metricas_clientes WHERE cliente_id = $1',
        [cliente_id]
    );
    const { actual: nivel } = nivelRecompensas(m.rows[0]?.gasto || 0, m.rows[0]?.compras || 0);
    const puntos_ganados = Math.floor((subtotal / 20) * nivel.multiplicador);
    if (puntos_ganados > 0) {
        await client.query('UPDATE clientes SET puntos = puntos + $1 WHERE id = $2', [puntos_ganados, cliente_id]);
        await client.query(
            `INSERT INTO movimientos_puntos (cliente_id, tipo, puntos, motivo, pedido_id) VALUES ($1,'ganado',$2,$3,$4)`,
            [cliente_id, puntos_ganados, `Compra ${pedido.numero_orden} (nivel ${nivel.nombre})`, pedido.id]
        );
    }
    if (sumarMetricas) await client.query(
        `INSERT INTO metricas_clientes (cliente_id, total_compras, valor_total_compras, ticket_promedio)
         VALUES ($1, 1, $2, $2)
         ON CONFLICT (cliente_id) DO UPDATE SET
             total_compras       = metricas_clientes.total_compras + 1,
             valor_total_compras = metricas_clientes.valor_total_compras + $2,
             ticket_promedio     = (metricas_clientes.valor_total_compras + $2) / (metricas_clientes.total_compras + 1)`,
        [cliente_id, total]
    );
    await client.query(
        `UPDATE clientes SET etapa_crm = CASE WHEN etapa_crm = 'Prospecto' THEN 'Activo' ELSE etapa_crm END WHERE id = $1`,
        [cliente_id]
    );
    return puntos_ganados;
}

// Estados en los que el pedido ya contó como compra en metricas_clientes
// (ver trigger trg_pedido_metricas y aplicarCobroPedido).
const ESTADOS_COBRADOS = ['confirmado', 'procesando', 'enviado', 'entregado'];

// Cancela un pedido (de la tienda o del ERP) y deshace todo lo que
// generó, en la transacción de `client`:
//   - regresa el stock y registra un movimiento de entrada por producto,
//   - cancela sus garantías,
//   - devuelve los puntos que el cliente canjeó en él,
//   - quita los puntos que ganó con él y lo resta de sus métricas CRM.
// Así el inventario del SCM y los reportes del ERP no se desajustan.
// Procesos internos (ERP): deja en la bitácora de la orden cada paso que
// vivió (lo automático y lo que hizo alguien del equipo).
async function registrarProceso(db, pedidoId, paso, descripcion, { usuarioId = null, automatico = true } = {}) {
    await db.query(
        `INSERT INTO procesos_erp (pedido_id, paso, descripcion, automatico, usuario_id) VALUES ($1,$2,$3,$4,$5)`,
        [pedidoId, paso, String(descripcion).slice(0, 300), automatico, usuarioId]
    );
}

async function cancelarPedido(client, pedido, { usuarioId = null } = {}) {
    if (pedido.estado === 'cancelado') throw new Error('El pedido ya está cancelado');
    if (['enviado', 'entregado'].includes(pedido.estado)) {
        throw new Error('El pedido ya salió del almacén; regístralo como devolución (movimiento de entrada) en lugar de cancelarlo');
    }
    const items = await client.query('SELECT producto_id, cantidad FROM pedido_detalle WHERE pedido_id = $1', [pedido.id]);
    for (const it of items.rows) {
        await client.query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [it.cantidad, it.producto_id]);
        await client.query(
            `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, usuario_id) VALUES ($1,'entrada',$2,$3,$4)`,
            [it.producto_id, it.cantidad, `Cancelación de pedido ${pedido.numero_orden}`, usuarioId]
        );
    }
    await client.query(`UPDATE garantias SET estado = 'cancelada' WHERE pedido_id = $1 AND estado = 'activa'`, [pedido.id]);

    // Puntos canjeados (el descuento se retuvo al crear el pedido): se devuelven.
    const canjeados = Math.round(Number(pedido.descuento || 0) / VALOR_PUNTO);
    if (canjeados > 0) {
        await client.query('UPDATE clientes SET puntos = puntos + $1 WHERE id = $2', [canjeados, pedido.cliente_id]);
        await client.query(
            `INSERT INTO movimientos_puntos (cliente_id, tipo, puntos, motivo, pedido_id) VALUES ($1,'ajuste',$2,$3,$4)`,
            [pedido.cliente_id, canjeados, `Devolución por cancelar ${pedido.numero_orden}`, pedido.id]
        );
    }
    // Puntos ganados con este pedido: se retiran (sin dejar el saldo en negativo).
    const g = await client.query(
        `SELECT COALESCE(SUM(puntos),0)::int AS n FROM movimientos_puntos WHERE pedido_id = $1 AND tipo = 'ganado'`,
        [pedido.id]
    );
    const ganados = g.rows[0].n;
    if (ganados > 0) {
        await client.query('UPDATE clientes SET puntos = GREATEST(puntos - $1, 0) WHERE id = $2', [ganados, pedido.cliente_id]);
        await client.query(
            `INSERT INTO movimientos_puntos (cliente_id, tipo, puntos, motivo, pedido_id) VALUES ($1,'ajuste',$2,$3,$4)`,
            [pedido.cliente_id, -ganados, `Puntos retirados por cancelar ${pedido.numero_orden}`, pedido.id]
        );
    }
    // Si ya contaba como compra, se resta de las métricas del cliente.
    if (ESTADOS_COBRADOS.includes(pedido.estado)) {
        await client.query(
            `UPDATE metricas_clientes SET
                 total_compras       = GREATEST(total_compras - 1, 0),
                 valor_total_compras = GREATEST(valor_total_compras - $2, 0),
                 ticket_promedio     = CASE WHEN total_compras - 1 > 0
                                            THEN GREATEST(valor_total_compras - $2, 0) / (total_compras - 1) ELSE 0 END
             WHERE cliente_id = $1`,
            [pedido.cliente_id, Number(pedido.total)]
        );
        // Si era su única compra, vuelve a Prospecto (pasó a Activo por ella).
        await client.query(
            `UPDATE clientes SET etapa_crm = 'Prospecto'
             WHERE id = $1 AND etapa_crm = 'Activo'
               AND COALESCE((SELECT total_compras FROM metricas_clientes WHERE cliente_id = $1), 0) = 0`,
            [pedido.cliente_id]
        );
    }
    // Pago: si ya se había cobrado se reembolsa (si fue con monedero, el
    // dinero regresa al saldo del cliente); si estaba pendiente se cancela.
    const pg = await client.query('SELECT * FROM pagos WHERE pedido_id = $1 FOR UPDATE', [pedido.id]);
    let reembolso_monedero = 0;
    if (pg.rows[0]) {
        const pago = pg.rows[0];
        if (pago.estado === 'aprobado' && pago.metodo_pago === 'monedero' && pedido.cliente_id) {
            const m = await monederoDe(client, pedido.cliente_id, { bloquear: true });
            const nuevo = round2(Number(m.saldo) + Number(pago.monto));
            await client.query('UPDATE monederos SET saldo = $1 WHERE id = $2', [nuevo, m.id]);
            await client.query(
                `INSERT INTO movimientos_monedero (monedero_id, tipo, monto, saldo_anterior, saldo_nuevo, concepto, metodo_pago, pedido_id, usuario_id)
                 VALUES ($1,'reembolso',$2,$3,$4,$5,'monedero',$6,$7)`,
                [m.id, pago.monto, m.saldo, nuevo, `Reembolso por cancelación (${pedido.numero_orden})`, pedido.id, usuarioId]);
            reembolso_monedero = Number(pago.monto);
        }
        await client.query(`UPDATE pagos SET estado = $1 WHERE id = $2`, [pago.estado === 'aprobado' ? 'reembolsado' : 'cancelado', pago.id]);
    }
    await client.query(`UPDATE pedidos SET estado = 'cancelado' WHERE id = $1`, [pedido.id]);
    return { canjeados, ganados, productos: items.rows.length, reembolso_monedero };
}

// Pedidos con pago pendiente (SPEI, pago en tienda o transferencia del ERP)
// cuyo plazo de pago ya venció: se cancelan solos para liberar el stock
// apartado. Usa la misma rutina que una cancelación manual (stock,
// movimientos, garantías y puntos) y deja nota y bitácora en la orden.
async function cancelarPagosVencidos() {
    const vencidos = await pool.query(
        `SELECT id FROM pedidos WHERE estado = 'pendiente' AND pago_estado = 'pendiente'
           AND pago_vence IS NOT NULL AND pago_vence < CURRENT_TIMESTAMP`);
    let n = 0;
    for (const { id } of vencidos.rows) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const r = await client.query(
                `SELECT * FROM pedidos WHERE id = $1 AND estado = 'pendiente' AND pago_estado = 'pendiente' FOR UPDATE`, [id]);
            if (!r.rows.length) { await client.query('ROLLBACK'); continue; }
            await cancelarPedido(client, r.rows[0]);
            await client.query(
                `UPDATE pedidos SET notas = CONCAT_WS(' · ', NULLIF(notas, ''), 'Cancelado automáticamente: venció el plazo de pago') WHERE id = $1`, [id]);
            await registrarProceso(client, id, 'cancelacion', 'Cancelada automáticamente: venció el plazo de pago y se liberó el stock apartado');
            await client.query('COMMIT');
            n++;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('Pago vencido', id, '->', e.message);
        } finally { client.release(); }
    }
    return n;
}

// Tareas que corren cada minuto: reabasto automático y pagos vencidos.
async function tareasPeriodicas() {
    await procesarReabastoAutomatico().catch((e) => console.error('Reabasto:', e.message));
    await cancelarPagosVencidos().catch((e) => console.error('Pagos vencidos:', e.message));
}

function generarReferenciaPago(tipo) {
    const n = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
    return (tipo === 'spei' ? 'SPEI-' : 'TIENDA-') + n;
}

// =========================================================
// GARANTÍAS EXTENDIDAS
//   El costo es un % del precio del producto. Debe estar en
//   sincronía con public/js/garantia.js (solo para mostrar).
// =========================================================
const PLANES_GARANTIA = [
    { clave: 'none', label: 'Sin garantía extendida', meses: 0,  factor: 0 },
    { clave: 'b12',  label: 'Básica · 12 meses',      meses: 12, factor: 0.06 },
    { clave: 'e24',  label: 'Extendida · 24 meses',   meses: 24, factor: 0.12 },
    { clave: 't36',  label: 'Total · 36 meses',       meses: 36, factor: 0.18 },
];
function planGarantia(clave) {
    return PLANES_GARANTIA.find((p) => p.clave === clave) || PLANES_GARANTIA[0];
}
function costoGarantia(precio, clave) {
    return Math.round(Number(precio || 0) * planGarantia(clave).factor);
}
function planesParaProducto(precio) {
    return PLANES_GARANTIA.map((p) => ({ ...p, costo: Math.round(Number(precio || 0) * p.factor) }));
}
function codigoGarantia() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 16; i++) { if (i && i % 4 === 0) s += '-'; s += abc[Math.floor(Math.random() * abc.length)]; }
    return s; // p.ej. AB3C-9KTP-2MQ7-XY4Z
}

// =========================================================
// PROCESOS DE PAGO (4.1.2)
//   POST /pagos/cotizar   resumen del checkout (sin cobrar)
//   POST /pagos/procesar  confirma la compra del carrito
//   GET  /pagos/{id}      consulta de un pago propio
// Métodos: tarjeta de crédito/débito, PayPal, transferencia bancaria
// (SPEI, queda pendiente hasta que se confirma) y Monedero Kozmok.
// No hay pasarela real: se simula la autorización, pero el flujo es el
// completo y nunca se guarda el número de tarjeta ni el CVV.
// =========================================================
const METODOS_TIENDA = {
    tarjeta:       { texto: 'Tarjeta de crédito / débito', inmediato: true },
    paypal:        { texto: 'PayPal', inmediato: true },
    transferencia: { texto: 'Transferencia bancaria (SPEI)', inmediato: false },
    monedero:      { texto: 'Monedero Kozmok', inmediato: true },
};

// Algoritmo de Luhn: descarta números de tarjeta mal escritos o inventados.
function luhnValido(numero) {
    const d = String(numero).replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) return false;
    let suma = 0;
    for (let i = 0; i < d.length; i++) {
        let n = Number(d[d.length - 1 - i]);
        if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
        suma += n;
    }
    return suma % 10 === 0;
}
const MARCA_TEXTO = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', otra: 'Tarjeta' };
const autorizacion = (pref) => `${pref}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

// Valida los datos del método de pago (sin tocar la base, salvo para leer
// la tarjeta guardada). Devuelve { metodo, detalle, referencia } o un error.
async function validarMetodoPago(db, clienteId, body) {
    const metodo = String(body.metodo || '').toLowerCase();
    if (!METODOS_TIENDA[metodo]) return { error: 'Elige un método de pago: tarjeta, PayPal, transferencia o monedero' };
    if (metodo === 'tarjeta') {
        if (body.metodo_pago_id) {
            const r = await db.query('SELECT * FROM metodos_pago WHERE id = $1 AND cliente_id = $2 AND tipo = $3', [Number(body.metodo_pago_id) || 0, clienteId, 'tarjeta']);
            const t = r.rows[0];
            if (!t) return { error: 'Esa tarjeta no está en tu cuenta' };
            const hoy = new Date();
            if (t.expira_anio < hoy.getFullYear() || (t.expira_anio === hoy.getFullYear() && t.expira_mes < hoy.getMonth() + 1)) return { error: 'Esa tarjeta ya venció; usa otra' };
            return { metodo, detalle: `${MARCA_TEXTO[t.marca] || 'Tarjeta'} ****${t.ultimos4}`, referencia: autorizacion('AUT') };
        }
        const tj = body.tarjeta || {};
        const numero = String(tj.numero || '').replace(/\D/g, '');
        if (!luhnValido(numero)) return { error: 'El número de tarjeta no es válido' };
        if (!seg.nombreValido(tj.titular)) return { error: 'Escribe el nombre del titular como aparece en la tarjeta' };
        const mes = Number(tj.expira_mes), anio = Number(tj.expira_anio), hoy = new Date();
        if (!(mes >= 1 && mes <= 12) || !(anio >= hoy.getFullYear() && anio <= hoy.getFullYear() + 15) || (anio === hoy.getFullYear() && mes < hoy.getMonth() + 1)) {
            return { error: 'La fecha de vencimiento no es válida' };
        }
        if (!/^\d{3,4}$/.test(String(tj.cvv || ''))) return { error: 'El CVV debe tener 3 o 4 dígitos' };
        // Tarjeta de prueba que el "banco" rechaza (para demostrar el flujo).
        if (numero.endsWith('0002')) return { error: 'El banco rechazó el pago (fondos insuficientes). Intenta con otra tarjeta.', rechazo: true };
        return {
            metodo, detalle: `${MARCA_TEXTO[marcaTarjeta(numero)]} ****${numero.slice(-4)}`, referencia: autorizacion('AUT'),
            guardar: tj.guardar ? { marca: marcaTarjeta(numero), ultimos4: numero.slice(-4), titular: String(tj.titular).trim().slice(0, 120), mes, anio } : null,
        };
    }
    if (metodo === 'paypal') {
        const correo = seg.normalizarCorreo(body.paypal_correo);
        if (!seg.correoValido(correo)) return { error: 'Escribe el correo de tu cuenta PayPal' };
        return { metodo, detalle: `PayPal ${correo}`, referencia: autorizacion('PP') };
    }
    if (metodo === 'transferencia') {
        return { metodo, detalle: 'Transferencia SPEI', referencia: 'SPEI-' + String(crypto.randomInt(0, 1e10)).padStart(10, '0') };
    }
    return { metodo, detalle: 'Monedero Kozmok', referencia: autorizacion('MON') };
}

// Puntos del Club que se pueden canjear: múltiplos de 100, sin pasar del subtotal.
function puntosCanjeables(solicitados, saldo, subtotal) {
    let p = Math.max(0, Math.floor(Number(solicitados) || 0));
    p = Math.min(p, Number(saldo) || 0);
    p -= p % 100;
    const maxPorSubtotal = Math.floor(subtotal / VALOR_PUNTO / 100) * 100;
    return Math.min(p, maxPorSubtotal);
}

// Resumen del checkout (lo que se va a cobrar), sin crear nada.
app.post('/api/pagos/cotizar', requireCliente, asyncRoute(async (req, res) => {
    const c = await leerCarrito(pool, req.cliente.id);
    const cli = await pool.query('SELECT puntos FROM clientes WHERE id = $1', [req.cliente.id]);
    const puntos = puntosCanjeables(req.body.puntos_canjear, cli.rows[0].puntos, c.resumen.subtotal);
    const resumen = calcularResumen({ lineas: c.items, impuestos: await impuestosActivos(), descuentoPuntos: round2(puntos * VALOR_PUNTO) });
    const m = await monederoDe(pool, req.cliente.id);
    res.json({
        items: c.items, resumen, puntos_canjear: puntos, puntos_disponibles: cli.rows[0].puntos, valor_punto: VALOR_PUNTO,
        monedero: { saldo: Number(m.saldo), estado: m.estado, alcanza: m.estado === 'activo' && Number(m.saldo) >= resumen.total, saldo_despues: round2(Number(m.saldo) - resumen.total) },
        metodos: Object.entries(METODOS_TIENDA).map(([clave, v]) => ({ clave, ...v })),
    });
}));

// POST /pagos/procesar: todo en UNA transacción (si algo falla no se
// guarda nada): validar stock → generar pedido → registrar pago →
// actualizar inventario → monedero / puntos / CRM → estado de la compra.
const procesarPago = asyncRoute(async (req, res) => {
    const clienteId = req.cliente.id;
    const b = req.body || {};
    // Compatibilidad con el checkout anterior (metodo_tipo = tarjeta / spei).
    if (!b.metodo && b.metodo_tipo) b.metodo = b.metodo_tipo === 'spei' || b.metodo_tipo === 'tienda' ? 'transferencia' : b.metodo_tipo;
    const direccion = String(b.direccion_envio || '').trim();
    if (direccion.length < 8 || direccion.length > 200) return res.status(400).json({ message: 'Escribe la dirección de entrega completa (calle, número, colonia y ciudad)' });
    const nombreEntrega = String(b.nombre_entrega || req.cliente.nombre).trim().slice(0, 150);
    const notas = b.notas ? String(b.notas).slice(0, 300) : null;

    const mp = await validarMetodoPago(pool, clienteId, b);
    if (mp.error) {
        if (mp.rechazo) await seg.registrarEvento(req, { tipo: 'pago_rechazado', severidad: 'baja', cliente_id: clienteId, detalle: mp.error });
        return res.status(mp.rechazo ? 402 : 400).json({ message: mp.error });
    }
    const M = METODOS_TIENDA[mp.metodo];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // 1) Carrito y stock con bloqueo de fila: dos compras simultáneas no
        //    pueden vender la misma pieza ni pagar dos veces el mismo carrito.
        const cart = await leerCarrito(client, clienteId, { bloquear: true });
        if (!cart.carrito || cart.items.length === 0) throw Object.assign(new Error('Tu carrito está vacío'), { status: 400 });
        for (const it of cart.items) {
            if (!it.activo) throw Object.assign(new Error(`"${it.nombre}" ya no está a la venta; quítalo del carrito`), { status: 409 });
            if (it.stock < it.cantidad) throw Object.assign(new Error(`Stock insuficiente para "${it.nombre}" (disponible: ${it.stock})`), { status: 409 });
        }
        const cli = await client.query('SELECT id, nombre, correo, puntos FROM clientes WHERE id = $1 FOR UPDATE', [clienteId]);
        const puntos = puntosCanjeables(b.puntos_canjear, cli.rows[0].puntos, cart.resumen.subtotal);
        const impuestos = await impuestosActivos(client);
        const R = calcularResumen({ lineas: cart.items, impuestos, descuentoPuntos: round2(puntos * VALOR_PUNTO) });

        // 2) Monedero: debe alcanzar el saldo.
        let monedero = null;
        if (mp.metodo === 'monedero') {
            monedero = await monederoDe(client, clienteId, { bloquear: true });
            if (monedero.estado !== 'activo') throw Object.assign(new Error('Tu monedero está bloqueado; contacta a atención a clientes'), { status: 400 });
            if (Number(monedero.saldo) < R.total) {
                throw Object.assign(new Error(`Saldo insuficiente en tu monedero: tienes ${Number(monedero.saldo).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} y el total es ${R.total.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`), { status: 402 });
            }
        }

        // 3) Generar el pedido.
        const numero_orden = 'ORD-' + Date.now().toString().slice(-8) + crypto.randomInt(10, 99);
        const pedido = (await client.query(
            `INSERT INTO pedidos (numero_orden, cliente_id, carrito_id, origen, subtotal, impuestos, impuestos_detalle, envio, descuento,
                                  descuento_promociones, total, estado, metodo_pago, pago_estado, pago_referencia, pago_vence,
                                  direccion_envio, notas, fecha_confirmacion)
             VALUES ($1,$2,$3,'en_linea',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
            [numero_orden, clienteId, cart.carrito.id, R.subtotal, R.impuestos, JSON.stringify(R.impuestos_detalle), R.envio, R.descuento_puntos,
                R.ahorro_promociones, R.total, M.inmediato ? 'confirmado' : 'pendiente', ({ tarjeta: `Tarjeta ${mp.detalle}`, paypal: mp.detalle, transferencia: 'Transferencia SPEI', monedero: 'Monedero Kozmok' })[mp.metodo].slice(0, 60),
                M.inmediato ? 'pagado' : 'pendiente', M.inmediato ? null : mp.referencia,
                M.inmediato ? null : new Date(Date.now() + 3 * 86400000), `${nombreEntrega} · ${direccion}`.slice(0, 200), notas,
                M.inmediato ? new Date() : null]
        )).rows[0];

        // 4) Partidas, garantías e inventario (salida + reabasto automático).
        for (const it of cart.items) {
            const pi = await client.query(
                `INSERT INTO pedido_detalle (pedido_id, producto_id, cantidad, precio_unitario, precio_lista, promocion_id, subtotal, garantia_plan, garantia_meses, garantia_costo)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
                [pedido.id, it.producto_id, it.cantidad, it.precio, it.promocion ? it.precio_lista : null, it.promocion ? it.promocion.id : null,
                    it.subtotal, it.garantia_meses ? it.garantia_plan : null, it.garantia_meses || 0, it.garantia_costo]);
            if (it.garantia_meses > 0) {
                const vence = new Date();
                vence.setMonth(vence.getMonth() + it.garantia_meses);
                const g = await client.query(
                    `INSERT INTO garantias (folio, codigo, pedido_id, pedido_item_id, cliente_id, producto_id, plan, meses, costo, inicio, vence)
                     VALUES ('GAR-TMP', $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE, $9) RETURNING id`,
                    [codigoGarantia(), pedido.id, pi.rows[0].id, clienteId, it.producto_id, it.garantia_plan, it.garantia_meses, it.garantia_costo, vence.toISOString().slice(0, 10)]);
                await client.query(`UPDATE garantias SET folio = 'GAR-' || (100000 + id) WHERE id = $1`, [g.rows[0].id]);
            }
            await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [it.cantidad, it.producto_id]);
            await client.query(
                `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo) VALUES ($1,'salida',$2,$3)`,
                [it.producto_id, it.cantidad, `Venta en línea ${numero_orden}`]);
        }
        const antesOC = await client.query('SELECT COALESCE(MAX(id), 0) AS max FROM ordenes_compra');
        for (const it of cart.items) await generarOrdenAutomaticaSiCritico(client, it.producto_id, 'demanda');
        const nuevasOC = (await client.query('SELECT folio FROM ordenes_compra WHERE id > $1 ORDER BY id', [antesOC.rows[0].max])).rows.map((r) => r.folio);

        // 5) Registrar el pago (un pedido tiene un pago).
        const pago = (await client.query(
            `INSERT INTO pagos (pedido_id, monto, metodo_pago, detalle, referencia, estado, fecha_confirmacion)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [pedido.id, R.total, mp.metodo, mp.detalle, mp.referencia, M.inmediato ? 'aprobado' : 'pendiente', M.inmediato ? new Date() : null])).rows[0];

        // 6) Monedero: se descuenta el saldo y queda el movimiento.
        let saldo_monedero = null;
        if (monedero) {
            saldo_monedero = round2(Number(monedero.saldo) - R.total);
            await client.query('UPDATE monederos SET saldo = $1 WHERE id = $2', [saldo_monedero, monedero.id]);
            await client.query(
                `INSERT INTO movimientos_monedero (monedero_id, tipo, monto, saldo_anterior, saldo_nuevo, concepto, metodo_pago, referencia, pedido_id)
                 VALUES ($1,'compra',$2,$3,$4,$5,'monedero',$6,$7)`,
                [monedero.id, -R.total, monedero.saldo, saldo_monedero, `Compra (${numero_orden})`, mp.referencia, pedido.id]);
        }
        if (mp.guardar) {
            const n = await client.query('SELECT COUNT(*)::int AS n FROM metodos_pago WHERE cliente_id = $1', [clienteId]);
            await client.query(
                `INSERT INTO metodos_pago (cliente_id, tipo, marca, ultimos4, titular, expira_mes, expira_anio, predeterminada) VALUES ($1,'tarjeta',$2,$3,$4,$5,$6,$7)`,
                [clienteId, mp.guardar.marca, mp.guardar.ultimos4, mp.guardar.titular, mp.guardar.mes, mp.guardar.anio, n.rows[0].n === 0]);
        }

        // 7) Puntos del Club y CRM (métricas + etapa) si ya se cobró.
        if (puntos > 0) {
            await client.query('UPDATE clientes SET puntos = puntos - $1 WHERE id = $2', [puntos, clienteId]);
            await client.query(`INSERT INTO movimientos_puntos (cliente_id, tipo, puntos, motivo, pedido_id) VALUES ($1,'canjeado',$2,$3,$4)`,
                [clienteId, -puntos, `Descuento en ${numero_orden}`, pedido.id]);
        }
        const puntos_ganados = M.inmediato ? await aplicarCobroPedido(client, pedido) : 0;

        // 8) El carrito pasa a "convertido" (ya no se puede volver a pagar).
        await client.query(`UPDATE carrito SET estado = 'convertido' WHERE id = $1`, [cart.carrito.id]);

        // Bitácora del ERP: la compra en línea también es una orden integrada.
        const pasos = [
            ['orden', `Orden ${numero_orden} creada desde la tienda en línea`],
            ['stock', `Stock validado (${cart.items.length} producto${cart.items.length === 1 ? '' : 's'}, ${R.piezas} pieza${R.piezas === 1 ? '' : 's'})`],
            ['inventario', `Inventario actualizado y ${cart.items.length} movimiento(s) de salida registrados (SCM)`],
            ...(nuevasOC.length ? [['reabasto', `Orden de compra automática: ${nuevasOC.join(', ')}`]] : []),
            ['pago', M.inmediato ? `Pago ${mp.metodo} aprobado (${mp.detalle}, ${mp.referencia})` : `Pago por transferencia pendiente (referencia ${mp.referencia})`],
            ...(monedero ? [['monedero', `Monedero actualizado: saldo ${monedero.saldo} → ${saldo_monedero}`]] : []),
            ['historial', M.inmediato ? `Compra asociada al cliente (CRM)${puntos_ganados ? `, +${puntos_ganados} puntos` : ''}` : 'Compra asociada al cliente (CRM); puntos al confirmar el pago'],
        ];
        for (const [paso, texto] of pasos) await registrarProceso(client, pedido.id, paso, texto);

        // 9) Correo de confirmación.
        const lineas = cart.items.map((i) => `  - ${i.nombre} × ${i.cantidad}: $${i.subtotal.toLocaleString('es-MX')}`).join('\n');
        await enviarCorreo(client, {
            para: cli.rows[0].correo, tipo: 'compra', cliente_id: clienteId, pedido_id: pedido.id,
            asunto: `Confirmación de tu compra ${numero_orden}`,
            cuerpo: `Hola ${cli.rows[0].nombre}:\n\n${M.inmediato ? '¡Gracias por tu compra! Recibimos tu pago.' : 'Registramos tu pedido. Realiza la transferencia SPEI con la referencia ' + mp.referencia + ' en los próximos 3 días.'}\n\nOrden: ${numero_orden}\n${lineas}\n\nSubtotal: $${R.subtotal}\n${R.impuestos_detalle.map((i) => `${i.nombre} (${i.porcentaje}%): $${i.monto}`).join('\n')}\nEnvío: ${R.envio ? '$' + R.envio : 'Gratis'}\n${R.descuento_puntos ? `Descuento por puntos: -$${R.descuento_puntos}\n` : ''}Total: $${R.total}\nPago: ${M.texto} (${mp.detalle})${saldo_monedero !== null ? `\nSaldo de tu monedero: $${saldo_monedero}` : ''}\nEnvío a: ${direccion}`,
        });
        await client.query('COMMIT');

        res.status(201).json({
            ...pedido, id: pedido.id,
            pedido: { id: pedido.id, numero_orden, estado: pedido.estado, total: R.total },
            pago: { id: pago.id, metodo_pago: pago.metodo_pago, detalle: pago.detalle, referencia: pago.referencia, estado: pago.estado, monto: Number(pago.monto) },
            resumen: R, monedero: saldo_monedero !== null ? { saldo: saldo_monedero } : null,
            puntos_ganados, puntos_canjeados: puntos, ordenes_compra: nuevasOC, correo: cli.rows[0].correo,
        });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.status) return res.status(error.status).json({ message: error.message });
        throw error;
    } finally {
        client.release();
    }
});
app.post('/api/pagos/procesar', requireCliente, limiteDinero, procesarPago);
app.post('/api/pedidos', requireCliente, limiteDinero, procesarPago);

app.get('/api/pagos/:id', requireCliente, asyncRoute(async (req, res) => {
    const r = await pool.query(`
        SELECT pg.*, p.numero_orden, p.estado AS pedido_estado, p.total AS pedido_total, p.fecha_pedido, p.pago_vence
        FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id
        WHERE pg.id = $1 AND p.cliente_id = $2`, [req.params.id, req.cliente.id]);
    if (!r.rows[0]) return res.status(404).json({ message: 'Pago no encontrado' });
    res.json({ ...r.rows[0], monto: Number(r.rows[0].monto) });
}));

app.get('/api/pedidos/cliente/:clienteId', requireCliente, asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT p.*, STRING_AGG(pr.nombre, ', ') AS productos
         FROM pedidos p LEFT JOIN pedido_detalle pi ON p.id = pi.pedido_id
         LEFT JOIN productos pr ON pi.producto_id = pr.id
         WHERE p.cliente_id = $1 GROUP BY p.id ORDER BY p.fecha_pedido DESC`,
        [req.cliente.id]
    );
    res.json(result.rows);
}));

// Detalle de un pedido propio (antes era público: cualquiera podía ver
// cualquier pedido cambiando el número en la URL).
app.get('/api/pedidos/:id/detalle', requireCliente, asyncRoute(async (req, res) => {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1 AND cliente_id = $2', [req.params.id, req.cliente.id]);
    if (pedido.rows.length === 0) {
        const existe = await pool.query('SELECT 1 FROM pedidos WHERE id = $1', [req.params.id]);
        if (existe.rows.length) seg.registrarEvento(req, { tipo: 'acceso_ajeno', severidad: 'media', cliente_id: req.cliente.id, detalle: `Intentó ver el pedido #${req.params.id}, que no es suyo` });
        return res.status(404).json({ message: 'Pedido no encontrado' });
    }
    const items = await pool.query(
        `SELECT pi.*, p.nombre, p.imagen_url FROM pedido_detalle pi JOIN productos p ON pi.producto_id = p.id WHERE pi.pedido_id = $1`,
        [req.params.id]
    );
    const garantias = await pool.query(
        `SELECT g.folio, g.codigo, g.plan, g.meses, g.costo, g.inicio, g.vence, g.estado, pr.nombre AS producto
         FROM garantias g LEFT JOIN productos pr ON pr.id = g.producto_id
         WHERE g.pedido_id = $1 ORDER BY g.id`,
        [req.params.id]
    );
    const pago = await pool.query('SELECT id, monto, metodo_pago, detalle, referencia, estado, fecha, fecha_confirmacion FROM pagos WHERE pedido_id = $1', [req.params.id]);
    const mov = await pool.query(
        `SELECT mm.saldo_nuevo FROM movimientos_monedero mm WHERE mm.pedido_id = $1 AND mm.tipo = 'compra' ORDER BY mm.id DESC LIMIT 1`, [req.params.id]);
    const m = await monederoDe(pool, req.cliente.id);
    res.json({
        ...pedido.rows[0], items: items.rows, garantias: garantias.rows, pago: pago.rows[0] || null,
        monedero: mov.rows[0] ? { saldo_despues_compra: Number(mov.rows[0].saldo_nuevo), saldo_actual: Number(m.saldo) } : null,
        correo: req.cliente.correo,
    });
}));

// Recibo / comprobante de un pedido. Lo puede ver el cliente dueño o
// cualquier usuario interno (administrador, ventas o logística).
app.get('/api/pedidos/:id/recibo', asyncRoute(async (req, res) => {
    let quien = null;
    const sc = await seg.leerSesion(req, 'cliente');
    if (sc) quien = { tipo: 'cliente', id: Number(sc.cliente_id) };
    else {
        const su = await seg.leerSesion(req, 'usuario');
        if (su) {
            const u = await pool.query('SELECT id, activo FROM usuarios WHERE id = $1', [su.usuario_id]);
            if (u.rows[0] && u.rows[0].activo) quien = { tipo: 'usuario', id: Number(su.usuario_id) };
        }
    }
    if (!quien) return res.status(401).json({ message: 'Inicia sesión para ver el comprobante' });

    const pr = await pool.query(
        `SELECT p.*, COALESCE(c.nombre, 'Cliente eliminado') AS cliente_nombre, c.correo AS cliente_correo
         FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id WHERE p.id = $1`,
        [req.params.id]
    );
    if (pr.rows.length === 0) return res.status(404).json({ message: 'Pedido no encontrado' });
    const pedido = pr.rows[0];
    if (quien.tipo === 'cliente' && quien.id !== Number(pedido.cliente_id)) {
        seg.registrarEvento(req, { tipo: 'acceso_ajeno', severidad: 'media', cliente_id: quien.id, detalle: `Intentó ver el comprobante del pedido #${pedido.id}` });
        return res.status(403).json({ message: 'Este comprobante no es de tu cuenta' });
    }
    const pagoRecibo = (await pool.query('SELECT metodo_pago, detalle, referencia, estado, fecha_confirmacion FROM pagos WHERE pedido_id = $1', [pedido.id])).rows[0] || null;

    const items = await pool.query(
        `SELECT pi.cantidad, pi.precio_unitario, pi.subtotal, pi.garantia_plan, pi.garantia_meses, pi.garantia_costo, p.nombre
         FROM pedido_detalle pi JOIN productos p ON p.id = pi.producto_id
         WHERE pi.pedido_id = $1 ORDER BY pi.id`,
        [req.params.id]
    );
    const garantias = await pool.query(
        `SELECT g.folio, g.codigo, g.plan, g.meses, g.costo, g.inicio, g.vence, g.estado, pr.nombre AS producto
         FROM garantias g LEFT JOIN productos pr ON pr.id = g.producto_id
         WHERE g.pedido_id = $1 ORDER BY g.id`,
        [req.params.id]
    );
    const pts = await pool.query(
        `SELECT tipo, puntos, motivo FROM movimientos_puntos WHERE pedido_id = $1 ORDER BY id`,
        [req.params.id]
    );
    const ganados = pts.rows.filter((r) => r.tipo === 'ganado').reduce((a, r) => a + r.puntos, 0);
    const canjeados = -pts.rows.filter((r) => r.tipo === 'canjeado').reduce((a, r) => a + r.puntos, 0);

    res.json({
        ...pedido,
        items: items.rows,
        garantias: garantias.rows,
        puntos_ganados: ganados,
        puntos_canjeados: canjeados,
        pago: pagoRecibo,
        emisor: {
            nombre: 'Kozmok S.A. de C.V.',
            rfc: 'KOZ250101XY9',
            domicilio: 'Av. Tecnológico 1200, Col. Centro, Aguascalientes, Ags.',
            banco: 'STP',
            clabe: '646180' + String(1000000000 + Number(pedido.id) * 131).slice(0, 12),
            beneficiario: 'Kozmok S.A. de C.V.',
        },
    });
}));

// =========================================================
// PERFIL DE CLIENTE (tienda) — cada quien solo ve/edita lo suyo
// =========================================================
app.use('/api/clientes/:id', requireCliente, mismoCliente);

app.get('/api/clientes/:id', asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT id, nombre, correo, telefono, empresa, direccion, ciudad, estado, codigo_postal,
                etapa_crm, preferencias, puntos, codigo_socio, fecha_registro
         FROM clientes WHERE id = $1`,
        [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });

    const cliente = result.rows[0];
    // Backfill: cuentas creadas antes de existir el código de socio.
    if (!cliente.codigo_socio) {
        for (let i = 0; i < 5; i++) {
            const cs = generarCodigoSocio();
            try {
                await pool.query('UPDATE clientes SET codigo_socio = $1 WHERE id = $2', [cs, cliente.id]);
                cliente.codigo_socio = cs;
                break;
            } catch (e) { /* choque de único: reintenta */ }
        }
    }
    res.json(cliente);
}));

// Estado del Club (puntos, nivel, progreso, historial)
app.get('/api/clientes/:id/recompensas', asyncRoute(async (req, res) => {
    const estado = await estadoRecompensas(req.params.id);
    if (!estado) return res.status(404).json({ message: 'Cliente no encontrado' });
    const mov = await pool.query(
        `SELECT tipo, puntos, motivo, fecha FROM movimientos_puntos
         WHERE cliente_id = $1 ORDER BY fecha DESC LIMIT 50`,
        [req.params.id]
    );
    res.json({ ...estado, movimientos: mov.rows });
}));

app.put('/api/clientes/:id', asyncRoute(async (req, res) => {
    const { nombre, telefono, empresa, direccion, ciudad, estado, codigo_postal } = req.body;
    if (nombre !== undefined && !seg.nombreValido(nombre)) return res.status(400).json({ message: 'Escribe tu nombre solo con letras (2 a 150 caracteres)' });
    if (!seg.telefonoValido(telefono)) return res.status(400).json({ message: 'El teléfono no es válido' });
    if (codigo_postal && !/^\d{4,6}$/.test(String(codigo_postal))) return res.status(400).json({ message: 'El código postal debe tener 5 dígitos' });
    const result = await pool.query(
        `UPDATE clientes SET
            nombre        = COALESCE($1, nombre),
            telefono      = COALESCE($2, telefono),
            empresa       = COALESCE($3, empresa),
            direccion     = COALESCE($4, direccion),
            ciudad        = COALESCE($5, ciudad),
            estado        = COALESCE($6, estado),
            codigo_postal = COALESCE($7, codigo_postal)
         WHERE id = $8
         RETURNING id, nombre, correo, telefono, empresa, direccion, ciudad, estado, codigo_postal, etapa_crm`,
        [nombre, telefono, empresa, direccion, ciudad, estado, codigo_postal, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json({ message: 'Datos actualizados', cliente: result.rows[0] });
}));

// Cambiar contraseña (verifica la actual). Con la nueva contraseña se
// cierran las demás sesiones abiertas: si alguien había robado una, deja
// de servir.
app.put('/api/clientes/:id/password', limiteAuth, asyncRoute(async (req, res) => {
    const actual = String(req.body.actual || '');
    const nueva = String(req.body.nueva || '');
    if (!actual || !nueva) return res.status(400).json({ message: 'Contraseña actual y nueva son requeridas' });
    const result = await pool.query('SELECT password, correo, nombre FROM clientes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });
    const c = result.rows[0];
    const err = seg.validarPassword(nueva, { correo: c.correo, nombre: c.nombre });
    if (err) return res.status(400).json({ message: err });

    const valido = await seg.compararPassword(actual, c.password);
    if (!valido) {
        const r = await seg.registrarFallo(req, { ambito: 'cliente', correo: c.correo });
        return res.status(r.bloqueo ? 429 : 401).json({ message: r.bloqueo ? 'Demasiados intentos: la cuenta quedó bloqueada unos minutos.' : 'La contraseña actual no es correcta' });
    }
    if (await seg.compararPassword(nueva, c.password)) return res.status(400).json({ message: 'La nueva contraseña debe ser distinta de la actual' });

    await pool.query('UPDATE clientes SET password = $1 WHERE id = $2', [await seg.hashPassword(nueva), req.params.id]);
    const cerradas = await seg.revocarSesionesDe('cliente', req.cliente.id, 'cambio de contraseña', req.sesion.id);
    await seg.registrarEvento(req, { tipo: 'cambio_password', severidad: 'baja', cliente_id: req.cliente.id, detalle: `Cambio de contraseña; ${cerradas} sesión(es) cerradas` });
    await enviarCorreo(pool, { para: c.correo, tipo: 'seguridad', cliente_id: req.cliente.id, asunto: 'Tu contraseña cambió',
        cuerpo: `Hola ${c.nombre}:\n\nTu contraseña de Kozmok se cambió y cerramos tus otras sesiones. Si no fuiste tú, recupera tu cuenta de inmediato.` });
    res.json({ message: cerradas ? `Contraseña actualizada. Cerramos ${cerradas} sesión(es) en otros dispositivos.` : 'Contraseña actualizada' });
}));

// Preferencias de la cuenta (notificaciones, boletín, etc.)
app.put('/api/clientes/:id/preferencias', asyncRoute(async (req, res) => {
    const prefs = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await pool.query(
        `UPDATE clientes SET preferencias = $1::jsonb WHERE id = $2 RETURNING preferencias`,
        [JSON.stringify(prefs), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json({ message: 'Preferencias guardadas', preferencias: result.rows[0].preferencias });
}));

// =========================================================
// ATENCIÓN A CLIENTES (4.1.6) — TicketAtencion, conectado al CRM
//   POST /atencion/ticket                (cliente)
//   GET  /atencion/tickets               (cliente: los suyos)
//   GET  /atencion/ticket/{id}           (cliente: con su hilo)
//   POST /atencion/ticket/{id}/mensaje   (cliente: seguir la conversación)
//   PUT  /atencion/ticket/{id}/respuesta (equipo con permiso de soporte)
// Cada ticket y cada respuesta quedan como interacción "soporte" en el
// historial del cliente (CRM).
// =========================================================
const ASUNTOS_TICKET = {
    pedido: 'Duda sobre mi pedido', devolucion: 'Cambio de producto', facturacion: 'Facturación',
    garantia: 'Garantía', pago: 'Pagos y monedero', cuenta: 'Mi cuenta', general: 'Otro',
};

app.post('/api/atencion/ticket', requireCliente, limiteDinero, asyncRoute(async (req, res) => {
    const categoria = ASUNTOS_TICKET[req.body.categoria] ? req.body.categoria : 'general';
    const asunto = String(req.body.asunto || ASUNTOS_TICKET[categoria]).trim().slice(0, 160);
    const mensaje = String(req.body.mensaje || req.body.descripcion || '').trim();
    if (mensaje.length < 5) return res.status(400).json({ message: 'Escribe tu consulta (al menos 5 caracteres)' });
    if (mensaje.length > 4000) return res.status(400).json({ message: 'El mensaje es demasiado largo (máximo 4000 caracteres)' });
    const prioridad = ['baja', 'media', 'alta'].includes(req.body.prioridad) ? req.body.prioridad : 'media';
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const ins = await db.query(
            `INSERT INTO tickets_atencion (folio, cliente_id, asunto, mensaje, categoria, prioridad, pedido_id)
             VALUES ('TMP-' || substr(gen_random_uuid()::text, 1, 12), $1, $2, $3, $4, $5,
                     (SELECT id FROM pedidos WHERE id = $6 AND cliente_id = $1)) RETURNING id`,
            [req.cliente.id, asunto, mensaje, categoria, prioridad, Number(req.body.pedido_id) || null]);
        const t = (await db.query(`UPDATE tickets_atencion SET folio = 'TK-' || (1000 + id) WHERE id = $1 RETURNING *`, [ins.rows[0].id])).rows[0];
        await db.query(`INSERT INTO ticket_mensajes (ticket_id, autor, mensaje) VALUES ($1, 'cliente', $2)`, [t.id, mensaje]);
        await db.query(`INSERT INTO interacciones (cliente_id, tipo, descripcion) VALUES ($1, 'soporte', $2)`,
            [req.cliente.id, `Ticket ${t.folio}: ${asunto}`]);
        await enviarCorreo(db, { para: req.cliente.correo, tipo: 'ticket', cliente_id: req.cliente.id,
            asunto: `Recibimos tu solicitud ${t.folio}`,
            cuerpo: `Hola ${req.cliente.nombre}:\n\nRegistramos tu ticket ${t.folio} (“${asunto}”). Te responderemos en menos de 24 horas.\n\nTu mensaje:\n${mensaje}` });
        await db.query('COMMIT');
        res.status(201).json({ message: `Ticket ${t.folio} enviado`, ticket: t });
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}));

app.get('/api/atencion/tickets', requireCliente, asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT t.id, t.folio, t.asunto, t.categoria, t.estado, t.prioridad, t.fecha_creacion, t.fecha_actualizacion,
                t.fecha_respuesta, (t.respuesta IS NOT NULL) AS tiene_respuesta,
                (SELECT COUNT(*)::int FROM ticket_mensajes m WHERE m.ticket_id = t.id) AS mensajes
         FROM tickets_atencion t WHERE t.cliente_id = $1 ORDER BY t.fecha_actualizacion DESC`, [req.cliente.id]);
    res.json({ tickets: r.rows, asuntos: ASUNTOS_TICKET });
}));

app.get('/api/atencion/ticket/:id', requireCliente, asyncRoute(async (req, res) => {
    const t = await pool.query('SELECT * FROM tickets_atencion WHERE id = $1 AND cliente_id = $2', [req.params.id, req.cliente.id]);
    if (!t.rows[0]) return res.status(404).json({ message: 'Ticket no encontrado' });
    const msgs = await pool.query(
        `SELECT m.id, m.autor, m.mensaje, m.fecha, u.nombre AS usuario_nombre FROM ticket_mensajes m
         LEFT JOIN usuarios u ON u.id = m.usuario_id WHERE m.ticket_id = $1 ORDER BY m.fecha, m.id`, [req.params.id]);
    res.json({ ...t.rows[0], mensajes: msgs.rows });
}));

app.post('/api/atencion/ticket/:id/mensaje', requireCliente, asyncRoute(async (req, res) => {
    const mensaje = String(req.body.mensaje || '').trim();
    if (!mensaje || mensaje.length > 4000) return res.status(400).json({ message: 'Escribe tu mensaje (máximo 4000 caracteres)' });
    const t = await pool.query('SELECT id, estado FROM tickets_atencion WHERE id = $1 AND cliente_id = $2', [req.params.id, req.cliente.id]);
    if (!t.rows[0]) return res.status(404).json({ message: 'Ticket no encontrado' });
    await pool.query(`INSERT INTO ticket_mensajes (ticket_id, autor, mensaje) VALUES ($1, 'cliente', $2)`, [req.params.id, mensaje]);
    const nuevo = ['resuelto', 'cerrado'].includes(t.rows[0].estado) ? 'abierto' : t.rows[0].estado === 'respondido' ? 'en_proceso' : t.rows[0].estado;
    await pool.query('UPDATE tickets_atencion SET estado = $1 WHERE id = $2', [nuevo, req.params.id]);
    res.status(201).json({ message: 'Mensaje enviado' });
}));

// Respuesta del equipo: queda en el ticket (respuesta + hilo), en el CRM
// como interacción de quien respondió y se avisa al cliente por correo.
async function responderTicket(req, res) {
    const respuesta = String(req.body.respuesta || req.body.mensaje || '').trim();
    if (!respuesta) return res.status(400).json({ message: 'Escribe la respuesta' });
    if (respuesta.length > 4000) return res.status(400).json({ message: 'La respuesta es demasiado larga' });
    const estado = ['respondido', 'en_proceso', 'resuelto', 'cerrado'].includes(req.body.estado) ? req.body.estado : 'respondido';
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const t = await db.query(
            `SELECT t.*, c.correo, c.nombre AS cliente_nombre FROM tickets_atencion t JOIN clientes c ON c.id = t.cliente_id WHERE t.id = $1 FOR UPDATE OF t`, [req.params.id]);
        if (!t.rows[0]) { await db.query('ROLLBACK'); return res.status(404).json({ message: 'Ticket no encontrado' }); }
        const tk = t.rows[0];
        await db.query(`INSERT INTO ticket_mensajes (ticket_id, autor, usuario_id, mensaje) VALUES ($1, 'equipo', $2, $3)`, [tk.id, req.usuario.id, respuesta]);
        const r = await db.query(
            `UPDATE tickets_atencion SET respuesta = $1, fecha_respuesta = CURRENT_TIMESTAMP, respondido_por = $2, estado = $3,
                    asignado_a = COALESCE(asignado_a, $2) WHERE id = $4 RETURNING *`,
            [respuesta, req.usuario.id, estado, tk.id]);
        await db.query(`INSERT INTO interacciones (cliente_id, usuario_id, tipo, descripcion) VALUES ($1, $2, 'soporte', $3)`,
            [tk.cliente_id, req.usuario.id, `Respuesta al ticket ${tk.folio}: ${respuesta.slice(0, 200)}`]);
        await enviarCorreo(db, { para: tk.correo, tipo: 'ticket', cliente_id: tk.cliente_id,
            asunto: `Respuesta a tu ticket ${tk.folio}`,
            cuerpo: `Hola ${tk.cliente_nombre}:\n\n${respuesta}\n\n— ${req.usuario.nombre}, equipo Kozmok\nPuedes contestar desde Mi cuenta → Atención a clientes.` });
        await db.query('COMMIT');
        res.json({ message: 'Respuesta enviada al cliente', ticket: r.rows[0] });
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
app.put('/api/atencion/ticket/:id/respuesta', requireUsuario, requirePermiso('soporte'), asyncRoute(responderTicket));

// =========================================================
// MONEDERO ELECTRÓNICO (cliente)
//   GET  /monedero                saldo y movimientos
//   POST /monedero/recargar       recarga con tarjeta, PayPal o transferencia
// =========================================================
const RECARGA_MIN = 50, RECARGA_MAX = 10000, SALDO_MAX = 50000;

app.get('/api/monedero', requireCliente, asyncRoute(async (req, res) => {
    const m = await monederoDe(pool, req.cliente.id);
    const mov = await pool.query(
        `SELECT mm.id, mm.tipo, mm.monto, mm.saldo_anterior, mm.saldo_nuevo, mm.concepto, mm.metodo_pago, mm.referencia,
                mm.estado, mm.fecha, mm.pedido_id, p.numero_orden
         FROM movimientos_monedero mm LEFT JOIN pedidos p ON p.id = mm.pedido_id
         WHERE mm.monedero_id = $1 ORDER BY mm.fecha DESC, mm.id DESC LIMIT 100`, [m.id]);
    const n = (v) => (v == null ? null : Number(v));
    res.json({
        saldo: Number(m.saldo), estado: m.estado, saldo_maximo: SALDO_MAX, recarga_min: RECARGA_MIN, recarga_max: RECARGA_MAX,
        movimientos: mov.rows.map((x) => ({ ...x, monto: n(x.monto), saldo_anterior: n(x.saldo_anterior), saldo_nuevo: n(x.saldo_nuevo) })),
        pendientes: mov.rows.filter((x) => x.estado === 'pendiente').reduce((a, x) => a + Number(x.monto), 0),
    });
}));

app.post('/api/monedero/recargar', requireCliente, limiteDinero, asyncRoute(async (req, res) => {
    const monto = round2(req.body.monto);
    if (!Number.isFinite(monto) || monto < RECARGA_MIN || monto > RECARGA_MAX) {
        return res.status(400).json({ message: `El monto de recarga debe estar entre $${RECARGA_MIN} y $${RECARGA_MAX.toLocaleString('es-MX')}` });
    }
    const mp = await validarMetodoPago(pool, req.cliente.id, { ...req.body, metodo: req.body.metodo });
    if (mp.error) return res.status(mp.rechazo ? 402 : 400).json({ message: mp.error });
    if (mp.metodo === 'monedero') return res.status(400).json({ message: 'Elige tarjeta, PayPal o transferencia para recargar' });
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const m = await monederoDe(db, req.cliente.id, { bloquear: true });
        if (m.estado !== 'activo') throw Object.assign(new Error('Tu monedero está bloqueado; contacta a atención a clientes'), { status: 400 });
        if (Number(m.saldo) + monto > SALDO_MAX) throw Object.assign(new Error(`El saldo máximo del monedero es $${SALDO_MAX.toLocaleString('es-MX')}`), { status: 400 });
        const concepto = mp.metodo === 'tarjeta' ? `Recarga con tarjeta ${mp.detalle}` : mp.metodo === 'paypal' ? 'Recarga con PayPal' : 'Recarga por transferencia (por confirmar)';
        let saldo = Number(m.saldo);
        if (mp.metodo === 'transferencia') {
            await db.query(
                `INSERT INTO movimientos_monedero (monedero_id, tipo, monto, concepto, metodo_pago, referencia, estado) VALUES ($1,'recarga',$2,$3,$4,$5,'pendiente')`,
                [m.id, monto, concepto, mp.metodo, mp.referencia]);
        } else {
            saldo = round2(saldo + monto);
            await db.query('UPDATE monederos SET saldo = $1 WHERE id = $2', [saldo, m.id]);
            await db.query(
                `INSERT INTO movimientos_monedero (monedero_id, tipo, monto, saldo_anterior, saldo_nuevo, concepto, metodo_pago, referencia)
                 VALUES ($1,'recarga',$2,$3,$4,$5,$6,$7)`, [m.id, monto, m.saldo, saldo, concepto, mp.metodo, mp.referencia]);
        }
        await enviarCorreo(db, { para: req.cliente.correo, tipo: 'monedero', cliente_id: req.cliente.id,
            asunto: mp.metodo === 'transferencia' ? 'Recarga de monedero pendiente' : 'Recarga de monedero aplicada',
            cuerpo: mp.metodo === 'transferencia'
                ? `Hola ${req.cliente.nombre}:\n\nTransfiere $${monto} con la referencia ${mp.referencia}. En cuanto confirmemos el depósito se suma a tu monedero.`
                : `Hola ${req.cliente.nombre}:\n\nRecargaste $${monto} a tu monedero (${mp.detalle}, ${mp.referencia}). Saldo actual: $${saldo}.` });
        await db.query('COMMIT');
        res.status(201).json({
            message: mp.metodo === 'transferencia'
                ? `Recarga registrada. Transfiere ${monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} con la referencia ${mp.referencia}; se acredita al confirmarse.`
                : `Recarga aplicada: ${monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`,
            saldo, pendiente: mp.metodo === 'transferencia', referencia: mp.referencia,
        });
    } catch (e) {
        await db.query('ROLLBACK');
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    } finally { db.release(); }
}));

// =========================================================
// TICKETS DE SOPORTE (cliente)
// =========================================================
app.get('/api/clientes/:id/tickets', asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT t.*, (SELECT COUNT(*) FROM ticket_mensajes m WHERE m.ticket_id = t.id) AS mensajes
         FROM tickets_atencion t WHERE t.cliente_id = $1 ORDER BY t.fecha_actualizacion DESC`,
        [req.params.id]
    );
    res.json(r.rows);
}));

app.post('/api/clientes/:id/tickets', asyncRoute(async (req, res) => {
    const { asunto, categoria, descripcion, prioridad, pedido_id } = req.body;
    if (!asunto || !descripcion) return res.status(400).json({ message: 'Asunto y descripción son requeridos' });

    const ins = await pool.query(
        `INSERT INTO tickets_atencion (folio, cliente_id, asunto, mensaje, categoria, prioridad, pedido_id)
         VALUES ('TMP-' || substr(gen_random_uuid()::text, 1, 12), $1,$2,$3,$4,$5,
                 (SELECT id FROM pedidos WHERE id = $6 AND cliente_id = $1)) RETURNING id`,
        [req.params.id, String(asunto).slice(0, 160), String(descripcion).slice(0, 4000), String(categoria || 'general').slice(0, 40),
            ['baja', 'media', 'alta'].includes(prioridad) ? prioridad : 'media', Number(pedido_id) || null]
    );
    const t = await pool.query(
        "UPDATE tickets_atencion SET folio = 'TK-' || (1000 + id) WHERE id = $1 RETURNING *",
        [ins.rows[0].id]
    );
    const folio = t.rows[0].folio;
    await pool.query(
        `INSERT INTO ticket_mensajes (ticket_id, autor, mensaje) VALUES ($1, 'cliente', $2)`,
        [t.rows[0].id, descripcion]
    );
    // También queda como interacción CRM
    await pool.query(
        `INSERT INTO interacciones (cliente_id, tipo, descripcion) VALUES ($1, 'soporte', $2)`,
        [req.params.id, `Ticket ${folio}: ${asunto}`]
    );
    res.status(201).json({ message: 'Ticket creado', ticket: t.rows[0] });
}));

app.get('/api/clientes/:id/tickets/:ticketId', asyncRoute(async (req, res) => {
    const t = await pool.query('SELECT * FROM tickets_atencion WHERE id = $1 AND cliente_id = $2', [req.params.ticketId, req.params.id]);
    if (t.rows.length === 0) return res.status(404).json({ message: 'Ticket no encontrado' });
    const msgs = await pool.query(
        `SELECT m.*, u.nombre AS usuario_nombre FROM ticket_mensajes m
         LEFT JOIN usuarios u ON m.usuario_id = u.id
         WHERE m.ticket_id = $1 ORDER BY m.fecha ASC`,
        [req.params.ticketId]
    );
    res.json({ ...t.rows[0], mensajes: msgs.rows });
}));

app.post('/api/clientes/:id/tickets/:ticketId/mensajes', asyncRoute(async (req, res) => {
    const { mensaje } = req.body;
    if (!mensaje) return res.status(400).json({ message: 'El mensaje es requerido' });
    const t = await pool.query('SELECT id, estado FROM tickets_atencion WHERE id = $1 AND cliente_id = $2', [req.params.ticketId, req.params.id]);
    if (t.rows.length === 0) return res.status(404).json({ message: 'Ticket no encontrado' });

    await pool.query(
        `INSERT INTO ticket_mensajes (ticket_id, autor, mensaje) VALUES ($1, 'cliente', $2)`,
        [req.params.ticketId, mensaje]
    );
    // Si estaba resuelto/cerrado, se reabre; si ya se le había respondido, vuelve a "en proceso".
    if (['resuelto', 'cerrado'].includes(t.rows[0].estado)) {
        await pool.query("UPDATE tickets_atencion SET estado = 'abierto' WHERE id = $1", [req.params.ticketId]);
    } else if (t.rows[0].estado === 'respondido') {
        await pool.query("UPDATE tickets_atencion SET estado = 'en_proceso' WHERE id = $1", [req.params.ticketId]);
    } else {
        await pool.query("UPDATE tickets_atencion SET fecha_actualizacion = CURRENT_TIMESTAMP WHERE id = $1", [req.params.ticketId]);
    }
    res.status(201).json({ message: 'Mensaje enviado' });
}));

// =========================================================
// RESEÑAS DE PRODUCTO (cliente)
// =========================================================
app.get('/api/clientes/:id/resenas', asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT re.*, p.nombre AS producto_nombre, p.imagen_url
         FROM resenas re JOIN productos p ON re.producto_id = p.id
         WHERE re.cliente_id = $1 ORDER BY re.fecha DESC`,
        [req.params.id]
    );
    res.json(r.rows);
}));

app.post('/api/clientes/:id/resenas', asyncRoute(async (req, res) => {
    const { producto_id, calificacion, comentario } = req.body;
    const cal = Math.round(Number(calificacion));
    if (!producto_id || !(cal >= 1 && cal <= 5)) {
        return res.status(400).json({ message: 'Producto y calificación (1 a 5) son requeridos' });
    }
    if (!(await clienteRecibioProducto(req.params.id, producto_id))) {
        return res.status(403).json({ message: 'Podrás reseñar este producto cuando recibas tu compra' });
    }
    const r = await pool.query(
        `INSERT INTO resenas (cliente_id, producto_id, calificacion, comentario)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (cliente_id, producto_id)
         DO UPDATE SET calificacion = EXCLUDED.calificacion, comentario = EXCLUDED.comentario, fecha = CURRENT_TIMESTAMP
         RETURNING *`,
        [req.params.id, producto_id, cal, (comentario || '').slice(0, 800)]
    );
    res.status(201).json({ message: 'Reseña guardada', resena: r.rows[0] });
}));

app.delete('/api/clientes/:id/resenas/:productoId', asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM resenas WHERE cliente_id = $1 AND producto_id = $2', [req.params.id, req.params.productoId]);
    res.json({ message: 'Reseña eliminada' });
}));

// =========================================================
// DIRECCIONES DEL CLIENTE
// =========================================================

app.get('/api/clientes/:id/direcciones', asyncRoute(async (req, res) => {
    const result = await pool.query(
        'SELECT * FROM direcciones WHERE cliente_id = $1 ORDER BY predeterminada DESC, id ASC',
        [req.params.id]
    );
    res.json(result.rows);
}));

app.post('/api/clientes/:id/direcciones', asyncRoute(async (req, res) => {
    const { alias, destinatario, calle, ciudad, estado, codigo_postal, telefono, referencias, predeterminada } = req.body;
    if (!calle) return res.status(400).json({ message: 'La calle y número son requeridos' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (predeterminada) {
            await client.query('UPDATE direcciones SET predeterminada = false WHERE cliente_id = $1', [req.params.id]);
        }
        const count = await client.query('SELECT COUNT(*)::int AS n FROM direcciones WHERE cliente_id = $1', [req.params.id]);
        const esPrimera = count.rows[0].n === 0;
        const result = await client.query(
            `INSERT INTO direcciones (cliente_id, alias, destinatario, calle, ciudad, estado, codigo_postal, telefono, referencias, predeterminada)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [req.params.id, alias || null, destinatario || null, calle, ciudad || null, estado || null,
                codigo_postal || null, telefono || null, referencias || null, predeterminada || esPrimera]
        );
        await client.query('COMMIT');
        res.status(201).json({ message: 'Dirección guardada', direccion: result.rows[0] });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

app.put('/api/clientes/:id/direcciones/:dirId', asyncRoute(async (req, res) => {
    const { alias, destinatario, calle, ciudad, estado, codigo_postal, telefono, referencias, predeterminada } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (predeterminada) {
            await client.query('UPDATE direcciones SET predeterminada = false WHERE cliente_id = $1', [req.params.id]);
        }
        const result = await client.query(
            `UPDATE direcciones SET
                alias = COALESCE($1, alias), destinatario = COALESCE($2, destinatario),
                calle = COALESCE($3, calle), ciudad = COALESCE($4, ciudad),
                estado = COALESCE($5, estado), codigo_postal = COALESCE($6, codigo_postal),
                telefono = COALESCE($7, telefono), referencias = COALESCE($8, referencias),
                predeterminada = COALESCE($9, predeterminada)
             WHERE id = $10 AND cliente_id = $11 RETURNING *`,
            [alias, destinatario, calle, ciudad, estado, codigo_postal, telefono, referencias,
                predeterminada, req.params.dirId, req.params.id]
        );
        if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Dirección no encontrada' }); }
        await client.query('COMMIT');
        res.json({ message: 'Dirección actualizada', direccion: result.rows[0] });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

app.delete('/api/clientes/:id/direcciones/:dirId', asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM direcciones WHERE id = $1 AND cliente_id = $2', [req.params.dirId, req.params.id]);
    res.json({ message: 'Dirección eliminada' });
}));

// El cliente avisa que ya realizó el pago de un pedido SPEI / en tienda.
// Solo deja una marca para que el equipo lo verifique; no confirma el pago.
app.post('/api/clientes/:id/pedidos/:pedidoId/reportar-pago', asyncRoute(async (req, res) => {
    const r = await pool.query(
        `UPDATE pedidos SET pago_reportado = true
         WHERE id = $1 AND cliente_id = $2 AND pago_estado = 'pendiente'
         RETURNING id, pago_reportado`,
        [req.params.pedidoId, req.params.id]
    );
    if (r.rows.length === 0) return res.status(400).json({ message: 'No hay un pago pendiente para reportar en este pedido' });
    res.json({ message: 'Gracias, verificaremos tu pago y confirmaremos el pedido.' });
}));

// =========================================================
// GARANTÍAS EXTENDIDAS DEL CLIENTE
// =========================================================
app.get('/api/clientes/:id/garantias', asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT g.id, g.folio, g.codigo, g.plan, g.meses, g.costo, g.inicio, g.vence, g.estado,
                g.reclamo_fecha, g.reclamo_desc, g.resuelto_fecha, g.resuelto_nota,
                pr.nombre AS producto, ped.numero_orden
         FROM garantias g
         LEFT JOIN productos pr ON pr.id = g.producto_id
         LEFT JOIN pedidos ped ON ped.id = g.pedido_id
         WHERE g.cliente_id = $1 ORDER BY g.id DESC`,
        [req.params.id]
    );
    res.json(r.rows.map((g) => ({ ...g, vigente: g.estado === 'activa' && new Date(g.vence) >= new Date(new Date().toDateString()) })));
}));

app.post('/api/clientes/:id/garantias/:garId/reclamo', asyncRoute(async (req, res) => {
    const { descripcion } = req.body;
    if (!descripcion || !descripcion.trim()) return res.status(400).json({ message: 'Describe el problema para levantar el reclamo' });
    const g = await pool.query('SELECT id, estado, vence, reclamo_fecha FROM garantias WHERE id = $1 AND cliente_id = $2', [req.params.garId, req.params.id]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Garantía no encontrada' });
    const row = g.rows[0];
    if (row.estado !== 'activa') return res.status(400).json({ message: `Esta garantía está ${row.estado} y no admite reclamos` });
    if (new Date(row.vence) < new Date(new Date().toDateString())) return res.status(400).json({ message: 'Esta garantía ya venció' });
    if (row.reclamo_fecha) return res.status(400).json({ message: 'Ya hay un reclamo en curso para esta garantía' });
    await pool.query(
        `UPDATE garantias SET reclamo_fecha = CURRENT_TIMESTAMP, reclamo_desc = $1 WHERE id = $2`,
        [descripcion.trim().slice(0, 800), req.params.garId]
    );
    res.json({ message: 'Reclamo registrado. El equipo lo revisará y te contactará.' });
}));

// =========================================================
// MÉTODOS DE PAGO DEL CLIENTE
//   Solo se guarda marca + últimos 4 + expiración. El número
//   completo y el CVV nunca tocan la base de datos.
// =========================================================
app.get('/api/clientes/:id/metodos-pago', asyncRoute(async (req, res) => {
    const result = await pool.query(
        'SELECT id, tipo, marca, ultimos4, titular, expira_mes, expira_anio, predeterminada, fecha FROM metodos_pago WHERE cliente_id = $1 ORDER BY predeterminada DESC, id ASC',
        [req.params.id]
    );
    res.json(result.rows);
}));

app.post('/api/clientes/:id/metodos-pago', asyncRoute(async (req, res) => {
    const { tipo = 'tarjeta', numero, titular, expira_mes, expira_anio, predeterminada } = req.body;
    let marca = null, ultimos4 = null, mes = null, anio = null;

    if (tipo === 'tarjeta') {
        const digits = String(numero || '').replace(/\D/g, '');
        if (!luhnValido(digits)) {
            return res.status(400).json({ message: 'El número de tarjeta no es válido' });
        }
        if (!titular) return res.status(400).json({ message: 'Falta el nombre del titular' });
        mes = Number(expira_mes); anio = Number(expira_anio);
        if (!(mes >= 1 && mes <= 12) || !(anio >= 2024 && anio <= 2100)) {
            return res.status(400).json({ message: 'La fecha de expiración no es válida' });
        }
        marca = marcaTarjeta(digits);
        ultimos4 = digits.slice(-4);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const count = await client.query('SELECT COUNT(*)::int AS n FROM metodos_pago WHERE cliente_id = $1', [req.params.id]);
        const esPrimero = count.rows[0].n === 0;
        if (predeterminada || esPrimero) {
            await client.query('UPDATE metodos_pago SET predeterminada = false WHERE cliente_id = $1', [req.params.id]);
        }
        const result = await client.query(
            `INSERT INTO metodos_pago (cliente_id, tipo, marca, ultimos4, titular, expira_mes, expira_anio, predeterminada)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [req.params.id, tipo, marca, ultimos4, titular || null, mes, anio, predeterminada || esPrimero]
        );
        await client.query('COMMIT');
        res.status(201).json({ message: 'Método de pago guardado', metodo: result.rows[0] });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

app.put('/api/clientes/:id/metodos-pago/:mpId', asyncRoute(async (req, res) => {
    const { titular, predeterminada } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (predeterminada) {
            await client.query('UPDATE metodos_pago SET predeterminada = false WHERE cliente_id = $1', [req.params.id]);
        }
        const result = await client.query(
            `UPDATE metodos_pago SET titular = COALESCE($1, titular), predeterminada = COALESCE($2, predeterminada)
             WHERE id = $3 AND cliente_id = $4 RETURNING *`,
            [titular ?? null, predeterminada ?? null, req.params.mpId, req.params.id]
        );
        if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Método de pago no encontrado' }); }
        await client.query('COMMIT');
        res.json({ message: 'Método de pago actualizado', metodo: result.rows[0] });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

app.delete('/api/clientes/:id/metodos-pago/:mpId', asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM metodos_pago WHERE id = $1 AND cliente_id = $2', [req.params.mpId, req.params.id]);
    res.json({ message: 'Método de pago eliminado' });
}));

// =========================================================
// VERIFICACIÓN DE SOCIO (público) — lo usa el QR de la
// tarjeta virtual para que en tienda física puedan validar
// al socio y ver su nivel y puntos. No expone datos sensibles.
// =========================================================
app.get('/api/socio/:codigo', asyncRoute(async (req, res) => {
    const c = await pool.query(
        `SELECT id, nombre, etapa_crm, fecha_registro FROM clientes
         WHERE codigo_socio = $1 AND estado_cliente = 'activo'`,
        [req.params.codigo]
    );
    if (c.rows.length === 0) return res.status(404).json({ message: 'Socio no encontrado' });
    const rec = await estadoRecompensas(c.rows[0].id);
    res.json({
        codigo: req.params.codigo,
        nombre: c.rows[0].nombre,
        miembro_desde: c.rows[0].fecha_registro,
        nivel: rec.nivel,
        puntos: rec.puntos,
        valor_en_dinero: rec.valor_en_dinero,
    });
}));

// =========================================================
// FAVORITOS DEL CLIENTE
// =========================================================

app.get('/api/clientes/:id/favoritos', asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT f.id AS favorito_id, f.fecha AS fecha_agregado,
                p.*, c.nombre AS categoria_nombre
         FROM favoritos f
         JOIN productos p ON f.producto_id = p.id
         LEFT JOIN categorias c ON p.categoria_id = c.id
         WHERE f.cliente_id = $1 ORDER BY f.fecha DESC`,
        [req.params.id]
    );
    res.json(result.rows);
}));

app.post('/api/clientes/:id/favoritos', asyncRoute(async (req, res) => {
    const { producto_id } = req.body;
    if (!producto_id) return res.status(400).json({ message: 'producto_id es requerido' });
    await pool.query(
        `INSERT INTO favoritos (cliente_id, producto_id) VALUES ($1, $2)
         ON CONFLICT (cliente_id, producto_id) DO NOTHING`,
        [req.params.id, producto_id]
    );
    res.status(201).json({ message: 'Agregado a favoritos' });
}));

app.delete('/api/clientes/:id/favoritos/:productoId', asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM favoritos WHERE cliente_id = $1 AND producto_id = $2', [req.params.id, req.params.productoId]);
    res.json({ message: 'Quitado de favoritos' });
}));

// Cancelar un pedido propio (solo si aún no se procesó) y devolver stock
app.put('/api/pedidos/:id/cancelar', requireCliente, asyncRoute(async (req, res) => {
    const cliente_id = req.cliente.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pedidoRes = await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (pedidoRes.rows.length === 0) throw new Error('Pedido no encontrado');
        const pedido = pedidoRes.rows[0];

        if (Number(pedido.cliente_id) !== Number(cliente_id)) {
            throw new Error('No puedes cancelar este pedido');
        }
        if (!['pendiente', 'confirmado'].includes(pedido.estado)) {
            throw new Error('Este pedido ya está en preparación y no se puede cancelar en línea');
        }

        const { canjeados, reembolso_monedero } = await cancelarPedido(client, pedido);
        await registrarProceso(client, pedido.id, 'cancelacion', `Cancelada por el cliente desde la tienda${reembolso_monedero ? `; $${reembolso_monedero} regresaron a su monedero` : ''}`, { automatico: false });
        await client.query('COMMIT');
        const partes = ['Pedido cancelado y stock restaurado'];
        if (canjeados > 0) partes.push(`se devolvieron ${canjeados} puntos`);
        if (reembolso_monedero > 0) partes.push(`$${reembolso_monedero.toLocaleString('es-MX')} regresaron a tu monedero`);
        res.json({ message: partes.join('; ') + '.', reembolso_monedero });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: seg.mensajeSeguro(error) });
    } finally {
        client.release();
    }
}));

// =========================================================
// A PARTIR DE AQUÍ TODO /api/admin REQUIERE SESIÓN INTERNA
// =========================================================
app.use('/api/admin', requireUsuario);

// ---------------------------------------------------------
// CONTROL DE ACCESO POR MÓDULO (ERP 3.5)
// El menú oculta lo que no le toca a cada rol, pero eso no basta: aquí
// el servidor valida cada llamada. Cada regla dice qué permisos (de
// permisos.js) dan acceso a esa ruta; basta con tener uno. La primera
// regla que coincide decide. Sin regla, solo el administrador entra.
// Las lecturas son más amplias que las escrituras porque varias
// pantallas consultan datos de otro módulo (p. ej. el inventario lee
// proveedores); modificar algo exige el permiso de esa sección.
// ---------------------------------------------------------
const LEER = ['GET'];
const TODO = ['GET', 'POST', 'PUT', 'DELETE'];
const PERMISOS_API = [
    // Cualquier usuario interno
    { ruta: /^\/(whoami|roles)$/,                     metodos: LEER, permisos: ['*'] },
    // CRM
    { ruta: /^\/clientes\/\d+\/pedidos$/,              metodos: LEER, permisos: ['clientes', 'pedidos', 'ordenes-erp', 'ordenes-compra'] },
    { ruta: /^\/clientes(\/|$)/,                       metodos: TODO, permisos: ['clientes'] },
    { ruta: /^\/interacciones(\/|$)/,                  metodos: TODO, permisos: ['interacciones', 'clientes'] },
    { ruta: /^\/resenas$/,                             metodos: LEER, permisos: ['evaluaciones'] },
    { ruta: /^\/tickets(\/|$)/,                        metodos: TODO, permisos: ['soporte'] },
    { ruta: /^\/reportes$/,                            metodos: LEER, permisos: ['reportes'] },
    { ruta: /^\/dashboard$/,                           metodos: LEER, permisos: ['dashboard'] },
    { ruta: /^\/chatbot-consultas$/,                   metodos: LEER, permisos: ['chatbot'] },
    { ruta: /^\/garantias(\/|$)/,                      metodos: TODO, permisos: ['garantias'] },
    // Pedidos de clientes: se gestionan desde CRM, ERP o SCM
    { ruta: /^\/pedidos$/,                             metodos: LEER, permisos: ['pedidos'] },
    { ruta: /^\/pedidos\/\d+(\/|$)/,                   metodos: TODO, permisos: ['pedidos', 'ordenes-erp', 'ordenes-compra'] },
    // SCM
    { ruta: /^\/metricas-productos$/,                  metodos: LEER, permisos: ['dashboard', 'scm', 'inventario', 'reportes-scm', 'productos'] },
    { ruta: /^\/productos(\/|$)/,                      metodos: LEER, permisos: ['productos', 'inventario', 'logistica', 'scm', 'ordenes-compra', 'movimientos'] },
    { ruta: /^\/productos(\/|$)/,                      metodos: TODO, permisos: ['productos-editar'] },
    { ruta: /^\/proveedores(\/|$)/,                    metodos: LEER, permisos: ['proveedores', 'productos', 'inventario', 'ordenes-compra', 'scm'] },
    { ruta: /^\/proveedores(\/|$)/,                    metodos: TODO, permisos: ['proveedores'] },
    { ruta: /^\/movimientos-inventario$/,              metodos: TODO, permisos: ['movimientos', 'inventario', 'scm'] },
    { ruta: /^\/(ordenes-compra|pedidos-scm)(\/|$)/,   metodos: TODO, permisos: ['ordenes-compra', 'inventario', 'scm'] },
    { ruta: /^\/scm\/nivel$/,                            metodos: ['PUT'], permisos: ['nivel-scm'] },
    { ruta: /^\/scm\/(config|reabasto)$/,               metodos: TODO, permisos: ['ordenes-compra'] },
    { ruta: /^\/scm\//,                                metodos: LEER, permisos: ['scm', 'nivel-scm', 'reportes-scm', 'ordenes-compra'] },
    // ERP
    { ruta: /^\/erp\/(clientes|productos)$/,            metodos: ['POST', 'PUT', 'DELETE'], permisos: ['orden-nueva'] },
    { ruta: /^\/erp\/ordenes(\/procesar)?$/,            metodos: ['POST'], permisos: ['orden-nueva'] },
    { ruta: /^\/erp\/ordenes\/\d+\/estado$/,            metodos: ['PUT'], permisos: ['ordenes-erp'] },
    { ruta: /^\/erp\/estado$/,                          metodos: ['PUT'], permisos: ['nivel-erp'] },
    { ruta: /^\/erp\/reportes\/guardados(\/|$)/,        metodos: TODO, permisos: ['reportes-erp'] },
    { ruta: /^\/erp\/recursos(\/|$)/,                 metodos: TODO, permisos: ['recursos'] },
    { ruta: /^\/erp\//,                                metodos: LEER, permisos: ['erp', 'ordenes-erp', 'reportes-erp', 'nivel-erp'] },
    // Cuentas (solo admin; además cada ruta lleva requireAdmin)
    { ruta: /^\/usuarios(\/|$)/,                       metodos: TODO, permisos: ['usuarios'] },
];

// Rutas con el nombre exacto que pide el documento de etapas. Apuntan al
// mismo endpoint del panel (no se duplica la lógica) y se resuelven antes
// del control de permisos, así heredan los mismos permisos.
const ALIAS_API = [
    { metodo: 'POST', ruta: /^\/inventario\/movimiento$/,        destino: () => '/movimientos-inventario' },
    { metodo: 'GET',  ruta: /^\/productos\/(\d+)\/movimientos$/,  destino: (m, req) => { req.query.producto_id = m[1]; return '/movimientos-inventario'; } },
];
app.use('/api/admin', (req, res, next) => {
    const ruta = req.path.replace(/\/+$/, '');
    for (const a of ALIAS_API) {
        const m = a.metodo === req.method && ruta.match(a.ruta);
        if (m) {
            const q = req.url.indexOf('?');
            req.url = a.destino(m, req) + (q >= 0 ? req.url.slice(q) : '');
            break;
        }
    }
    next();
});

app.use('/api/admin', (req, res, next) => {
    const rol = req.usuario && req.usuario.rol;
    if (!PERMISOS[rol]) return res.status(403).json({ message: 'Tu rol ya no existe. Pide al administrador que te asigne Administrador, Ventas o Logística.' });
    if (rol === 'admin') return next();
    const ruta = req.path.replace(/\/+$/, '') || '/';
    const regla = PERMISOS_API.find((r) => r.ruta.test(ruta) && r.metodos.includes(req.method));
    if (regla && (regla.permisos.includes('*') || regla.permisos.some((k) => puedeVer(rol, k)))) return next();
    return res.status(403).json({ message: 'Tu rol no tiene acceso a esta sección' });
});

// Identidad del usuario interno autenticado (para que el panel valide
// la sesión contra el servidor y no confíe solo en localStorage).
app.get('/api/admin/whoami', (req, res) => res.json(req.usuario));

// =========================================================
// ADMIN: CLIENTES / CRM
// =========================================================

app.get('/api/admin/clientes', asyncRoute(async (req, res) => {
    const { busqueda, etapa, estado } = req.query;
    const cond = [];
    const values = [];
    let i = 1;
    if (busqueda) { cond.push(`(nombre ILIKE $${i} OR correo ILIKE $${i} OR empresa ILIKE $${i})`); values.push(`%${busqueda}%`); i++; }
    if (etapa && etapa !== 'Todas') { cond.push(`etapa_crm = $${i++}`); values.push(etapa); }
    if (estado === 'activo' || estado === 'inactivo') { cond.push(`estado_cliente = $${i++}`); values.push(estado); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const result = await pool.query(
        `SELECT id, nombre, correo, telefono, empresa, ciudad, estado_cliente, etapa_crm, fecha_registro
         FROM clientes ${where} ORDER BY id ASC`,
        values
    );
    res.json(result.rows);
}));

// Baja de cliente en dos pasos:
//   1) Activo con pedidos -> se marca Inactivo (se conserva todo).
//   2) Inactivo (o sin pedidos) -> se elimina por completo: datos, puntos,
//      direcciones, tarjetas, reseñas, tickets, garantías, interacciones.
//      Sus pedidos NO se borran (son ventas e inventario ya registrados):
//      quedan como "Cliente eliminado" para que los reportes no cambien.
//   No se elimina si tiene órdenes en curso (hay que terminarlas o
//   cancelarlas antes, porque cancelar ajusta los puntos del cliente).
app.delete('/api/admin/clientes/:id', requireAdmin, asyncRoute(async (req, res) => {
    const c = await pool.query('SELECT id, nombre, estado_cliente FROM clientes WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });
    const cli = c.rows[0];
    const pedidos = await pool.query(
        `SELECT numero_orden, estado FROM pedidos WHERE cliente_id = $1 ORDER BY id`, [cli.id]);
    if (pedidos.rows.length > 0 && cli.estado_cliente === 'activo') {
        await pool.query(`UPDATE clientes SET estado_cliente = 'inactivo', etapa_crm = 'Inactivo' WHERE id = $1`, [cli.id]);
        return res.json({ message: `${cli.nombre} tiene pedidos: se marcó como inactivo. Si lo eliminas de nuevo se borra por completo.`, resultado: 'inactivo' });
    }
    const enCurso = pedidos.rows.filter((p) => !['entregado', 'cancelado'].includes(p.estado));
    if (enCurso.length > 0) {
        return res.status(400).json({ message: `No se puede eliminar: tiene ${enCurso.length === 1 ? 'una orden' : 'órdenes'} en curso (${enCurso.map((p) => p.numero_orden).join(', ')}). Entrégalas o cancélalas primero.` });
    }
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        await db.query('UPDATE pedidos SET cliente_id = NULL WHERE cliente_id = $1', [cli.id]);
        await db.query('UPDATE chatbot_consultas SET cliente_id = NULL WHERE cliente_id = $1', [cli.id]);
        await db.query('DELETE FROM clientes WHERE id = $1', [cli.id]);
        await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
    res.json({
        message: pedidos.rows.length
            ? `${cli.nombre} se eliminó por completo. Sus ${pedidos.rows.length} pedido(s) se conservan como "Cliente eliminado".`
            : `${cli.nombre} se eliminó por completo.`,
        resultado: 'eliminado',
    });
}));

// Alta de cliente desde el panel (equivale al registro, pero lo hace un admin)
app.post('/api/admin/clientes', requireAdmin, asyncRoute(async (req, res) => {
    const { nombre, correo, password, telefono, empresa, ciudad, estado } = req.body;
    if (!nombre || !correo || !password) return res.status(400).json({ message: 'Nombre, correo y contraseña son obligatorios' });
    if (!seg.correoValido(correo)) return res.status(400).json({ message: 'El correo no es válido' });
    const errPass = seg.validarPassword(password, { correo, nombre });
    if (errPass) return res.status(400).json({ message: errPass });

    const existe = await pool.query('SELECT id FROM clientes WHERE LOWER(correo) = LOWER($1)', [correo]);
    if (existe.rows.length > 0) return res.status(400).json({ message: 'Ese correo ya está registrado' });

    const hash = await seg.hashPassword(password);
    let codigoSocio;
    for (let i = 0; i < 5; i++) {
        codigoSocio = generarCodigoSocio();
        const d = await pool.query('SELECT 1 FROM clientes WHERE codigo_socio = $1', [codigoSocio]);
        if (d.rows.length === 0) break;
    }
    const r = await pool.query(
        `INSERT INTO clientes (nombre, correo, password, telefono, empresa, ciudad, estado, codigo_socio, estado_cliente, etapa_crm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'activo','Prospecto')
         RETURNING id, nombre, correo, telefono, empresa, ciudad, estado, etapa_crm, fecha_registro`,
        [nombre, seg.normalizarCorreo(correo), hash, telefono || null, empresa || null, ciudad || null, estado || null, codigoSocio]
    );
    await pool.query('INSERT INTO metricas_clientes (cliente_id) VALUES ($1) ON CONFLICT (cliente_id) DO NOTHING', [r.rows[0].id]);
    await monederoDe(pool, r.rows[0].id);
    res.status(201).json({ message: 'Cliente creado', cliente: r.rows[0] });
}));

app.get('/api/admin/clientes/:id/pedidos', asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT p.id, p.numero_orden, p.fecha_pedido, p.total, p.estado, p.metodo_pago,
                p.pago_estado, p.pago_reportado,
                STRING_AGG(pr.nombre, ', ') AS productos
         FROM pedidos p
         LEFT JOIN pedido_detalle pi ON p.id = pi.pedido_id
         LEFT JOIN productos pr ON pi.producto_id = pr.id
         WHERE p.cliente_id = $1
         GROUP BY p.id ORDER BY p.fecha_pedido DESC`,
        [req.params.id]
    );
    res.json(result.rows);
}));

app.get('/api/admin/clientes/:id', asyncRoute(async (req, res) => {
    const cliente = await pool.query(
        `SELECT id, nombre, correo, telefono, empresa, direccion, ciudad, estado, codigo_postal,
                estado_cliente, etapa_crm, puntos, codigo_socio, fecha_registro, ultimo_login
         FROM clientes WHERE id = $1`, [req.params.id]);
    if (cliente.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });
    const metricas = await pool.query('SELECT * FROM metricas_clientes WHERE cliente_id = $1', [req.params.id]);
    const extra = await pool.query(`
        SELECT (SELECT COUNT(*) FROM pedidos      WHERE cliente_id = $1 AND estado <> 'cancelado') AS pedidos,
               (SELECT COUNT(*) FROM resenas      WHERE cliente_id = $1)                          AS resenas,
               (SELECT COUNT(*) FROM tickets_atencion      WHERE cliente_id = $1)                          AS tickets,
               (SELECT COUNT(*) FROM tickets_atencion      WHERE cliente_id = $1 AND estado IN ('abierto','en_proceso')) AS tickets_abiertos
    `, [req.params.id]);
    const nivel = nivelRecompensas(metricas.rows[0]?.valor_total_compras || 0, metricas.rows[0]?.total_compras || 0).actual;
    res.json({ ...cliente.rows[0], metricas: metricas.rows[0] || null, resumen: extra.rows[0], nivel });
}));

// Editar datos básicos de un cliente desde el CRM
app.put('/api/admin/clientes/:id', asyncRoute(async (req, res) => {
    const { nombre, telefono, empresa, ciudad, estado, estado_cliente } = req.body;
    const r = await pool.query(
        `UPDATE clientes SET
            nombre = COALESCE($1, nombre), telefono = COALESCE($2, telefono),
            empresa = COALESCE($3, empresa), ciudad = COALESCE($4, ciudad),
            estado = COALESCE($5, estado),
            estado_cliente = COALESCE($6, estado_cliente)
         WHERE id = $7 RETURNING id, nombre, correo, telefono, empresa, ciudad, estado, estado_cliente, etapa_crm`,
        [nombre, telefono, empresa, ciudad, estado,
            ['activo', 'inactivo'].includes(estado_cliente) ? estado_cliente : null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json({ message: 'Cliente actualizado', cliente: r.rows[0] });
}));

// Evaluaciones (reseñas) de un cliente
app.get('/api/admin/clientes/:id/resenas', asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT re.*, p.nombre AS producto_nombre FROM resenas re
         JOIN productos p ON re.producto_id = p.id
         WHERE re.cliente_id = $1 ORDER BY re.fecha DESC`,
        [req.params.id]
    );
    res.json(r.rows);
}));

// Movimientos de puntos de un cliente (Club)
app.get('/api/admin/clientes/:id/puntos', asyncRoute(async (req, res) => {
    const mov = await pool.query(
        'SELECT tipo, puntos, motivo, fecha FROM movimientos_puntos WHERE cliente_id = $1 ORDER BY fecha DESC LIMIT 50',
        [req.params.id]
    );
    const c = await pool.query('SELECT puntos FROM clientes WHERE id = $1', [req.params.id]);
    res.json({ saldo: c.rows[0]?.puntos ?? 0, movimientos: mov.rows });
}));

app.put('/api/admin/clientes/:id/etapa', asyncRoute(async (req, res) => {
    const { etapa_crm } = req.body;
    const validas = ['Prospecto', 'Activo', 'Frecuente', 'Inactivo'];
    if (!validas.includes(etapa_crm)) return res.status(400).json({ message: 'Etapa no válida' });
    const result = await pool.query('UPDATE clientes SET etapa_crm = $1 WHERE id = $2 RETURNING id, nombre, etapa_crm', [etapa_crm, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json({ message: 'Etapa actualizada', cliente: result.rows[0] });
}));

// Historial de interacciones de un cliente
app.get('/api/admin/clientes/:id/interacciones', asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT i.*, u.nombre AS usuario_nombre FROM interacciones i
         LEFT JOIN usuarios u ON i.usuario_id = u.id
         WHERE i.cliente_id = $1 ORDER BY i.fecha DESC`,
        [req.params.id]
    );
    res.json(result.rows);
}));

app.post('/api/admin/clientes/:id/interacciones', asyncRoute(async (req, res) => {
    const { tipo, descripcion } = req.body;
    if (!['llamada', 'correo', 'reunion', 'chat', 'soporte'].includes(tipo) || !descripcion) return res.status(400).json({ message: 'Tipo válido y descripción son requeridos' });
    const result = await pool.query(
        `INSERT INTO interacciones (cliente_id, usuario_id, tipo, descripcion) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.id, req.usuario.id, tipo, String(descripcion).slice(0, 2000)]
    );
    res.status(201).json(result.rows[0]);
}));

// =========================================================
// ADMIN: INTERACCIONES (vista global)
// =========================================================
app.get('/api/admin/interacciones', asyncRoute(async (req, res) => {
    const { tipo, cliente_id, desde, hasta, busqueda } = req.query;
    const cond = [];
    const values = [];
    let i = 1;
    if (tipo && tipo !== 'Todos') { cond.push(`i.tipo = $${i++}`); values.push(tipo); }
    if (cliente_id) { cond.push(`i.cliente_id = $${i++}`); values.push(cliente_id); }
    if (desde) { cond.push(`i.fecha >= $${i++}`); values.push(desde); }
    if (hasta) { cond.push(`i.fecha < ($${i++}::date + 1)`); values.push(hasta); }
    if (busqueda) { cond.push(`(i.descripcion ILIKE $${i} OR c.nombre ILIKE $${i})`); values.push(`%${busqueda}%`); i++; }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const rows = await pool.query(
        `SELECT i.id, i.tipo, i.descripcion, i.fecha, i.cliente_id,
                c.nombre AS cliente_nombre, u.nombre AS usuario_nombre
         FROM interacciones i
         JOIN clientes c ON i.cliente_id = c.id
         LEFT JOIN usuarios u ON i.usuario_id = u.id
         ${where} ORDER BY i.fecha DESC LIMIT 300`,
        values
    );
    res.json(rows.rows);
}));

// Crear interacción eligiendo el cliente (flujo "Nueva interacción" global)
app.post('/api/admin/interacciones', asyncRoute(async (req, res) => {
    const { cliente_id, tipo, descripcion } = req.body;
    const tipos = ['llamada', 'correo', 'reunion', 'chat', 'soporte'];
    if (!cliente_id || !tipos.includes(tipo) || !descripcion) {
        return res.status(400).json({ message: 'Cliente, tipo válido y descripción son requeridos' });
    }
    const r = await pool.query(
        `INSERT INTO interacciones (cliente_id, usuario_id, tipo, descripcion) VALUES ($1,$2,$3,$4) RETURNING *`,
        [cliente_id, req.usuario.id, tipo, descripcion]
    );
    res.status(201).json({ message: 'Interacción registrada', interaccion: r.rows[0] });
}));

// =========================================================
// ADMIN: EVALUACIONES (todas las reseñas)
// =========================================================
app.get('/api/admin/resenas', asyncRoute(async (req, res) => {
    const { min } = req.query;
    const cond = [];
    const values = [];
    if (min) { cond.push(`re.calificacion >= $1`); values.push(min); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const rows = await pool.query(
        `SELECT re.id, re.calificacion, re.comentario, re.fecha,
                c.id AS cliente_id, c.nombre AS cliente_nombre,
                p.id AS producto_id, p.nombre AS producto_nombre
         FROM resenas re
         JOIN clientes c ON re.cliente_id = c.id
         JOIN productos p ON re.producto_id = p.id
         ${where} ORDER BY re.fecha DESC LIMIT 200`,
        values
    );
    const stats = await pool.query('SELECT ROUND(AVG(calificacion),2) AS promedio, COUNT(*)::int AS total FROM resenas');
    res.json({ promedio: Number(stats.rows[0].promedio) || 0, total: stats.rows[0].total, resenas: rows.rows });
}));

// =========================================================
// ADMIN: TICKETS DE SOPORTE
// =========================================================
app.get('/api/admin/tickets', asyncRoute(async (req, res) => {
    const { estado, prioridad } = req.query;
    const cond = [];
    const values = [];
    let i = 1;
    if (estado && estado !== 'Todos') { cond.push(`t.estado = $${i++}`); values.push(estado); }
    if (prioridad && prioridad !== 'Todas') { cond.push(`t.prioridad = $${i++}`); values.push(prioridad); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const rows = await pool.query(
        `SELECT t.*, c.nombre AS cliente_nombre, c.correo AS cliente_correo,
                (SELECT COUNT(*) FROM ticket_mensajes m WHERE m.ticket_id = t.id) AS mensajes,
                u.nombre AS asignado_nombre
         FROM tickets_atencion t
         JOIN clientes c ON t.cliente_id = c.id
         LEFT JOIN usuarios u ON t.asignado_a = u.id
         ${where}
         ORDER BY CASE t.estado WHEN 'abierto' THEN 0 WHEN 'en_proceso' THEN 1 WHEN 'respondido' THEN 2 ELSE 3 END,
                  CASE t.prioridad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
                  t.fecha_actualizacion DESC`,
        values
    );
    const counts = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE estado = 'abierto')    AS abiertos,
               COUNT(*) FILTER (WHERE estado = 'en_proceso') AS en_proceso,
               COUNT(*) FILTER (WHERE estado = 'respondido') AS respondidos,
               COUNT(*) FILTER (WHERE estado = 'resuelto')   AS resueltos,
               COUNT(*) FILTER (WHERE estado = 'cerrado')    AS cerrados
        FROM tickets_atencion`);
    res.json({ conteos: counts.rows[0], tickets: rows.rows });
}));

app.get('/api/admin/tickets/:id', asyncRoute(async (req, res) => {
    const t = await pool.query(
        `SELECT t.*, c.nombre AS cliente_nombre, c.correo AS cliente_correo, c.telefono AS cliente_telefono
         FROM tickets_atencion t JOIN clientes c ON t.cliente_id = c.id WHERE t.id = $1`,
        [req.params.id]
    );
    if (t.rows.length === 0) return res.status(404).json({ message: 'Ticket no encontrado' });
    const msgs = await pool.query(
        `SELECT m.*, u.nombre AS usuario_nombre FROM ticket_mensajes m
         LEFT JOIN usuarios u ON m.usuario_id = u.id
         WHERE m.ticket_id = $1 ORDER BY m.fecha ASC`,
        [req.params.id]
    );
    res.json({ ...t.rows[0], mensajes: msgs.rows });
}));

app.post('/api/admin/tickets/:id/mensajes', asyncRoute(responderTicket));

app.put('/api/admin/tickets/:id', asyncRoute(async (req, res) => {
    const { estado, prioridad, asignado_a } = req.body;
    const est = ['abierto', 'en_proceso', 'respondido', 'resuelto', 'cerrado'];
    const pri = ['baja', 'media', 'alta'];
    const r = await pool.query(
        `UPDATE tickets_atencion SET
            estado    = COALESCE($1, estado),
            prioridad = COALESCE($2, prioridad),
            asignado_a = COALESCE($3, asignado_a)
         WHERE id = $4 RETURNING *`,
        [est.includes(estado) ? estado : null, pri.includes(prioridad) ? prioridad : null,
            Number(asignado_a) || null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: 'Ticket no encontrado' });
    res.json({ message: 'Ticket actualizado', ticket: r.rows[0] });
}));

// =========================================================
// ADMIN: REPORTES (métricas con rango de fechas)
// =========================================================
app.get('/api/admin/reportes', asyncRoute(async (req, res) => {
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const rango = (col) => {
        const parts = [];
        const vals = [];
        let n = 1;
        if (desde) { parts.push(`${col} >= $${n++}`); vals.push(desde); }
        if (hasta) { parts.push(`${col} < ($${n++}::date + 1)`); vals.push(hasta); }
        return { where: parts.length ? 'WHERE ' + parts.join(' AND ') : '', vals };
    };

    const cli = await pool.query(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE estado_cliente = 'activo')   AS activos,
               COUNT(*) FILTER (WHERE estado_cliente = 'inactivo') AS inactivos
        FROM clientes`);

    const ri = rango('fecha');
    const interTipo = await pool.query(
        `SELECT tipo, COUNT(*) AS total FROM interacciones ${ri.where} GROUP BY tipo ORDER BY total DESC`, ri.vals);
    const interTotal = await pool.query(
        `SELECT COUNT(*) AS total FROM interacciones ${ri.where}`, ri.vals);

    const porEtapa = await pool.query('SELECT etapa_crm, COUNT(*) AS total FROM clientes GROUP BY etapa_crm');

    const rp = rango('fecha_pedido');
    const ventas = await pool.query(
        `SELECT COUNT(*) AS pedidos, COALESCE(SUM(total),0) AS ingresos
         FROM pedidos ${rp.where ? rp.where + " AND estado <> 'cancelado'" : "WHERE estado <> 'cancelado'"}`,
        rp.vals);

    const rc = rango('fecha_registro');
    const nuevos = await pool.query(`SELECT COUNT(*) AS total FROM clientes ${rc.where}`, rc.vals);

    const sinInteraccion = await pool.query(`
        SELECT COUNT(*) AS total FROM clientes c
        LEFT JOIN metricas_clientes m ON c.id = m.cliente_id
        WHERE COALESCE(m.ultima_interaccion, c.fecha_registro) < CURRENT_TIMESTAMP - INTERVAL '30 days'`);

    res.json({
        rango: { desde, hasta },
        clientes: {
            total: Number(cli.rows[0].total),
            activos: Number(cli.rows[0].activos),
            inactivos: Number(cli.rows[0].inactivos),
            nuevos_periodo: Number(nuevos.rows[0].total),
            sin_interaccion: Number(sinInteraccion.rows[0].total),
        },
        interacciones: {
            total_periodo: Number(interTotal.rows[0].total),
            por_tipo: interTipo.rows,
        },
        clientes_por_etapa: porEtapa.rows,
        ventas: {
            pedidos: Number(ventas.rows[0].pedidos),
            ingresos: Number(ventas.rows[0].ingresos),
        },
    });
}));

// =========================================================
// ADMIN: DASHBOARD / MÉTRICAS CRM
// =========================================================

app.get('/api/admin/dashboard', asyncRoute(async (req, res) => {
    const totales = await pool.query(`
        SELECT
            COUNT(*) AS total_clientes,
            COUNT(*) FILTER (WHERE estado_cliente = 'activo') AS activos,
            COUNT(*) FILTER (WHERE estado_cliente = 'inactivo') AS inactivos
        FROM clientes
    `);

    const interaccionesMes = await pool.query(`
        SELECT COUNT(*) AS total FROM interacciones
        WHERE fecha >= DATE_TRUNC('month', CURRENT_DATE)
    `);

    const sinInteraccion = await pool.query(`
        SELECT c.id, c.nombre, c.correo,
               COALESCE(m.ultima_interaccion, c.fecha_registro) AS ultima_referencia,
               COALESCE(EXTRACT(DAY FROM (CURRENT_TIMESTAMP - COALESCE(m.ultima_interaccion, c.fecha_registro)))::int, 9999) AS dias_sin_contacto
        FROM clientes c
        LEFT JOIN metricas_clientes m ON c.id = m.cliente_id
        WHERE COALESCE(m.ultima_interaccion, c.fecha_registro) < CURRENT_TIMESTAMP - INTERVAL '30 days'
        ORDER BY dias_sin_contacto DESC
        LIMIT 10
    `);

    const porEtapa = await pool.query(`
        SELECT etapa_crm, COUNT(*) AS total FROM clientes GROUP BY etapa_crm
    `);

    const porTipoInteraccion = await pool.query(`
        SELECT tipo, COUNT(*) AS total FROM interacciones GROUP BY tipo
    `);

    const tickets = await pool.query(`
        SELECT
            COUNT(*) FILTER (WHERE estado IN ('abierto', 'en_proceso')) AS activos,
            COUNT(*) FILTER (WHERE estado = 'abierto') AS abiertos
        FROM tickets_atencion
    `);

    res.json({
        total_clientes: Number(totales.rows[0].total_clientes),
        activos: Number(totales.rows[0].activos),
        inactivos: Number(totales.rows[0].inactivos),
        interacciones_mes: Number(interaccionesMes.rows[0].total),
        tickets_activos: Number(tickets.rows[0].activos),
        tickets_abiertos: Number(tickets.rows[0].abiertos),
        clientes_sin_interaccion: sinInteraccion.rows,
        clientes_por_etapa: porEtapa.rows,
        interacciones_por_tipo: porTipoInteraccion.rows
    });
}));

app.get('/api/admin/metricas-productos', asyncRoute(async (req, res) => {
    const masVendidos = await pool.query(`
        SELECT p.id, p.nombre, p.marca, p.stock, p.precio,
               COALESCE(SUM(pi.cantidad) FILTER (WHERE pe.estado <> 'cancelado'), 0) AS unidades_vendidas
        FROM productos p
        LEFT JOIN pedido_detalle pi ON pi.producto_id = p.id
        LEFT JOIN pedidos pe ON pi.pedido_id = pe.id
        GROUP BY p.id ORDER BY unidades_vendidas DESC LIMIT 10
    `);
    const inventarioCritico = await pool.query(`
        SELECT p.id, p.nombre, p.marca, p.stock, p.stock_minimo, p.restock,
               pr.nombre AS proveedor_nombre, pr.tiempo_entrega_dias,
               oc.folio AS orden_abierta_folio
        FROM productos p
        LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
        LEFT JOIN LATERAL (
            SELECT folio FROM ordenes_compra
            WHERE producto_id = p.id AND estado IN ('pendiente','en_proceso')
            ORDER BY fecha_creacion DESC LIMIT 1
        ) oc ON true
        WHERE p.stock <= p.stock_minimo AND p.activo = true ORDER BY p.stock ASC
    `);
    const stats = await pool.query(`
        SELECT COUNT(*) AS total_productos, COALESCE(SUM(stock),0) AS stock_total,
               COUNT(*) FILTER (WHERE stock = 0) AS agotados,
               COUNT(*) FILTER (WHERE stock > 0 AND stock <= stock_minimo) AS criticos
        FROM productos WHERE activo = true
    `);
    res.json({ mas_vendidos: masVendidos.rows, inventario_critico: inventarioCritico.rows, stats: stats.rows[0] });
}));

// =========================================================
// ADMIN: ANALÍTICA DEL CHATBOT
// Qué está buscando la gente, con qué presupuesto y cuántas
// consultas se quedaron SIN recomendación (oportunidad de
// inventario / restock).
// =========================================================
app.get('/api/admin/chatbot-consultas', asyncRoute(async (req, res) => {
    const totales = await pool.query(`
        SELECT
            COUNT(*)                                                   AS total,
            COUNT(*) FILTER (WHERE productos_sugeridos IS NULL
                             OR cardinality(productos_sugeridos) = 0)  AS sin_resultado,
            COUNT(*) FILTER (WHERE fecha >= DATE_TRUNC('month', CURRENT_DATE)) AS este_mes,
            ROUND(AVG(presupuesto))                                    AS presupuesto_promedio
        FROM chatbot_consultas
    `);

    const porUso = await pool.query(`
        SELECT COALESCE(uso, '(sin especificar)') AS uso, COUNT(*) AS total
        FROM chatbot_consultas GROUP BY uso ORDER BY total DESC
    `);

    const rangos = await pool.query(`
        SELECT CASE
            WHEN presupuesto IS NULL      THEN '(sin presupuesto)'
            WHEN presupuesto < 10000      THEN 'Menos de $10,000'
            WHEN presupuesto < 20000      THEN '$10,000 - $20,000'
            WHEN presupuesto < 35000      THEN '$20,000 - $35,000'
            ELSE 'Más de $35,000'
        END AS rango, COUNT(*) AS total
        FROM chatbot_consultas GROUP BY rango ORDER BY total DESC
    `);

    const recientes = await pool.query(`
        SELECT ch.id, ch.fecha, ch.uso, ch.presupuesto, ch.categoria, ch.mensaje,
               COALESCE(cardinality(ch.productos_sugeridos), 0) AS num_sugerencias,
               c.nombre AS cliente_nombre
        FROM chatbot_consultas ch
        LEFT JOIN clientes c ON ch.cliente_id = c.id
        ORDER BY ch.fecha DESC LIMIT 60
    `);

    res.json({
        total: Number(totales.rows[0].total),
        sin_resultado: Number(totales.rows[0].sin_resultado),
        este_mes: Number(totales.rows[0].este_mes),
        presupuesto_promedio: Number(totales.rows[0].presupuesto_promedio || 0),
        por_uso: porUso.rows,
        por_rango_presupuesto: rangos.rows,
        recientes: recientes.rows,
    });
}));

// =========================================================
// ADMIN: PRODUCTOS / INVENTARIO
// =========================================================

app.get('/api/admin/productos', asyncRoute(async (req, res) => {
    // ?estrategia=PUSH | PULL  (estrategia logística del producto)
    const estrategia = String(req.query.estrategia || '').toLowerCase();
    const filtro = ['push', 'pull'].includes(estrategia) ? 'WHERE p.restock = $1' : '';
    const result = await pool.query(`
        SELECT p.*, UPPER(p.restock) AS estrategia_logistica,
               c.nombre AS categoria_nombre, pr.nombre AS proveedor_nombre
        FROM productos p
        LEFT JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
        ${filtro}
        ORDER BY p.id ASC
    `, filtro ? [estrategia] : []);
    res.json(result.rows);
}));

// Imagen de producto: vacía, ruta de la tienda o URL http(s). Así no se
// puede guardar un "javascript:" ni otra cosa rara en el src.
const imagenValida = (u) => u === undefined || u === null || u === '' || /^(https?:\/\/|\/)[^\s]{1,500}$/i.test(String(u));

app.post('/api/admin/productos', asyncRoute(async (req, res) => {
    const {
        nombre, descripcion, categoria_id, marca, precio, stock, stock_minimo,
        procesador, ram_gb, almacenamiento, tarjeta_grafica, pantalla,
        uso_recomendado, imagen_url, proveedor_id, vendedor_id, activo, restock, costo_unitario, destacado
    } = req.body;

    if (!nombre || precio === undefined || !(Number(precio) >= 0)) {
        return res.status(400).json({ message: 'Nombre y precio válido son requeridos' });
    }
    if (!imagenValida(imagen_url)) return res.status(400).json({ message: 'La imagen debe ser una URL http(s) o una ruta de la tienda' });

    const result = await pool.query(
        `INSERT INTO productos
         (nombre, descripcion, categoria_id, marca, precio, stock, stock_minimo,
          procesador, ram_gb, almacenamiento, tarjeta_grafica, pantalla,
          uso_recomendado, imagen_url, proveedor_id, vendedor_id, activo, restock, costo_unitario, destacado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [nombre, descripcion || '', categoria_id || null, marca || '', precio, stock || 0, stock_minimo || 5,
            procesador || null, ram_gb || null, almacenamiento || null, tarjeta_grafica || null, pantalla || null,
            uso_recomendado || [], imagen_url || '', proveedor_id || null, vendedor_id || null,
            activo !== undefined ? activo : true, restock || 'push',
            costo_unitario === undefined || costo_unitario === '' ? null : costo_unitario, destacado === true]
    );
    await generarOrdenAutomaticaSiCritico(pool, result.rows[0].id);
    res.status(201).json({ message: 'Producto creado', producto: result.rows[0] });
}));

app.put('/api/admin/productos/:id', asyncRoute(async (req, res) => {
    const {
        nombre, descripcion, categoria_id, marca, precio, stock, stock_minimo,
        procesador, ram_gb, almacenamiento, tarjeta_grafica, pantalla,
        uso_recomendado, imagen_url, proveedor_id, activo, restock, costo_unitario, destacado
    } = req.body;
    if (!imagenValida(imagen_url)) return res.status(400).json({ message: 'La imagen debe ser una URL http(s) o una ruta de la tienda' });

    const result = await pool.query(
        `UPDATE productos SET
            nombre = COALESCE($1, nombre), descripcion = COALESCE($2, descripcion),
            categoria_id = COALESCE($3, categoria_id), marca = COALESCE($4, marca),
            precio = COALESCE($5, precio), stock = COALESCE($6, stock),
            stock_minimo = COALESCE($7, stock_minimo), procesador = COALESCE($8, procesador),
            ram_gb = COALESCE($9, ram_gb), almacenamiento = COALESCE($10, almacenamiento),
            tarjeta_grafica = COALESCE($11, tarjeta_grafica), pantalla = COALESCE($12, pantalla),
            uso_recomendado = COALESCE($13, uso_recomendado), imagen_url = COALESCE($14, imagen_url),
            proveedor_id = COALESCE($15, proveedor_id), activo = COALESCE($16, activo),
            restock = COALESCE($17, restock), costo_unitario = COALESCE($18, costo_unitario),
            destacado = COALESCE($20, destacado)
         WHERE id = $19 RETURNING *`,
        [nombre, descripcion, categoria_id, marca, precio, stock, stock_minimo, procesador, ram_gb,
            almacenamiento, tarjeta_grafica, pantalla, uso_recomendado, imagen_url, proveedor_id, activo, restock,
            costo_unitario === '' ? null : costo_unitario, req.params.id, typeof destacado === 'boolean' ? destacado : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    await generarOrdenAutomaticaSiCritico(pool, result.rows[0].id);
    res.json({ message: 'Producto actualizado', producto: result.rows[0] });
}));

// Estrategia logística de un producto: PUSH (reposición automática al
// llegar al mínimo) o PULL (reposición solo bajo pedido / demanda).
app.put('/api/admin/productos/:id/estrategia', asyncRoute(async (req, res) => {
    const estrategia = String(req.body.estrategia || req.body.restock || '').toLowerCase();
    if (!['push', 'pull'].includes(estrategia)) return res.status(400).json({ message: 'Estrategia no válida (PUSH o PULL)' });
    const r = await pool.query('UPDATE productos SET restock = $1 WHERE id = $2 RETURNING *', [estrategia, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    // Si pasa a PUSH y ya está en su mínimo, se genera su pedido de reposición.
    await generarOrdenAutomaticaSiCritico(pool, r.rows[0].id);
    res.json({ message: `Estrategia actualizada a ${estrategia.toUpperCase()}`, producto: { ...r.rows[0], estrategia_logistica: estrategia.toUpperCase() } });
}));

app.delete('/api/admin/productos/:id', asyncRoute(async (req, res) => {
    const enUso = await pool.query('SELECT id FROM pedido_detalle WHERE producto_id = $1 LIMIT 1', [req.params.id]);
    if (enUso.rows.length > 0) {
        await pool.query('UPDATE productos SET activo = false WHERE id = $1', [req.params.id]);
        return res.json({ message: 'El producto tiene ventas asociadas; se desactivó en lugar de eliminarlo' });
    }
    await pool.query('DELETE FROM productos WHERE id = $1', [req.params.id]);
    res.json({ message: 'Producto eliminado' });
}));

// Restock manual desde el admin
app.post('/api/admin/productos/:id/restock', asyncRoute(async (req, res) => {
    const { cantidad, motivo } = req.body;
    if (!cantidad || cantidad < 1) return res.status(400).json({ message: 'Cantidad inválida' });

    const prod = await pool.query('SELECT * FROM productos WHERE id = $1', [req.params.id]);
    if (prod.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });

    const nuevoStock = prod.rows[0].stock + Number(cantidad);
    await pool.query('UPDATE productos SET stock = $1 WHERE id = $2', [nuevoStock, req.params.id]);
    await pool.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, usuario_id) VALUES ($1,'entrada',$2,$3,$4)`,
        [req.params.id, cantidad, motivo || 'Restock manual desde admin', req.usuario.id]
    );
    await generarOrdenAutomaticaSiCritico(pool, req.params.id);
    res.json({ message: 'Restock aplicado', stock_nuevo: nuevoStock });
}));

app.get('/api/admin/movimientos-inventario', asyncRoute(async (req, res) => {
    const { tipo, producto_id } = req.query;
    const cond = [];
    const values = [];
    let i = 1;
    if (tipo) { cond.push(`m.tipo = $${i++}`); values.push(tipo); }
    if (producto_id) { cond.push(`m.producto_id = $${i++}`); values.push(producto_id); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const result = await pool.query(`
        SELECT m.*, p.nombre AS producto_nombre, u.nombre AS usuario_nombre
        FROM movimientos_inventario m
        LEFT JOIN productos p ON m.producto_id = p.id
        LEFT JOIN usuarios u ON m.usuario_id = u.id
        ${where}
        ORDER BY m.fecha DESC LIMIT 200
    `, values);
    res.json(result.rows);
}));

// Registrar un movimiento manual (ajuste, merma, conteo físico, etc.) —
// a diferencia del restock rápido, aquí también se puede registrar una
// SALIDA manual, con su propio motivo.
app.post('/api/admin/movimientos-inventario', asyncRoute(async (req, res) => {
    const { producto_id, tipo, cantidad, motivo, fecha } = req.body;
    if (!producto_id || !['entrada', 'salida'].includes(tipo) || !cantidad || cantidad < 1) {
        return res.status(400).json({ message: 'Producto, tipo y cantidad son obligatorios' });
    }
    const prod = await pool.query('SELECT stock FROM productos WHERE id = $1', [producto_id]);
    if (prod.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    if (tipo === 'salida' && prod.rows[0].stock < cantidad) {
        return res.status(400).json({ message: `Solo hay ${prod.rows[0].stock} en stock; no se puede registrar una salida mayor` });
    }

    const signo = tipo === 'entrada' ? 1 : -1;
    await pool.query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [signo * cantidad, producto_id]);
    const result = await pool.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, usuario_id, fecha)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamp, CURRENT_TIMESTAMP)) RETURNING *`,
        [producto_id, tipo, cantidad, motivo || 'Ajuste manual', req.usuario.id, fecha || null]
    );
    if (tipo === 'salida') await generarOrdenAutomaticaSiCritico(pool, producto_id, 'demanda');
    res.status(201).json(result.rows[0]);
}));


// =========================================================
// REABASTO AUTOMÁTICO (SCM)
// Para no depender de que alguien haga el restock a mano:
//   1) Cuando un producto llega a su stock mínimo, el sistema genera
//      solo el pedido de reposición a su proveedor y lo deja "en
//      proceso" (enviado al proveedor).
//        - PUSH: se pide en cuanto toca el mínimo, venga de donde venga.
//        - PULL: solo se pide cuando lo dispara la demanda (una venta o
//          una salida de inventario).
//   2) Cuando llega la fecha estimada de entrega (hoy + días de entrega
//      del proveedor), el pedido se surte solo: sube el stock y queda el
//      movimiento de entrada registrado a nombre del sistema.
// Se configura en config_scm (pantalla Pedidos del SCM):
//   reabasto_automatico = 'si' | 'no'
//   entrega             = 'fecha' (según el proveedor) | 'inmediata'
// =========================================================
const CONFIG_SCM_DEFAULT = { reabasto_automatico: 'si', entrega: 'fecha' };

async function leerConfigScm(db) {
    const cfg = { ...CONFIG_SCM_DEFAULT };
    const r = await db.query('SELECT clave, valor FROM config_scm');
    r.rows.forEach((f) => { cfg[f.clave] = f.valor; });
    return cfg;
}

// Crea un pedido de reposición (orden de compra) con su folio OC-xxxx.
// Si no se da fecha estimada, se calcula con el tiempo de entrega del proveedor.
async function crearOrdenCompra(db, { producto_id, proveedor_id, cantidad, notas, usuario_id, estado = 'pendiente', fecha_estimada = null }) {
    const ins = await db.query(
        `INSERT INTO ordenes_compra (folio, proveedor_id, producto_id, cantidad, notas, usuario_id, estado, fecha_estimada)
         VALUES ('OC-TMP', $1, $2, $3, $4, $5, $6,
                 COALESCE($7::date, CURRENT_DATE + (SELECT tiempo_entrega_dias FROM proveedores WHERE id = $1)))
         RETURNING id`,
        [proveedor_id, producto_id, cantidad, notas || null, usuario_id || null, estado, fecha_estimada || null]
    );
    const fin = await db.query(`UPDATE ordenes_compra SET folio = 'OC-' || (1000 + id) WHERE id = $1 RETURNING *`, [ins.rows[0].id]);
    return fin.rows[0];
}

// Surte (recibe) un pedido de reposición: sube el stock y registra el
// movimiento de entrada. usuarioId null = lo hizo el sistema solo.
async function surtirOrdenCompra(db, orden, usuarioId) {
    await db.query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [orden.cantidad, orden.producto_id]);
    const pr = await db.query('SELECT nombre FROM proveedores WHERE id = $1', [orden.proveedor_id]);
    const proveedor = pr.rows[0] ? pr.rows[0].nombre : null;
    const motivo = usuarioId
        ? `Recepción de pedido ${orden.folio}${proveedor ? ` (${proveedor})` : ''}`
        : `Reabasto automático: pedido ${orden.folio} surtido${proveedor ? ` por ${proveedor}` : ''}`;
    await db.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, usuario_id) VALUES ($1,'entrada',$2,$3,$4)`,
        [orden.producto_id, orden.cantidad, motivo, usuarioId || null]
    );
    const r = await db.query(
        `UPDATE ordenes_compra SET estado = 'recibido', fecha_recibido = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [orden.id]
    );
    return r.rows[0];
}

// Si un producto está en (o cae en) stock crítico, tiene proveedor y no
// tiene ya un pedido abierto, genera uno solo (ver reglas push/pull
// arriba). origen = 'demanda' cuando lo dispara una venta o salida.
// Devuelve el pedido generado, o null si no hizo falta.
async function generarOrdenAutomaticaSiCritico(db, productoId, origen = 'sistema') {
    const cfg = await leerConfigScm(db);
    if (cfg.reabasto_automatico !== 'si') return null;

    const prod = await db.query('SELECT stock, stock_minimo, proveedor_id, restock, activo FROM productos WHERE id = $1', [productoId]);
    if (prod.rows.length === 0) return null;
    const p = prod.rows[0];
    if (!p.activo || !p.proveedor_id || p.stock > p.stock_minimo) return null;
    if (p.restock === 'pull' && origen !== 'demanda') return null;

    const abierta = await db.query(
        `SELECT id FROM ordenes_compra WHERE producto_id = $1 AND estado IN ('pendiente','en_proceso') LIMIT 1`,
        [productoId]
    );
    if (abierta.rows.length > 0) return null;

    const cantidad = Math.max((p.stock_minimo * 2) - p.stock, p.stock_minimo, 1);
    const notas = p.restock === 'pull'
        ? 'Generada automáticamente (pull): la demanda dejó el producto en stock crítico'
        : 'Generada automáticamente (push): el producto llegó a su stock mínimo';
    let orden = await crearOrdenCompra(db, {
        producto_id: productoId, proveedor_id: p.proveedor_id, cantidad, notas, usuario_id: null, estado: 'en_proceso',
    });
    if (cfg.entrega === 'inmediata') orden = await surtirOrdenCompra(db, orden, null);
    return orden;
}

// Barrido periódico: surte los pedidos en proceso cuya fecha ya llegó y
// genera los pedidos push que falten. Corre al arrancar, cada minuto y
// cuando se abre la pantalla de Pedidos.
let reabastoCorriendo = false;
async function procesarReabastoAutomatico() {
    const resultado = { surtidos: [], generados: [] };
    if (reabastoCorriendo) return resultado;
    reabastoCorriendo = true;
    const client = await pool.connect();
    try {
        const cfg = await leerConfigScm(client);
        if (cfg.reabasto_automatico !== 'si') return resultado;
        await client.query('BEGIN');
        const listos = await client.query(
            `SELECT * FROM ordenes_compra
             WHERE estado = 'en_proceso' ${cfg.entrega === 'inmediata' ? '' : 'AND fecha_estimada <= CURRENT_DATE'}
             ORDER BY id FOR UPDATE`
        );
        for (const o of listos.rows) resultado.surtidos.push((await surtirOrdenCompra(client, o, null)).folio);

        const criticos = await client.query(
            `SELECT id FROM productos
             WHERE activo = true AND restock = 'push' AND proveedor_id IS NOT NULL AND stock <= stock_minimo`
        );
        for (const p of criticos.rows) {
            const o = await generarOrdenAutomaticaSiCritico(client, p.id);
            if (o) resultado.generados.push(o.folio);
        }
        await client.query('COMMIT');
        if (resultado.surtidos.length || resultado.generados.length) {
            console.log(`Reabasto automático: ${resultado.generados.length} pedido(s) generado(s), ${resultado.surtidos.length} surtido(s)`);
        }
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Reabasto automático ->', e.message);
    } finally {
        client.release();
        reabastoCorriendo = false;
    }
    return resultado;
}

app.get('/api/admin/scm/config', asyncRoute(async (req, res) => {
    res.json(await leerConfigScm(pool));
}));

app.put('/api/admin/scm/config', asyncRoute(async (req, res) => {
    const { reabasto_automatico, entrega } = req.body;
    if (reabasto_automatico !== undefined && !['si', 'no'].includes(reabasto_automatico)) {
        return res.status(400).json({ message: 'Valor no válido para reabasto automático' });
    }
    if (entrega !== undefined && !['fecha', 'inmediata'].includes(entrega)) {
        return res.status(400).json({ message: 'Valor no válido para la entrega' });
    }
    for (const [clave, valor] of Object.entries({ reabasto_automatico, entrega })) {
        if (valor === undefined) continue;
        await pool.query(
            `INSERT INTO config_scm (clave, valor) VALUES ($1,$2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
            [clave, valor]
        );
    }
    const resultado = await procesarReabastoAutomatico();
    res.json({ config: await leerConfigScm(pool), ...resultado });
}));

// "Ejecutar ahora": corre el barrido sin esperar al siguiente minuto.
app.post('/api/admin/scm/reabasto', asyncRoute(async (req, res) => {
    res.json(await procesarReabastoAutomatico());
}));

// =========================================================
// ADMIN: PEDIDOS SCM
// Vista única de los pedidos que mueven el inventario:
//   - Reposición: pedidos a proveedores (tabla ordenes_compra), entran.
//   - Venta: partidas de pedidos de clientes (tienda y ERP), salen.
// Estados unificados: pendiente, en_proceso, surtido, cancelado.
// =========================================================
app.get('/api/admin/pedidos-scm', asyncRoute(async (req, res) => {
    await procesarReabastoAutomatico();
    const tipo = ['reposicion', 'venta'].includes(req.query.tipo) ? req.query.tipo : '';
    const estado = ['pendiente', 'en_proceso', 'surtido', 'cancelado'].includes(req.query.estado) ? req.query.estado : '';
    const result = await pool.query(`
        SELECT * FROM (
            SELECT 'reposicion' AS tipo, oc.id, oc.folio, oc.fecha_creacion AS fecha, oc.fecha_estimada,
                   oc.fecha_recibido AS fecha_surtido, oc.producto_id, p.nombre AS producto_nombre, oc.cantidad,
                   CASE oc.estado WHEN 'recibido' THEN 'surtido' ELSE oc.estado END AS estado,
                   oc.proveedor_id, pr.nombre AS contraparte, oc.notas, NULL AS origen,
                   COALESCE(oc.notas LIKE 'Generada automáticamente%', false) AS automatico,
                   p.restock, ROUND(COALESCE(p.costo_unitario, 0) * oc.cantidad, 2) AS total,
                   u.nombre AS usuario_nombre
            FROM ordenes_compra oc
            LEFT JOIN productos p ON oc.producto_id = p.id
            LEFT JOIN proveedores pr ON oc.proveedor_id = pr.id
            LEFT JOIN usuarios u ON oc.usuario_id = u.id
            UNION ALL
            SELECT 'venta', pe.id, pe.numero_orden, pe.fecha_pedido, NULL,
                   pe.fecha_entrega, pi.producto_id, p.nombre, pi.cantidad,
                   CASE WHEN pe.estado = 'pendiente' THEN 'pendiente'
                        WHEN pe.estado = 'entregado' THEN 'surtido'
                        WHEN pe.estado = 'cancelado' THEN 'cancelado'
                        ELSE 'en_proceso' END,
                   NULL, c.nombre, NULL, pe.origen, false,
                   p.restock, pi.subtotal, NULL
            FROM pedido_detalle pi
            JOIN pedidos pe ON pi.pedido_id = pe.id
            LEFT JOIN productos p ON pi.producto_id = p.id
            LEFT JOIN clientes c ON pe.cliente_id = c.id
        ) x
        WHERE ($1 = '' OR x.tipo = $1) AND ($2 = '' OR x.estado = $2)
        ORDER BY x.fecha DESC
        LIMIT 300
    `, [tipo, estado]);
    res.json(result.rows);
}));

// =========================================================
// ADMIN: PEDIDOS DE REPOSICIÓN (órdenes de compra a proveedores)
// El lado "de entrada" de la cadena de suministro: al surtirse un
// pedido (a mano o por el reabasto automático) el stock sube y queda
// registrado el movimiento de inventario.
// =========================================================
app.get('/api/admin/ordenes-compra', asyncRoute(async (req, res) => {
    const { estado } = req.query;
    const cond = estado && estado !== 'Todas' ? 'WHERE oc.estado = $1' : '';
    const values = cond ? [estado] : [];
    const result = await pool.query(`
        SELECT oc.*, p.nombre AS producto_nombre, p.stock AS producto_stock, p.stock_minimo,
               pr.nombre AS proveedor_nombre, pr.tiempo_entrega_dias, u.nombre AS usuario_nombre
        FROM ordenes_compra oc
        LEFT JOIN productos p ON oc.producto_id = p.id
        LEFT JOIN proveedores pr ON oc.proveedor_id = pr.id
        LEFT JOIN usuarios u ON oc.usuario_id = u.id
        ${cond}
        ORDER BY oc.fecha_creacion DESC
    `, values);
    res.json(result.rows);
}));

app.post('/api/admin/ordenes-compra', asyncRoute(async (req, res) => {
    const { producto_id, proveedor_id, cantidad, notas, fecha_estimada } = req.body;
    if (!producto_id || !cantidad || cantidad < 1) {
        return res.status(400).json({ message: 'Producto y cantidad son obligatorios' });
    }
    const prod = await pool.query('SELECT proveedor_id FROM productos WHERE id = $1', [producto_id]);
    if (prod.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    const proveedorFinal = proveedor_id || prod.rows[0].proveedor_id;
    if (!proveedorFinal) return res.status(400).json({ message: 'Este producto no tiene proveedor asignado; elige uno' });

    const orden = await crearOrdenCompra(pool, {
        producto_id, proveedor_id: proveedorFinal, cantidad, notas, usuario_id: req.usuario.id, fecha_estimada,
    });
    res.status(201).json(orden);
}));

// Editar un pedido de reposición que todavía no se surte ni se cancela.
app.put('/api/admin/ordenes-compra/:id', asyncRoute(async (req, res) => {
    const { cantidad, proveedor_id, fecha_estimada, notas } = req.body;
    if (cantidad !== undefined && (!Number.isInteger(Number(cantidad)) || Number(cantidad) < 1)) {
        return res.status(400).json({ message: 'La cantidad debe ser mayor a 0' });
    }
    const oc = await pool.query('SELECT estado FROM ordenes_compra WHERE id = $1', [req.params.id]);
    if (oc.rows.length === 0) return res.status(404).json({ message: 'Pedido no encontrado' });
    if (!['pendiente', 'en_proceso'].includes(oc.rows[0].estado)) {
        return res.status(400).json({ message: 'Solo se pueden editar pedidos pendientes o en proceso' });
    }
    const result = await pool.query(
        `UPDATE ordenes_compra SET
            cantidad = COALESCE($1, cantidad), proveedor_id = COALESCE($2, proveedor_id),
            fecha_estimada = COALESCE($3::date, fecha_estimada), notas = COALESCE($4, notas)
         WHERE id = $5 RETURNING *`,
        [cantidad || null, proveedor_id || null, fecha_estimada || null, notas ?? null, req.params.id]
    );
    res.json(result.rows[0]);
}));

app.put('/api/admin/ordenes-compra/:id/estado', asyncRoute(async (req, res) => {
    // 'surtido' es el nombre que usa el documento; internamente es 'recibido'.
    const estado = req.body.estado === 'surtido' ? 'recibido' : req.body.estado;
    if (!['pendiente', 'en_proceso', 'recibido', 'cancelado'].includes(estado)) {
        return res.status(400).json({ message: 'Estado no válido' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const oc = await client.query('SELECT * FROM ordenes_compra WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (oc.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Pedido no encontrado' }); }
        const orden = oc.rows[0];
        if (orden.estado === 'recibido' || orden.estado === 'cancelado') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Este pedido ya está ${orden.estado === 'recibido' ? 'surtido' : 'cancelado'} y no se puede modificar` });
        }

        let final;
        if (estado === 'recibido') {
            final = await surtirOrdenCompra(client, orden, req.usuario.id);
            // Si lo recibido no alcanzó para salir de stock crítico, se pide otra vez.
            await generarOrdenAutomaticaSiCritico(client, orden.producto_id);
        } else {
            const r = await client.query('UPDATE ordenes_compra SET estado = $1 WHERE id = $2 RETURNING *', [estado, req.params.id]);
            final = r.rows[0];
        }
        await client.query('COMMIT');
        res.json(final);
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

// =========================================================
// ADMIN: PANEL SCM — nivel de madurez y métricas de logística
// Todo calculado a partir de datos reales (nada fijo a mano):
// entre más de estos puntos estén realmente en uso, más avanzado
// el nivel — así el nivel sube solo conforme se usa el sistema.
// =========================================================
app.get('/api/admin/scm/resumen', asyncRoute(async (req, res) => {
    const stats = await pool.query(`
        SELECT
            (SELECT COUNT(*) FROM productos WHERE activo = true) AS total_productos,
            (SELECT COUNT(*) FROM proveedores WHERE activo = true) AS total_proveedores,
            (SELECT COUNT(*) FROM ordenes_compra WHERE estado IN ('pendiente','en_proceso')) AS ordenes_pendientes,
            (SELECT COUNT(*) FROM productos WHERE activo = true AND stock <= stock_minimo) AS stock_bajo
    `);

    const masVendidos = await pool.query(`
        SELECT p.id, p.nombre, COALESCE(SUM(pi.cantidad) FILTER (WHERE pe.estado <> 'cancelado'), 0) AS unidades_vendidas
        FROM productos p
        LEFT JOIN pedido_detalle pi ON pi.producto_id = p.id
        LEFT JOIN pedidos pe ON pi.pedido_id = pe.id
        WHERE p.activo = true
        GROUP BY p.id ORDER BY unidades_vendidas DESC LIMIT 6
    `);

    // (el stock se suma aparte: con el JOIN a las partidas se contaría una
    // vez por cada venta del producto)
    const rotacion = await pool.query(`
        SELECT
            (SELECT COALESCE(SUM(pi.cantidad), 0) FROM pedido_detalle pi
               JOIN pedidos pe ON pi.pedido_id = pe.id
               JOIN productos p ON pi.producto_id = p.id
              WHERE pe.estado <> 'cancelado' AND p.activo = true) AS vendidas,
            (SELECT COALESCE(SUM(stock), 0) FROM productos WHERE activo = true) AS stock_actual
    `);
    const vendidas = Number(rotacion.rows[0].vendidas);
    const stockActual = Number(rotacion.rows[0].stock_actual);
    const rotacionPct = (vendidas + stockActual) > 0 ? Math.round((vendidas / (vendidas + stockActual)) * 100) : 0;

    // Push/pull de todo el catálogo activo (la vista por categoría, solo
    // de Componentes, ya vive en Inventario — aquí es el panorama completo).
    // Se calculan dos estadísticas distintas: cantidad de productos y el
    // valor de inventario que representa cada estrategia (stock x precio).
    const pushPull = await pool.query(`
        SELECT restock, COUNT(*)::int AS total, COALESCE(SUM(stock * precio), 0) AS valor
        FROM productos WHERE activo = true GROUP BY restock
    `);
    const push = Number(pushPull.rows.find((r) => r.restock === 'push')?.total || 0);
    const pull = Number(pushPull.rows.find((r) => r.restock === 'pull')?.total || 0);
    const valorPush = Number(pushPull.rows.find((r) => r.restock === 'push')?.valor || 0);
    const valorPull = Number(pushPull.rows.find((r) => r.restock === 'pull')?.valor || 0);

    // Checklist de madurez: cada punto se calcula de datos reales, no se
    // marca a mano, así que el nivel avanza solo conforme se usa el sistema.
    const conProveedor = await pool.query(`SELECT COUNT(*)::int AS n FROM productos WHERE activo = true AND proveedor_id IS NOT NULL`);
    const movimientos = await pool.query(`SELECT COUNT(*)::int AS n FROM movimientos_inventario`);
    const ordenesUsadas = await pool.query(`SELECT COUNT(*)::int AS n FROM ordenes_compra`);

    const checklist = [
        { clave: 'proveedores', etiqueta: 'Productos con proveedor asignado', cumplido: conProveedor.rows[0].n > 0 },
        { clave: 'movimientos', etiqueta: 'Movimientos de inventario registrados', cumplido: movimientos.rows[0].n > 0 },
        { clave: 'estrategia', etiqueta: 'Estrategia push y pull en uso (no solo una)', cumplido: push > 0 && pull > 0 },
        { clave: 'ordenes', etiqueta: 'Órdenes de compra generadas', cumplido: ordenesUsadas.rows[0].n > 0 },
        { clave: 'reportes', etiqueta: 'Reportes con datos reales de ventas', cumplido: vendidas > 0 },
    ];
    const cumplidos = checklist.filter((c) => c.cumplido).length;
    const est = await estadoNivelScm(cumplidos);
    const nivel = est.nivel;

    res.json({
        stats: stats.rows[0],
        mas_vendidos: masVendidos.rows,
        rotacion_pct: rotacionPct,
        push_pull: { push, pull, valor_push: valorPush, valor_pull: valorPull },
        madurez: { nivel, checklist, cumplidos, total: checklist.length, modo: est.modo, nivel_calculado: est.nivel_calculado, nota: est.nota },
    });
}));

// nivel_scm (campo global, en config_scm): en modo automático es el nivel
// calculado del checklist; el administrador lo puede fijar a mano.
const NIVELES_SCM = ['inicial', 'en_desarrollo', 'optimizado'];
async function estadoNivelScm(cumplidos) {
    const calculado = cumplidos <= 1 ? 'inicial' : cumplidos <= 3 ? 'en_desarrollo' : 'optimizado';
    const cfg = await leerConfigScm(pool);
    const modo = cfg.nivel_scm_modo === 'manual' && NIVELES_SCM.includes(cfg.nivel_scm) ? 'manual' : 'auto';
    if (modo === 'auto' && cfg.nivel_scm !== calculado) {
        await pool.query(`INSERT INTO config_scm (clave, valor) VALUES ('nivel_scm', $1)
                          ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [calculado]);
    }
    return { modo, nivel: modo === 'manual' ? cfg.nivel_scm : calculado, nivel_calculado: calculado, nota: modo === 'manual' ? (cfg.nivel_scm_nota || null) : null };
}

// GET /scm/estado: nivel de madurez SCM con su checklist.
app.get('/api/admin/scm/estado', asyncRoute(async (req, res) => {
    const r = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM productos WHERE activo = true AND proveedor_id IS NOT NULL) AS con_proveedor,
          (SELECT COUNT(*)::int FROM movimientos_inventario) AS movimientos,
          (SELECT COUNT(*)::int FROM productos WHERE activo = true AND restock = 'push') AS push,
          (SELECT COUNT(*)::int FROM productos WHERE activo = true AND restock = 'pull') AS pull,
          (SELECT COUNT(*)::int FROM ordenes_compra) AS ordenes,
          (SELECT COALESCE(SUM(pi.cantidad),0)::int FROM pedido_detalle pi JOIN pedidos pe ON pe.id = pi.pedido_id
            WHERE pe.estado <> 'cancelado') AS vendidas`);
    const d = r.rows[0];
    const checklist = [
        { clave: 'proveedores', etiqueta: 'Productos con proveedor asignado', cumplido: d.con_proveedor > 0 },
        { clave: 'movimientos', etiqueta: 'Movimientos de inventario registrados', cumplido: d.movimientos > 0 },
        { clave: 'estrategia', etiqueta: 'Estrategia push y pull en uso (no solo una)', cumplido: d.push > 0 && d.pull > 0 },
        { clave: 'ordenes', etiqueta: 'Órdenes de compra generadas', cumplido: d.ordenes > 0 },
        { clave: 'reportes', etiqueta: 'Reportes con datos reales de ventas', cumplido: d.vendidas > 0 },
    ];
    const cumplidos = checklist.filter((c) => c.cumplido).length;
    res.json({ ...(await estadoNivelScm(cumplidos)), checklist, cumplidos, total: checklist.length });
}));

// PUT /scm/nivel: { modo: 'manual', nivel: 'inicial'|'en_desarrollo'|'optimizado', nota }
// o { modo: 'auto' } para regresar al cálculo automático. Solo admin.
app.put('/api/admin/scm/nivel', requireAdmin, asyncRoute(async (req, res) => {
    const modo = req.body.modo === 'auto' ? 'auto' : 'manual';
    const nivel = String(req.body.nivel || '').toLowerCase().replace(' ', '_');
    if (modo === 'manual' && !NIVELES_SCM.includes(nivel)) {
        return res.status(400).json({ message: 'Nivel no válido (inicial, en_desarrollo u optimizado)' });
    }
    const filas = modo === 'manual'
        ? [['nivel_scm_modo', 'manual'], ['nivel_scm', nivel], ['nivel_scm_nota', String(req.body.nota || '').slice(0, 40)]]
        : [['nivel_scm_modo', 'auto']];
    for (const [clave, valor] of filas) {
        await pool.query(`INSERT INTO config_scm (clave, valor) VALUES ($1, $2)
                          ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [clave, valor]);
    }
    res.json({ message: modo === 'manual' ? `Nivel SCM fijado en "${nivel}"` : 'Nivel SCM en cálculo automático', modo, nivel: modo === 'manual' ? nivel : undefined });
}));

// Reportes SCM: rotación por producto (alta / media / baja) y la
// comparativa mensual de pedidos de reposición push vs. pull.
app.get('/api/admin/scm/reportes', asyncRoute(async (req, res) => {
    // Rotación = unidades vendidas / (vendidas + stock actual).
    // Alta >= 15%, media >= 5%, baja < 5%.
    const rot = await pool.query(`
        SELECT p.id, p.nombre, p.stock,
               COALESCE(SUM(pi.cantidad) FILTER (WHERE pe.estado <> 'cancelado'), 0)::int AS vendidas
        FROM productos p
        LEFT JOIN pedido_detalle pi ON pi.producto_id = p.id
        LEFT JOIN pedidos pe ON pi.pedido_id = pe.id
        WHERE p.activo = true
        GROUP BY p.id
    `);
    const rotacion = { alta: [], media: [], baja: [] };
    rot.rows.forEach((r) => {
        const base = r.vendidas + r.stock;
        const pct = base > 0 ? r.vendidas / base : 0;
        const nivel = pct >= 0.15 ? 'alta' : pct >= 0.05 ? 'media' : 'baja';
        rotacion[nivel].push({ nombre: r.nombre, pct: Math.round(pct * 100) });
    });

    // Pedidos de reposición por mes (últimos 6), según la estrategia del producto.
    const mensual = await pool.query(`
        WITH meses AS (
            SELECT to_char(m, 'YYYY-MM') AS mes
            FROM generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
                                 date_trunc('month', CURRENT_DATE), INTERVAL '1 month') m
        )
        SELECT meses.mes,
               COUNT(oc.id) FILTER (WHERE p.restock = 'push')::int AS push,
               COUNT(oc.id) FILTER (WHERE p.restock = 'pull')::int AS pull,
               COALESCE(SUM(oc.cantidad) FILTER (WHERE p.restock = 'push'), 0)::int AS unidades_push,
               COALESCE(SUM(oc.cantidad) FILTER (WHERE p.restock = 'pull'), 0)::int AS unidades_pull
        FROM meses
        LEFT JOIN ordenes_compra oc ON to_char(oc.fecha_creacion, 'YYYY-MM') = meses.mes AND oc.estado <> 'cancelado'
        LEFT JOIN productos p ON oc.producto_id = p.id
        GROUP BY meses.mes ORDER BY meses.mes
    `);

    const pedidos = await pool.query(`
        SELECT
            COUNT(*) FILTER (WHERE estado = 'en_proceso')::int AS en_proceso,
            COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
            COUNT(*) FILTER (WHERE estado = 'recibido')::int AS surtidos,
            COUNT(*) FILTER (WHERE notas LIKE 'Generada automáticamente%')::int AS automaticos
        FROM ordenes_compra
    `);

    res.json({ rotacion, mensual: mensual.rows, pedidos: pedidos.rows[0] });
}));

app.get('/api/proveedores', requireUsuario, asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT * FROM proveedores WHERE activo = true ORDER BY nombre ASC');
    res.json(result.rows);
}));

// =========================================================
// ADMIN: PROVEEDORES
// Base de la estrategia de reabastecimiento: cada proveedor
// tiene un tiempo de entrega (días) que, junto con el stock
// mínimo del producto, define qué tan pronto hay que reordenar.
// =========================================================
app.get('/api/admin/proveedores', asyncRoute(async (req, res) => {
    const result = await pool.query(`
        SELECT pr.*, COUNT(p.id)::int AS productos_asociados
        FROM proveedores pr
        LEFT JOIN productos p ON p.proveedor_id = pr.id AND p.activo = true
        GROUP BY pr.id
        ORDER BY pr.nombre ASC
    `);
    res.json(result.rows);
}));

app.post('/api/admin/proveedores', asyncRoute(async (req, res) => {
    const { nombre, contacto, email, telefono, direccion, tiempo_entrega_dias } = req.body;
    if (!nombre) return res.status(400).json({ message: 'El nombre es obligatorio' });
    const result = await pool.query(
        `INSERT INTO proveedores (nombre, contacto, email, telefono, direccion, tiempo_entrega_dias)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [nombre, contacto || null, email || null, telefono || null, direccion || null, tiempo_entrega_dias || 7]
    );
    res.status(201).json(result.rows[0]);
}));

app.put('/api/admin/proveedores/:id', asyncRoute(async (req, res) => {
    const { nombre, contacto, email, telefono, direccion, tiempo_entrega_dias, activo } = req.body;
    const result = await pool.query(
        `UPDATE proveedores SET
            nombre = COALESCE($1, nombre), contacto = COALESCE($2, contacto),
            email = COALESCE($3, email), telefono = COALESCE($4, telefono),
            tiempo_entrega_dias = COALESCE($5, tiempo_entrega_dias), activo = COALESCE($6, activo),
            direccion = COALESCE($7, direccion)
         WHERE id = $8 RETURNING *`,
        [nombre, contacto, email, telefono, tiempo_entrega_dias, activo, direccion, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Proveedor no encontrado' });
    res.json(result.rows[0]);
}));

app.delete('/api/admin/proveedores/:id', asyncRoute(async (req, res) => {
    const enUso = await pool.query('SELECT id FROM productos WHERE proveedor_id = $1 LIMIT 1', [req.params.id]);
    if (enUso.rows.length > 0) {
        await pool.query('UPDATE proveedores SET activo = false WHERE id = $1', [req.params.id]);
        return res.json({ message: 'El proveedor abastece productos existentes; se desactivó en lugar de eliminarlo' });
    }
    await pool.query('DELETE FROM proveedores WHERE id = $1', [req.params.id]);
    res.json({ message: 'Proveedor eliminado' });
}));

// =========================================================
// ADMIN: PEDIDOS
// =========================================================

app.get('/api/admin/pedidos', asyncRoute(async (req, res) => {
    const { estado } = req.query;
    const cond = estado && estado !== 'Todos' ? 'WHERE p.estado = $1' : '';
    const values = estado && estado !== 'Todos' ? [estado] : [];
    const result = await pool.query(`
        SELECT p.*, COALESCE(c.nombre, 'Cliente eliminado') AS cliente_nombre, c.correo AS cliente_correo
        FROM pedidos p LEFT JOIN clientes c ON p.cliente_id = c.id
        ${cond} ORDER BY p.fecha_pedido DESC
    `, values);
    res.json(result.rows);
}));

// Detalle completo de un pedido para gestionarlo desde cualquier panel
// (CRM, ERP o SCM): partidas, garantías, datos del cliente (CRM) y los
// movimientos de inventario que generó (SCM).
const detallePedido = asyncRoute(async (req, res) => {
    const p = await pool.query(`
        SELECT p.*, u.nombre AS registrado_por,
               COALESCE(c.nombre, 'Cliente eliminado') AS cliente_nombre, c.correo AS cliente_correo, c.telefono AS cliente_telefono,
               c.empresa AS cliente_empresa, c.ciudad AS cliente_ciudad, c.etapa_crm AS cliente_etapa, c.puntos AS cliente_puntos,
               COALESCE(m.total_compras, 0)::int AS cliente_compras, COALESCE(m.valor_total_compras, 0) AS cliente_valor
        FROM pedidos p
        LEFT JOIN clientes c ON p.cliente_id = c.id
        LEFT JOIN metricas_clientes m ON m.cliente_id = c.id
        LEFT JOIN usuarios u ON p.vendedor_id = u.id
        WHERE p.id = $1`, [req.params.id]);
    if (p.rows.length === 0) return res.status(404).json({ message: 'Pedido no encontrado' });
    const pedido = p.rows[0];
    const items = await pool.query(
        `SELECT pi.*, pr.nombre, pr.stock, pr.stock_minimo FROM pedido_detalle pi JOIN productos pr ON pi.producto_id = pr.id WHERE pi.pedido_id = $1`,
        [pedido.id]
    );
    const garantias = await pool.query(
        `SELECT g.folio, g.plan, g.meses, g.estado, pr.nombre AS producto FROM garantias g
         LEFT JOIN productos pr ON pr.id = g.producto_id WHERE g.pedido_id = $1 ORDER BY g.id`, [pedido.id]
    );
    // Movimientos que este pedido generó (la venta lleva el folio en el
    // motivo; las de la tienda antiguas dicen solo "Venta en línea").
    const movimientos = await pool.query(`
        SELECT m.fecha, m.tipo, m.cantidad, m.motivo, pr.nombre AS producto_nombre, us.nombre AS usuario_nombre
        FROM movimientos_inventario m
        JOIN productos pr ON pr.id = m.producto_id
        LEFT JOIN usuarios us ON us.id = m.usuario_id
        WHERE m.motivo LIKE '%' || $1 || '%'
        ORDER BY m.fecha, m.id`, [pedido.numero_orden]);
    const procesos = await pool.query(`
        SELECT pe.fecha, pe.paso, pe.descripcion, pe.automatico, us.nombre AS usuario_nombre
        FROM procesos_erp pe LEFT JOIN usuarios us ON us.id = pe.usuario_id
        WHERE pe.pedido_id = $1 ORDER BY pe.fecha, pe.id`, [pedido.id]);
    res.json({ ...pedido, items: items.rows, garantias: garantias.rows, movimientos: movimientos.rows, procesos: procesos.rows });
});
app.get('/api/admin/pedidos/:id', detallePedido);
app.get('/api/admin/erp/ordenes/:id', detallePedido);

const cambiarEstadoPedido = asyncRoute(async (req, res) => {
    const { estado } = req.body;
    const validos = ['pendiente', 'confirmado', 'procesando', 'enviado', 'entregado', 'cancelado'];
    if (!validos.includes(estado)) return res.status(400).json({ message: 'Estado no válido' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pr = await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (pr.rows.length === 0) throw Object.assign(new Error('Pedido no encontrado'), { status: 404 });
        const pedido = pr.rows[0];
        if (pedido.estado === estado) throw new Error(`El pedido ya está en "${estado}"`);
        if (pedido.estado === 'cancelado') throw new Error('El pedido está cancelado; la cancelación es definitiva');

        // Cancelar desde el panel deshace stock, garantías, puntos y métricas
        // (igual que cuando cancela el cliente).
        if (estado === 'cancelado') {
            const r = await cancelarPedido(client, pedido, { usuarioId: req.usuario.id });
            await registrarProceso(client, pedido.id, 'cancelacion',
                `Orden cancelada: stock regresado al inventario${r.canjeados ? `, ${r.canjeados} puntos devueltos` : ''}${r.ganados ? `, ${r.ganados} puntos retirados` : ''}`,
                { usuarioId: req.usuario.id, automatico: false });
            await client.query('COMMIT');
            return res.json({
                message: `Pedido cancelado: stock regresado (${r.productos} producto${r.productos === 1 ? '' : 's'})` +
                    (r.canjeados ? `, ${r.canjeados} puntos devueltos` : '') + (r.ganados ? `, ${r.ganados} puntos retirados` : ''),
            });
        }
        // "Pendiente" significa esperando pago: no se regresa ahí, y no se
        // avanza sin cobrar (para eso está "Marcar pago recibido").
        if (estado === 'pendiente') throw new Error('Un pedido no puede regresar a "pendiente" una vez confirmado');
        if (pedido.pago_estado !== 'pagado') throw new Error('Primero registra el pago del pedido ("Marcar pago recibido")');

        const campoFecha = estado === 'enviado' ? ', fecha_envio = COALESCE(fecha_envio, CURRENT_TIMESTAMP)'
            : estado === 'entregado' ? ', fecha_entrega = CURRENT_TIMESTAMP'
            : estado === 'confirmado' ? ', fecha_confirmacion = COALESCE(fecha_confirmacion, CURRENT_TIMESTAMP)' : '';
        const result = await client.query(
            `UPDATE pedidos SET estado = $1 ${campoFecha} WHERE id = $2 RETURNING *`,
            [estado, req.params.id]
        );
        await registrarProceso(client, pedido.id, 'estado', `Estado: ${pedido.estado} → ${estado}`,
            { usuarioId: req.usuario.id, automatico: false });
        await client.query('COMMIT');
        res.json({ message: 'Estado actualizado', pedido: result.rows[0] });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(e.status || 400).json({ message: seg.mensajeSeguro(e) });
    } finally {
        client.release();
    }
});
app.put('/api/admin/pedidos/:id/estado', cambiarEstadoPedido);
app.put('/api/admin/erp/ordenes/:id/estado', cambiarEstadoPedido);

// Registrar el pago de un pedido SPEI / en tienda: lo marca como pagado,
// lo pasa a 'confirmado' y recién ahí otorga los puntos y actualiza métricas.
app.post('/api/admin/pedidos/:id/registrar-pago', asyncRoute(async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pr = await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (pr.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Pedido no encontrado' }); }
        const pedido = pr.rows[0];
        if (pedido.pago_estado === 'pagado') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Este pedido ya está pagado' }); }
        if (pedido.estado === 'cancelado') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'El pedido está cancelado' }); }

        await client.query(
            `UPDATE pedidos SET pago_estado = 'pagado',
                 estado = CASE WHEN estado = 'pendiente' THEN 'confirmado' ELSE estado END,
                 fecha_confirmacion = COALESCE(fecha_confirmacion, CURRENT_TIMESTAMP)
             WHERE id = $1`,
            [req.params.id]
        );
        // Los pedidos con pago pendiente nacen en 'pendiente'; cuando salen de
        // ahí (aquí mismo o antes, moviéndolos en el pipeline) el trigger
        // trg_pedido_metricas ya suma la compra. Aquí solo se dan los puntos.
        await client.query(`UPDATE pagos SET estado = 'aprobado', fecha_confirmacion = CURRENT_TIMESTAMP WHERE pedido_id = $1`, [pedido.id]);
        const puntos_ganados = await aplicarCobroPedido(client, pedido, { metricas: false });
        await registrarProceso(client, pedido.id, 'pago',
            `Pago registrado (${pedido.metodo_pago || 'sin método'}); orden confirmada${puntos_ganados ? `, +${puntos_ganados} puntos al cliente` : ''}`,
            { usuarioId: req.usuario.id, automatico: false });
        await client.query('COMMIT');
        res.json({ message: 'Pago registrado. Pedido confirmado.', puntos_ganados });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

// =========================================================
// ERP (Etapa 3): órdenes de clientes capturadas por el equipo
// Une los otros dos módulos: el cliente sale del CRM, los
// productos y el stock del SCM. Al confirmar una orden se
// valida y descuenta el stock, se registran los movimientos
// de inventario, se generan órdenes de compra si algo cae en
// stock crítico y queda guardada en el historial del cliente.
// =========================================================

// Capturar órdenes ERP requiere el permiso 'orden-nueva' (permisos.js):
// hoy lo tienen Administrador y Ventas.

const METODOS_ERP = {
    efectivo:      { texto: 'Efectivo en mostrador',  inmediato: true },
    tarjeta:       { texto: 'Tarjeta en mostrador',   inmediato: true },
    transferencia: { texto: 'Transferencia bancaria', inmediato: false },
};

// Ventas de los últimos N meses (incluido el actual), una fila por mes
// aunque no haya ventas, separadas por canal.
async function ventasPorMes(meses = 6) {
    const r = await pool.query(`
        SELECT TO_CHAR(m.mes, 'YYYY-MM') AS mes,
               COALESCE(SUM(p.total) FILTER (WHERE p.origen = 'en_linea'), 0) AS en_linea,
               COALESCE(SUM(p.total) FILTER (WHERE p.origen = 'erp'), 0)      AS erp,
               COUNT(p.id) AS ordenes
        FROM generate_series(DATE_TRUNC('month', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 month',
                             DATE_TRUNC('month', CURRENT_DATE), INTERVAL '1 month') AS m(mes)
        LEFT JOIN pedidos p ON DATE_TRUNC('month', p.fecha_pedido) = m.mes
                           AND p.estado <> 'cancelado' AND p.pago_estado = 'pagado'
        GROUP BY m.mes ORDER BY m.mes
    `, [meses]);
    return r.rows.map((x) => ({ mes: x.mes, en_linea: Number(x.en_linea), erp: Number(x.erp), ordenes: Number(x.ordenes) }));
}

async function masVendidosERP(limite = 5, desde = null, hasta = null) {
    const r = await pool.query(`
        SELECT pr.id, pr.nombre, SUM(pi.cantidad)::int AS unidades, SUM(pi.subtotal) AS importe
        FROM pedido_detalle pi
        JOIN pedidos p ON pi.pedido_id = p.id
        JOIN productos pr ON pi.producto_id = pr.id
        WHERE p.estado <> 'cancelado'
          AND ($2::date IS NULL OR p.fecha_pedido >= $2::date)
          AND ($3::date IS NULL OR p.fecha_pedido < $3::date + INTERVAL '1 day')
        GROUP BY pr.id ORDER BY unidades DESC, importe DESC LIMIT $1
    `, [limite, desde, hasta]);
    return r.rows;
}

app.get('/api/admin/erp/resumen', asyncRoute(async (req, res) => {
    const k = await pool.query(`
        SELECT
            (SELECT COUNT(*) FROM clientes WHERE estado_cliente = 'activo' AND etapa_crm IN ('Activo','Frecuente'))::int AS clientes_activos,
            (SELECT COUNT(*) FROM pedidos WHERE estado <> 'cancelado')::int AS ordenes_clientes,
            (SELECT COUNT(*) FROM pedidos WHERE estado <> 'cancelado' AND origen = 'erp')::int AS ordenes_erp,
            (SELECT COUNT(*) FROM pedidos WHERE estado <> 'cancelado' AND pago_estado = 'pendiente')::int AS pagos_pendientes,
            (SELECT COALESCE(SUM(total),0) FROM pedidos WHERE estado <> 'cancelado' AND pago_estado = 'pagado') AS ventas_totales,
            (SELECT COALESCE(SUM(pi.cantidad),0) FROM pedido_detalle pi JOIN pedidos p ON pi.pedido_id = p.id WHERE p.estado <> 'cancelado')::int AS productos_vendidos,
            (SELECT COUNT(*) FROM productos WHERE activo = true)::int AS productos_activos,
            (SELECT COUNT(*) FROM productos WHERE activo = true AND stock <= stock_minimo)::int AS stock_critico,
            (SELECT COUNT(*) FROM proveedores WHERE activo = true)::int AS proveedores,
            (SELECT COUNT(*) FROM ordenes_compra WHERE estado IN ('pendiente','en_proceso'))::int AS ordenes_compra_abiertas,
            (SELECT COUNT(*) FROM clientes)::int AS clientes_total,
            (SELECT COUNT(*) FROM interacciones)::int AS interacciones
    `);
    const ultimas = await pool.query(`
        SELECT p.id, p.numero_orden, p.fecha_pedido, p.total, p.estado, p.pago_estado, p.origen, COALESCE(c.nombre, 'Cliente eliminado') AS cliente_nombre
        FROM pedidos p LEFT JOIN clientes c ON p.cliente_id = c.id
        ORDER BY p.fecha_pedido DESC LIMIT 5
    `);
    const kp = k.rows[0];
    res.json({
        kpis: { ...kp, ventas_totales: Number(kp.ventas_totales) },
        ventas_por_mes: await ventasPorMes(6),
        mas_vendidos: await masVendidosERP(5),
        ultimas_ordenes: ultimas.rows,
    });
}));

// Listado de órdenes de clientes (de ambos canales) con búsqueda.
app.get('/api/admin/erp/ordenes', asyncRoute(async (req, res) => {
    const { busqueda, estado, origen } = req.query;
    const clienteId = Number(req.query.cliente_id) || null;
    const productoId = Number(req.query.producto_id) || null;
    const cond = [];
    const values = [];
    if (busqueda) { values.push(`%${busqueda}%`); cond.push(`(p.numero_orden ILIKE $${values.length} OR c.nombre ILIKE $${values.length} OR c.correo ILIKE $${values.length})`); }
    if (clienteId) { values.push(clienteId); cond.push(`p.cliente_id = $${values.length}`); }
    if (productoId) { values.push(productoId); cond.push(`EXISTS (SELECT 1 FROM pedido_detalle pi WHERE pi.pedido_id = p.id AND pi.producto_id = $${values.length})`); }
    if (estado && estado !== 'Todos') { values.push(estado); cond.push(`p.estado = $${values.length}`); }
    if (origen && origen !== 'Todos') { values.push(origen); cond.push(`p.origen = $${values.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(`
        SELECT p.id, p.numero_orden, p.fecha_pedido, p.subtotal, p.total, p.estado, p.pago_estado, p.metodo_pago, p.origen,
               c.id AS cliente_id, COALESCE(c.nombre, 'Cliente eliminado') AS cliente_nombre, c.correo AS cliente_correo, c.empresa AS cliente_empresa,
               u.nombre AS registrado_por,
               (SELECT COALESCE(SUM(cantidad),0)::int FROM pedido_detalle WHERE pedido_id = p.id) AS piezas
        FROM pedidos p
        LEFT JOIN clientes c ON p.cliente_id = c.id
        LEFT JOIN usuarios u ON p.vendedor_id = u.id
        ${where}
        ORDER BY p.fecha_pedido DESC
    `, values);
    res.json(r.rows);
}));

// Clientes del CRM para el paso 1 de "Nueva orden".
app.get('/api/admin/erp/clientes', asyncRoute(async (req, res) => {
    const q = (req.query.busqueda || '').trim();
    const soloId = Number(req.query.id) || null;
    const r = await pool.query(`
        SELECT c.id, c.nombre, c.correo, c.telefono, c.empresa, c.ciudad, c.etapa_crm, c.puntos,
               COALESCE(m.total_compras, 0) AS total_compras,
               (SELECT CONCAT_WS(', ', d.calle, d.ciudad, d.estado) FROM direcciones d
                 WHERE d.cliente_id = c.id ORDER BY d.predeterminada DESC, d.id LIMIT 1) AS direccion
        FROM clientes c LEFT JOIN metricas_clientes m ON m.cliente_id = c.id
        WHERE c.estado_cliente = 'activo'
          AND ($1 = '' OR c.nombre ILIKE '%' || $1 || '%' OR c.correo ILIKE '%' || $1 || '%' OR c.empresa ILIKE '%' || $1 || '%')
          AND ($2::int IS NULL OR c.id = $2::int)
        ORDER BY c.nombre LIMIT 30
    `, [q, soloId]);
    res.json(r.rows);
}));

// Consulta de clientes desde el ERP (sin ir al CRM): listado con lo que
// cada uno le ha comprado a la empresa por los dos canales.
app.get('/api/admin/erp/clientes-consulta', asyncRoute(async (req, res) => {
    const q = (req.query.busqueda || '').trim();
    const etapa = ['Prospecto', 'Activo', 'Frecuente', 'Inactivo'].includes(req.query.etapa) ? req.query.etapa : null;
    const r = await pool.query(`
        SELECT c.id, c.nombre, c.correo, c.telefono, c.empresa, c.ciudad, c.etapa_crm, c.estado_cliente, c.puntos, c.fecha_registro,
               COUNT(p.id) FILTER (WHERE p.estado <> 'cancelado')::int AS ordenes,
               COUNT(p.id) FILTER (WHERE p.estado <> 'cancelado' AND p.origen = 'erp')::int AS ordenes_erp,
               COALESCE(SUM(p.total) FILTER (WHERE p.estado <> 'cancelado' AND p.pago_estado = 'pagado'), 0) AS total_cobrado,
               COALESCE(SUM(p.total) FILTER (WHERE p.estado <> 'cancelado' AND p.pago_estado = 'pendiente'), 0) AS por_cobrar,
               MAX(p.fecha_pedido) FILTER (WHERE p.estado <> 'cancelado') AS ultima_orden
        FROM clientes c LEFT JOIN pedidos p ON p.cliente_id = c.id
        WHERE ($1 = '' OR c.nombre ILIKE '%' || $1 || '%' OR c.correo ILIKE '%' || $1 || '%' OR c.empresa ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR c.etapa_crm = $2)
        GROUP BY c.id
        ORDER BY total_cobrado DESC, c.nombre`, [q, etapa]);
    res.json(r.rows.map((x) => ({ ...x, total_cobrado: Number(x.total_cobrado), por_cobrar: Number(x.por_cobrar) })));
}));

// Ficha de un cliente para el ERP: datos del CRM, métricas y sus órdenes.
app.get('/api/admin/erp/clientes-consulta/:id', asyncRoute(async (req, res) => {
    const c = await pool.query(`
        SELECT c.id, c.nombre, c.correo, c.telefono, c.empresa, c.ciudad, c.estado, c.etapa_crm, c.estado_cliente,
               c.puntos, c.fecha_registro,
               COALESCE(m.total_compras, 0)::int AS total_compras, COALESCE(m.valor_total_compras, 0) AS valor_total,
               COALESCE(m.ticket_promedio, 0) AS ticket_promedio,
               (SELECT CONCAT_WS(', ', d.calle, d.ciudad, d.estado) FROM direcciones d
                 WHERE d.cliente_id = c.id ORDER BY d.predeterminada DESC, d.id LIMIT 1) AS direccion,
               (SELECT MAX(i.fecha) FROM interacciones i WHERE i.cliente_id = c.id) AS ultima_interaccion
        FROM clientes c LEFT JOIN metricas_clientes m ON m.cliente_id = c.id
        WHERE c.id = $1`, [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });
    const ordenes = await pool.query(`
        SELECT p.id, p.numero_orden, p.fecha_pedido, p.total, p.estado, p.pago_estado, p.origen,
               (SELECT COALESCE(SUM(cantidad),0)::int FROM pedido_detalle WHERE pedido_id = p.id) AS piezas
        FROM pedidos p WHERE p.cliente_id = $1 ORDER BY p.fecha_pedido DESC`, [req.params.id]);
    const masComprados = await pool.query(`
        SELECT pr.nombre, SUM(pi.cantidad)::int AS unidades
        FROM pedido_detalle pi JOIN pedidos p ON p.id = pi.pedido_id JOIN productos pr ON pr.id = pi.producto_id
        WHERE p.cliente_id = $1 AND p.estado <> 'cancelado'
        GROUP BY pr.nombre ORDER BY unidades DESC LIMIT 5`, [req.params.id]);
    const x = c.rows[0];
    res.json({
        ...x, valor_total: Number(x.valor_total), ticket_promedio: Number(x.ticket_promedio),
        ordenes: ordenes.rows.map((o) => ({ ...o, total: Number(o.total) })),
        mas_comprados: masComprados.rows,
    });
}));

// Alta rápida de cliente desde el paso 1 (queda en el CRM como Prospecto
// y pasa a Activo al confirmarse su primera compra). La contraseña es
// temporal: el cliente la cambia en la tienda.
app.post('/api/admin/erp/clientes', requirePermiso('orden-nueva'), asyncRoute(async (req, res) => {
    const { nombre, correo, telefono, empresa, ciudad } = req.body;
    if (!nombre || !correo) return res.status(400).json({ message: 'Nombre y correo son obligatorios' });
    const existe = await pool.query('SELECT id FROM clientes WHERE LOWER(correo) = LOWER($1)', [correo]);
    if (existe.rows.length > 0) return res.status(400).json({ message: 'Ese correo ya está registrado en el CRM' });

    // Contraseña temporal aleatoria y fuerte; el cliente la cambia con
    // "¿Olvidaste tu contraseña?" en la tienda.
    const temporal = 'Kz#' + crypto.randomBytes(6).toString('base64url') + '7a';
    const hash = await seg.hashPassword(temporal);
    let codigoSocio;
    for (let i = 0; i < 5; i++) {
        codigoSocio = generarCodigoSocio();
        const d = await pool.query('SELECT 1 FROM clientes WHERE codigo_socio = $1', [codigoSocio]);
        if (d.rows.length === 0) break;
    }
    const r = await pool.query(
        `INSERT INTO clientes (nombre, correo, password, telefono, empresa, ciudad, codigo_socio, estado_cliente, etapa_crm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'activo','Prospecto')
         RETURNING id, nombre, correo, telefono, empresa, ciudad, etapa_crm, puntos`,
        [nombre, correo, hash, telefono || null, empresa || null, ciudad || null, codigoSocio]
    );
    await pool.query('INSERT INTO metricas_clientes (cliente_id) VALUES ($1) ON CONFLICT (cliente_id) DO NOTHING', [r.rows[0].id]);
    await monederoDe(pool, r.rows[0].id);
    res.status(201).json({ cliente: { ...r.rows[0], total_compras: 0, direccion: null }, password_temporal: temporal });
}));

// Productos del SCM para el paso 2 (solo activos; el stock es el real).
app.get('/api/admin/erp/productos', asyncRoute(async (req, res) => {
    const q = (req.query.busqueda || '').trim();
    const r = await pool.query(`
        SELECT p.id, p.nombre, p.marca, p.precio, p.stock, p.stock_minimo, p.imagen_url, p.proveedor_id, p.categoria_id, p.activo, p.fecha_creacion, c.nombre AS categoria,
               (SELECT oc.folio || '|' || oc.fecha_estimada FROM ordenes_compra oc
                 WHERE oc.producto_id = p.id AND oc.estado IN ('pendiente','en_proceso') ORDER BY oc.id DESC LIMIT 1) AS reposicion_en_curso
        FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id
        WHERE p.activo = true
          AND ($1 = '' OR p.nombre ILIKE '%' || $1 || '%' OR p.marca ILIKE '%' || $1 || '%' OR c.nombre ILIKE '%' || $1 || '%')
        ORDER BY c.nombre, p.nombre
    `, [q]);
    res.json(conPrecios(r.rows, await promocionesVigentes()));
}));

// Consulta de productos desde el ERP (sin ir al SCM): inventario con lo
// vendido de cada producto y su reposición en curso.
app.get('/api/admin/erp/productos-consulta', asyncRoute(async (req, res) => {
    const q = (req.query.busqueda || '').trim();
    const categoria = Number(req.query.categoria_id) || null;
    const r = await pool.query(`
        SELECT p.id, p.nombre, p.marca, p.precio, p.stock, p.stock_minimo, UPPER(p.restock) AS estrategia,
               p.categoria_id, c.nombre AS categoria, pr.nombre AS proveedor,
               CASE WHEN p.stock = 0 THEN 'agotado' WHEN p.stock <= p.stock_minimo THEN 'bajo' ELSE 'normal' END AS estado_stock,
               COALESCE((SELECT SUM(pi.cantidad) FROM pedido_detalle pi JOIN pedidos pe ON pe.id = pi.pedido_id
                          WHERE pi.producto_id = p.id AND pe.estado <> 'cancelado'), 0)::int AS vendidos,
               (SELECT COUNT(DISTINCT pi.pedido_id) FROM pedido_detalle pi JOIN pedidos pe ON pe.id = pi.pedido_id
                 WHERE pi.producto_id = p.id AND pe.estado <> 'cancelado')::int AS ordenes,
               (SELECT oc.folio FROM ordenes_compra oc WHERE oc.producto_id = p.id
                  AND oc.estado IN ('pendiente','en_proceso') ORDER BY oc.id DESC LIMIT 1) AS reposicion_en_curso
        FROM productos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
        WHERE p.activo = true
          AND ($1 = '' OR p.nombre ILIKE '%' || $1 || '%' OR p.marca ILIKE '%' || $1 || '%')
          AND ($2::int IS NULL OR p.categoria_id = $2::int)
        ORDER BY p.nombre`, [q, categoria]);
    res.json(r.rows.map((x) => ({ ...x, precio: Number(x.precio) })));
}));

// Ficha de un producto para el ERP: datos, inventario, órdenes de clientes
// que lo incluyen y sus últimos movimientos de inventario.
app.get('/api/admin/erp/productos-consulta/:id', asyncRoute(async (req, res) => {
    const p = await pool.query(`
        SELECT p.*, UPPER(p.restock) AS estrategia, c.nombre AS categoria, pr.nombre AS proveedor,
               pr.tiempo_entrega_dias,
               CASE WHEN p.stock = 0 THEN 'agotado' WHEN p.stock <= p.stock_minimo THEN 'bajo' ELSE 'normal' END AS estado_stock,
               (SELECT oc.folio || '|' || COALESCE(oc.fecha_estimada::text, '') FROM ordenes_compra oc WHERE oc.producto_id = p.id
                  AND oc.estado IN ('pendiente','en_proceso') ORDER BY oc.id DESC LIMIT 1) AS reposicion_en_curso
        FROM productos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
        WHERE p.id = $1`, [req.params.id]);
    if (p.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    const [ordenes, movimientos] = await Promise.all([
        pool.query(`
            SELECT pe.id, pe.numero_orden, pe.fecha_pedido, pe.estado, pe.origen, pi.cantidad, pi.precio_unitario,
                   COALESCE(c.nombre, 'Cliente eliminado') AS cliente_nombre
            FROM pedido_detalle pi JOIN pedidos pe ON pe.id = pi.pedido_id
            LEFT JOIN clientes c ON c.id = pe.cliente_id
            WHERE pi.producto_id = $1 ORDER BY pe.fecha_pedido DESC LIMIT 30`, [req.params.id]),
        pool.query(`
            SELECT m.fecha, m.tipo, m.cantidad, m.motivo FROM movimientos_inventario m
            WHERE m.producto_id = $1 ORDER BY m.fecha DESC LIMIT 8`, [req.params.id]),
    ]);
    const x = p.rows[0];
    const activas = ordenes.rows.filter((o) => o.estado !== 'cancelado');
    res.json({
        ...x, precio: Number(x.precio),
        vendidos: activas.reduce((s, o) => s + Number(o.cantidad), 0),
        ingresos: activas.reduce((s, o) => s + Number(o.cantidad) * Number(o.precio_unitario), 0),
        ordenes: ordenes.rows.map((o) => ({ ...o, precio_unitario: Number(o.precio_unitario) })),
        movimientos: movimientos.rows,
    });
}));

// Crear una orden de cliente (paso 3 → "Confirmar orden"). Todo en una
// transacción: si algo falla (p. ej. stock insuficiente) no se guarda nada.
// POST /erp/ordenes y POST /erp/ordenes/procesar (nombre del documento):
// Crear Orden → Reducir stock → Registrar movimiento → Guardar historial.
const procesarOrdenERP = asyncRoute(async (req, res) => {
    const { cliente_id, items, direccion_envio, notas } = req.body;
    const metodo = METODOS_ERP[req.body.metodo] ? req.body.metodo : 'efectivo';
    const lineas = (Array.isArray(items) ? items : [])
        .map((i) => ({ producto_id: Number(i.producto_id), cantidad: Math.floor(Number(i.cantidad)) }))
        .filter((i) => i.producto_id && i.cantidad > 0);
    if (!cliente_id) return res.status(400).json({ message: 'Selecciona un cliente' });
    if (lineas.length === 0) return res.status(400).json({ message: 'Agrega al menos un producto' });

    const client = await pool.connect();
    const pasos = [];
    try {
        await client.query('BEGIN');
        const cli = await client.query(`SELECT id, nombre FROM clientes WHERE id = $1 AND estado_cliente = 'activo'`, [cliente_id]);
        if (cli.rows.length === 0) throw new Error('El cliente no existe o está inactivo');

        // 1) Validar stock (con bloqueo de fila para que dos órdenes no
        //    vendan la misma pieza).
        let subtotal = 0;
        const detalle = [];
        const promos = await promocionesVigentes(client, { fresco: true });
        for (const l of lineas) {
            const pr = await client.query('SELECT id, nombre, precio, categoria_id, stock, activo FROM productos WHERE id = $1 FOR UPDATE', [l.producto_id]);
            if (pr.rows.length === 0 || !pr.rows[0].activo) throw new Error(`Producto ${l.producto_id} no disponible`);
            const p = pr.rows[0];
            if (p.stock < l.cantidad) throw new Error(`Stock insuficiente para "${p.nombre}" (disponible: ${p.stock})`);
            // Mismas promociones que la tienda en línea (coherencia de precios).
            const pc = precioConPromocion(p, promos);
            const lineaSub = round2(pc.precio * l.cantidad);
            subtotal += lineaSub;
            detalle.push({ ...l, nombre: p.nombre, precio: pc.precio, precio_lista: pc.precio_lista, promocion: pc.promocion, subtotal: lineaSub });
        }
        pasos.push({ clave: 'stock', texto: `Stock validado (${detalle.length} producto${detalle.length === 1 ? '' : 's'})` });

        // 2) Crear la orden.
        const R = calcularResumen({ lineas: detalle, impuestos: await impuestosActivos(client) });
        subtotal = R.subtotal;
        const { impuestos, envio, total } = R;
        const m = METODOS_ERP[metodo];
        const folio = await client.query(`SELECT 'OR-' || LPAD(nextval('folio_erp_seq')::text, 3, '0') AS folio`);
        const numero_orden = folio.rows[0].folio;
        const ped = await client.query(
            `INSERT INTO pedidos (numero_orden, cliente_id, vendedor_id, origen, subtotal, impuestos, envio, descuento, total,
                                  estado, metodo_pago, pago_estado, pago_referencia, pago_vence, direccion_envio, notas, fecha_confirmacion,
                                  impuestos_detalle, descuento_promociones)
             VALUES ($1,$2,$3,'erp',$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
            [numero_orden, cliente_id, req.usuario.id, subtotal, impuestos, envio, total,
                m.inmediato ? 'confirmado' : 'pendiente', m.texto, m.inmediato ? 'pagado' : 'pendiente',
                m.inmediato ? null : 'ERP-' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0'),
                m.inmediato ? null : new Date(Date.now() + 3 * 86400000),
                direccion_envio ? String(direccion_envio).slice(0, 200) : null, notas ? String(notas).slice(0, 500) : null, m.inmediato ? new Date() : null,
                JSON.stringify(R.impuestos_detalle), R.ahorro_promociones]
        );
        const pedido = ped.rows[0];
        // Un pedido tiene un pago (tabla pagos, Etapa 4).
        await client.query(
            `INSERT INTO pagos (pedido_id, monto, metodo_pago, detalle, referencia, estado, fecha_confirmacion) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [pedido.id, total, metodo, m.texto, pedido.pago_referencia, m.inmediato ? 'aprobado' : 'pendiente', m.inmediato ? new Date() : null]);
        pasos.push({ clave: 'orden', texto: `Orden ${numero_orden} creada` });

        // 3) Partidas + descuento de stock + movimiento de inventario.
        for (const d of detalle) {
            await client.query(
                `INSERT INTO pedido_detalle (pedido_id, producto_id, cantidad, precio_unitario, precio_lista, promocion_id, subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [pedido.id, d.producto_id, d.cantidad, d.precio, d.promocion ? d.precio_lista : null, d.promocion ? d.promocion.id : null, d.subtotal]
            );
            await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [d.cantidad, d.producto_id]);
            await client.query(
                `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, usuario_id) VALUES ($1,'salida',$2,$3,$4)`,
                [d.producto_id, d.cantidad, `Orden ERP ${numero_orden}`, req.usuario.id]
            );
        }
        pasos.push({ clave: 'inventario', texto: `Inventario actualizado y ${detalle.length} movimiento${detalle.length === 1 ? '' : 's'} registrado${detalle.length === 1 ? '' : 's'}` });

        // 4) Reabastecimiento automático (SCM) si algo quedó en stock crítico.
        const antesOC = await client.query(`SELECT COALESCE(MAX(id), 0) AS max FROM ordenes_compra`);
        for (const d of detalle) await generarOrdenAutomaticaSiCritico(client, d.producto_id, 'demanda');
        const nuevasOC = await client.query(`SELECT folio FROM ordenes_compra WHERE id > $1 ORDER BY id`, [antesOC.rows[0].max]);
        const foliosOC = nuevasOC.rows.map((r) => r.folio);
        if (foliosOC.length) pasos.push({ clave: 'reabasto', texto: `Orden de compra automática: ${foliosOC.join(', ')}` });

        // 5) Historial del cliente: si ya se cobró, puntos + métricas CRM
        //    (y pasa de Prospecto a Activo con su primera compra).
        let puntos_ganados = 0;
        if (m.inmediato) puntos_ganados = await aplicarCobroPedido(client, pedido);
        pasos.push({
            clave: 'historial',
            texto: m.inmediato
                ? `Historial del cliente actualizado${puntos_ganados ? ` (+${puntos_ganados} puntos)` : ''}`
                : 'Historial guardado; los puntos se acreditan al registrar el pago',
        });

        // Procesos internos: la bitácora de lo que el sistema hizo solo.
        const ORDEN_PASOS = ['orden', 'stock', 'inventario', 'reabasto', 'historial'];
        const bitacora = [...pasos].sort((x, y) => ORDEN_PASOS.indexOf(x.clave) - ORDEN_PASOS.indexOf(y.clave));
        for (const paso of bitacora) {
            await registrarProceso(client, pedido.id, paso.clave, paso.texto, { usuarioId: req.usuario.id });
        }

        await client.query('COMMIT');
        res.status(201).json({
            pedido: { ...pedido, cliente_nombre: cli.rows[0].nombre, items: detalle },
            pasos, puntos_ganados, ordenes_compra: foliosOC,
        });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: seg.mensajeSeguro(e) });
    } finally {
        client.release();
    }
});
app.post('/api/admin/erp/ordenes', requirePermiso('orden-nueva'), procesarOrdenERP);
app.post('/api/admin/erp/ordenes/procesar', requirePermiso('orden-nueva'), procesarOrdenERP);

// Nivel de implementación del ERP. Como en el SCM, cada punto se
// calcula con datos reales: el nivel sube solo conforme se usa.
async function nivelERP() {
    const r = await pool.query(`
        SELECT
            (SELECT COUNT(DISTINCT c.id) FROM clientes c
              WHERE EXISTS (SELECT 1 FROM pedidos p WHERE p.cliente_id = c.id)
                 OR EXISTS (SELECT 1 FROM interacciones i WHERE i.cliente_id = c.id))::int AS clientes_crm,
            (SELECT COUNT(*) FROM productos WHERE activo = true AND proveedor_id IS NOT NULL)::int AS productos_scm,
            (SELECT COUNT(*) FROM pedidos WHERE origen = 'erp')::int AS ordenes_erp,
            (SELECT COUNT(*) FROM movimientos_inventario WHERE motivo LIKE 'Orden ERP %')::int AS movimientos_erp,
            (SELECT COUNT(*) FROM pedidos WHERE origen = 'erp' AND pago_estado = 'pagado' AND estado <> 'cancelado')::int AS ventas_erp,
            (SELECT COUNT(*) FROM pedidos WHERE origen = 'en_linea' AND pago_estado = 'pagado' AND estado <> 'cancelado')::int AS ventas_linea,
            (SELECT COUNT(*) FROM ordenes_compra WHERE notas LIKE 'Generada automáticamente%')::int AS oc_automaticas,
            (SELECT COUNT(*) FROM pedidos WHERE origen = 'erp' AND estado = 'entregado')::int AS erp_entregadas
    `);
    const d = r.rows[0];
    const checklist = [
        { clave: 'crm', etiqueta: 'Clientes integrados (CRM)', detalle: `${d.clientes_crm} clientes con compras o interacciones`, cumplido: d.clientes_crm > 0 },
        { clave: 'scm', etiqueta: 'Productos e inventario (SCM)', detalle: `${d.productos_scm} productos con proveedor asignado`, cumplido: d.productos_scm > 0 },
        { clave: 'ordenes', etiqueta: 'Órdenes de clientes funcionando (ERP)', detalle: `${d.ordenes_erp} órdenes capturadas en el ERP`, cumplido: d.ordenes_erp > 0 },
        { clave: 'movimientos', etiqueta: 'Movimientos de inventario automáticos', detalle: `${d.movimientos_erp} movimientos generados por órdenes ERP`, cumplido: d.movimientos_erp > 0 },
        { clave: 'reportes', etiqueta: 'Reportes empresariales completos', detalle: 'Ventas cobradas de los dos canales (tienda en línea y ERP)', cumplido: d.ventas_erp > 0 && d.ventas_linea > 0 },
        { clave: 'optimizado', etiqueta: 'Procesos optimizados', detalle: 'Reabasto automático en uso y órdenes ERP entregadas', cumplido: d.oc_automaticas > 0 && d.erp_entregadas > 0 },
    ];
    const cumplidos = checklist.filter((c) => c.cumplido).length;
    const nivelCalculado = cumplidos <= 2 ? 'basico' : cumplidos <= 4 ? 'integrado' : cumplidos === 5 ? 'automatizado' : 'optimizado';

    // EstadoERP (tabla estado_erp): en modo automático guarda el nivel
    // calculado; en modo manual manda el nivel que fijó el administrador.
    await pool.query(`INSERT INTO estado_erp (id, modo, nivel) VALUES (1, 'auto', $1) ON CONFLICT (id) DO NOTHING`, [nivelCalculado]);
    const e = await pool.query(`
        SELECT e.modo, e.nivel, e.nota, e.actualizado, u.nombre AS actualizado_por
        FROM estado_erp e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE e.id = 1`);
    let estado = e.rows[0];
    if (estado.modo === 'auto' && estado.nivel !== nivelCalculado) {
        const upd = await pool.query(
            `UPDATE estado_erp SET nivel = $1, actualizado = CURRENT_TIMESTAMP WHERE id = 1 RETURNING actualizado`, [nivelCalculado]);
        estado = { ...estado, nivel: nivelCalculado, actualizado: upd.rows[0].actualizado };
    }
    const nivel = estado.modo === 'manual' ? estado.nivel : nivelCalculado;
    return {
        nivel, nivel_calculado: nivelCalculado, modo: estado.modo,
        progreso: Math.round((NIVELES_ERP.indexOf(nivel) * 100) / (NIVELES_ERP.length - 1)),
        nota: estado.nota, actualizado: estado.actualizado, actualizado_por: estado.actualizado_por,
        checklist, cumplidos, total: checklist.length, datos: d,
    };
}
const NIVELES_ERP = ['basico', 'integrado', 'automatizado', 'optimizado'];

// GET /erp/estado (y /erp/nivel, que ya usaban las pantallas): nivel de
// implementación con su checklist.
app.get('/api/admin/erp/nivel', asyncRoute(async (req, res) => { res.json(await nivelERP()); }));
app.get('/api/admin/erp/estado', asyncRoute(async (req, res) => { res.json(await nivelERP()); }));

// PUT /erp/estado (solo admin): fijar el nivel a mano o regresar al
// cálculo automático.  Body: { modo: 'auto' }  o  { modo: 'manual', nivel, nota }
app.put('/api/admin/erp/estado', requireAdmin, asyncRoute(async (req, res) => {
    const modo = req.body.modo === 'manual' ? 'manual' : 'auto';
    const nivel = req.body.nivel;
    if (modo === 'manual' && !NIVELES_ERP.includes(nivel)) {
        return res.status(400).json({ message: 'Nivel no válido (basico, integrado, automatizado u optimizado)' });
    }
    await pool.query(`
        INSERT INTO estado_erp (id, modo, nivel, nota, usuario_id, actualizado)
        VALUES (1, $1, COALESCE($2, 'basico'), $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET modo = EXCLUDED.modo, nivel = COALESCE($2, estado_erp.nivel),
            nota = EXCLUDED.nota, usuario_id = EXCLUDED.usuario_id, actualizado = CURRENT_TIMESTAMP`,
        [modo, modo === 'manual' ? nivel : null, modo === 'manual' ? (req.body.nota || '').slice(0, 300) || null : null, req.usuario.id]);
    const r = await nivelERP();
    res.json({ message: modo === 'manual' ? `Nivel ERP fijado en "${r.nivel}"` : 'Nivel ERP en cálculo automático', ...r });
}));

// Lo que falta para el nivel Optimizado, para resolverlo desde el propio
// Nivel ERP sin ir al SCM: estado del reabasto automático, productos más
// cerca de su mínimo y órdenes ERP que aún no se entregan.
app.get('/api/admin/erp/optimizar', asyncRoute(async (req, res) => {
    const [cfg, auto, candidatos, porEntregar] = await Promise.all([
        leerConfigScm(pool),
        pool.query(`
            SELECT oc.folio, oc.estado, oc.cantidad, oc.fecha_creacion, p.nombre AS producto
            FROM ordenes_compra oc JOIN productos p ON p.id = oc.producto_id
            WHERE oc.notas LIKE 'Generada automáticamente%' ORDER BY oc.id DESC LIMIT 5`),
        pool.query(`
            SELECT p.id, p.nombre, p.stock, p.stock_minimo, p.restock, pr.nombre AS proveedor,
                   EXISTS (SELECT 1 FROM ordenes_compra oc WHERE oc.producto_id = p.id
                           AND oc.estado IN ('pendiente','en_proceso')) AS pedido_abierto
            FROM productos p LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
            WHERE p.activo = true AND p.proveedor_id IS NOT NULL
            ORDER BY (p.stock - p.stock_minimo), p.nombre LIMIT 6`),
        pool.query(`
            SELECT p.id, p.numero_orden, p.estado, p.pago_estado, p.total, p.fecha_pedido, COALESCE(c.nombre, 'Cliente eliminado') AS cliente_nombre
            FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id
            WHERE p.origen = 'erp' AND p.estado NOT IN ('entregado','cancelado')
            ORDER BY p.fecha_pedido LIMIT 10`),
    ]);
    const entregadas = await pool.query(`SELECT COUNT(*)::int AS n FROM pedidos WHERE origen = 'erp' AND estado = 'entregado'`);
    const totalAuto = await pool.query(`SELECT COUNT(*)::int AS n FROM ordenes_compra WHERE notas LIKE 'Generada automáticamente%'`);
    res.json({
        config: cfg,
        reabasto: { automaticos: totalAuto.rows[0].n, recientes: auto.rows, candidatos: candidatos.rows },
        entregas: { entregadas: entregadas.rows[0].n, por_entregar: porEntregar.rows.map((o) => ({ ...o, total: Number(o.total) })) },
    });
}));

// GET /erp/metricas: los indicadores globales que pide el documento
// (ventas totales, órdenes procesadas, productos vendidos, clientes
// activos e inventario disponible) en una sola respuesta.
app.get('/api/admin/erp/metricas', asyncRoute(async (req, res) => { res.json(await metricasERP()); }));

async function metricasERP() {
    const r = await pool.query(`
        SELECT
            (SELECT COALESCE(SUM(total),0) FROM pedidos WHERE estado <> 'cancelado' AND pago_estado = 'pagado') AS ventas_totales,
            (SELECT COUNT(*) FROM pedidos WHERE estado <> 'cancelado' AND pago_estado = 'pagado')::int AS ordenes_procesadas,
            (SELECT COUNT(*) FROM pedidos WHERE estado <> 'cancelado' AND pago_estado = 'pagado' AND origen = 'erp')::int AS ordenes_procesadas_erp,
            (SELECT COUNT(*) FROM pedidos WHERE estado <> 'cancelado' AND pago_estado = 'pendiente')::int AS ordenes_por_cobrar,
            (SELECT COALESCE(SUM(pi.cantidad),0) FROM pedido_detalle pi JOIN pedidos p ON p.id = pi.pedido_id
              WHERE p.estado <> 'cancelado')::int AS productos_vendidos,
            (SELECT COUNT(*) FROM clientes WHERE estado_cliente = 'activo' AND etapa_crm IN ('Activo','Frecuente'))::int AS clientes_activos,
            (SELECT COALESCE(SUM(stock),0) FROM productos WHERE activo = true)::int AS inventario_unidades,
            (SELECT COALESCE(SUM(stock * precio),0) FROM productos WHERE activo = true) AS inventario_valor,
            (SELECT COUNT(*) FROM productos WHERE activo = true AND stock > 0)::int AS productos_con_stock,
            (SELECT COUNT(*) FROM productos WHERE activo = true AND stock <= stock_minimo)::int AS productos_criticos
    `);
    const m = r.rows[0];
    return ({
        ventas_totales: Number(m.ventas_totales),
        ordenes_procesadas: m.ordenes_procesadas,
        ordenes_procesadas_erp: m.ordenes_procesadas_erp,
        ordenes_por_cobrar: m.ordenes_por_cobrar,
        productos_vendidos: m.productos_vendidos,
        clientes_activos: m.clientes_activos,
        inventario_disponible: {
            unidades: m.inventario_unidades, valor: Number(m.inventario_valor),
            productos_con_stock: m.productos_con_stock, productos_criticos: m.productos_criticos,
        },
    });
}

// Reportes ERP (dashboard empresarial) con rango de fechas opcional.
const fechaISO = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
app.get('/api/admin/erp/reportes', asyncRoute(async (req, res) => {
    res.json(await reporteERP(fechaISO(req.query.desde), fechaISO(req.query.hasta)));
}));

async function reporteERP(desde, hasta) {
    const rango = `($1::date IS NULL OR p.fecha_pedido >= $1::date) AND ($2::date IS NULL OR p.fecha_pedido < $2::date + INTERVAL '1 day')`;

    const k = await pool.query(`
        SELECT
            COALESCE(SUM(p.total) FILTER (WHERE p.pago_estado = 'pagado'), 0) AS ventas_totales,
            COUNT(*)::int AS ordenes,
            COUNT(*) FILTER (WHERE p.origen = 'erp')::int AS ordenes_erp,
            COUNT(*) FILTER (WHERE p.origen = 'en_linea')::int AS ordenes_en_linea,
            COUNT(*) FILTER (WHERE p.pago_estado = 'pendiente')::int AS pagos_pendientes,
            COALESCE(SUM(p.total) FILTER (WHERE p.pago_estado = 'pendiente'), 0) AS por_cobrar,
            COUNT(DISTINCT p.cliente_id)::int AS clientes_con_compra,
            COALESCE(AVG(p.total) FILTER (WHERE p.pago_estado = 'pagado'), 0) AS ticket_promedio
        FROM pedidos p WHERE p.estado <> 'cancelado' AND ${rango}
    `, [desde, hasta]);
    const piezas = await pool.query(`
        SELECT COALESCE(SUM(pi.cantidad),0)::int AS n FROM pedido_detalle pi JOIN pedidos p ON pi.pedido_id = p.id
        WHERE p.estado <> 'cancelado' AND ${rango}
    `, [desde, hasta]);
    const activos = await pool.query(`SELECT COUNT(*)::int AS n FROM clientes WHERE estado_cliente = 'activo' AND etapa_crm IN ('Activo','Frecuente')`);
    const porEstado = await pool.query(`
        SELECT p.estado, COUNT(*)::int AS total FROM pedidos p WHERE ${rango} GROUP BY p.estado
    `, [desde, hasta]);

    // Inventario disponible por rotación (unidades vendidas en 90 días
    // contra el stock actual de cada producto).
    const inv = await pool.query(`
        SELECT p.id, p.nombre, p.stock, p.precio,
               COALESCE((SELECT SUM(pi.cantidad) FROM pedido_detalle pi JOIN pedidos pe ON pi.pedido_id = pe.id
                          WHERE pi.producto_id = p.id AND pe.estado <> 'cancelado'
                            AND pe.fecha_pedido >= CURRENT_DATE - INTERVAL '90 days'), 0)::int AS vendidas_90
        FROM productos p WHERE p.activo = true
    `);
    const rot = { alta: { productos: 0, unidades: 0, valor: 0 }, media: { productos: 0, unidades: 0, valor: 0 }, baja: { productos: 0, unidades: 0, valor: 0 } };
    inv.rows.forEach((p) => {
        const indice = p.stock + p.vendidas_90 > 0 ? p.vendidas_90 / (p.stock + p.vendidas_90) : 0;
        const g = indice >= 0.15 ? 'alta' : indice > 0 ? 'media' : 'baja';
        rot[g].productos++; rot[g].unidades += p.stock; rot[g].valor += p.stock * Number(p.precio);
    });

    const kp = k.rows[0];
    return ({
        rango: { desde, hasta },
        kpis: {
            ventas_totales: Number(kp.ventas_totales), ordenes: kp.ordenes, ordenes_erp: kp.ordenes_erp,
            ordenes_en_linea: kp.ordenes_en_linea, pagos_pendientes: kp.pagos_pendientes, por_cobrar: Number(kp.por_cobrar),
            clientes_con_compra: kp.clientes_con_compra, ticket_promedio: Math.round(Number(kp.ticket_promedio) * 100) / 100,
            productos_vendidos: piezas.rows[0].n, clientes_activos: activos.rows[0].n,
        },
        ventas_por_mes: await ventasPorMes(6),
        mas_vendidos: await masVendidosERP(6, desde, hasta),
        ordenes_por_estado: porEstado.rows,
        inventario_rotacion: rot,
        nivel: await nivelERP(),
    });
}

// Reportes ERP guardados (tabla reportes_erp): una foto de los
// indicadores del periodo para consultarla después.
app.get('/api/admin/erp/reportes/guardados', asyncRoute(async (req, res) => {
    const r = await pool.query(`
        SELECT r.id, r.nombre, r.desde, r.hasta, r.fecha, u.nombre AS usuario_nombre,
               (r.datos->'kpis'->>'ventas_totales')::numeric AS ventas_totales,
               (r.datos->'kpis'->>'ordenes')::int AS ordenes
        FROM reportes_erp r LEFT JOIN usuarios u ON u.id = r.usuario_id
        ORDER BY r.fecha DESC LIMIT 50`);
    res.json(r.rows.map((x) => ({ ...x, ventas_totales: Number(x.ventas_totales) })));
}));

app.get('/api/admin/erp/reportes/guardados/:id', asyncRoute(async (req, res) => {
    const r = await pool.query(`
        SELECT r.*, u.nombre AS usuario_nombre FROM reportes_erp r LEFT JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.id = $1`, [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Reporte no encontrado' });
    res.json(r.rows[0]);
}));

app.post('/api/admin/erp/reportes/guardados', asyncRoute(async (req, res) => {
    const desde = fechaISO(req.body.desde);
    const hasta = fechaISO(req.body.hasta);
    const rango = desde || hasta ? `${desde || 'inicio'} a ${hasta || 'hoy'}` : 'todo el histórico';
    const nombre = String(req.body.nombre || '').trim().slice(0, 120) || `Reporte ERP (${rango})`;
    // La foto incluye también el inventario disponible de ese momento.
    const datos = { ...(await reporteERP(desde, hasta)), inventario_disponible: (await metricasERP()).inventario_disponible };
    const r = await pool.query(
        `INSERT INTO reportes_erp (nombre, desde, hasta, datos, usuario_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, nombre, fecha`,
        [nombre, desde, hasta, JSON.stringify(datos), req.usuario.id]);
    res.status(201).json({ message: 'Reporte guardado', reporte: r.rows[0] });
}));

app.delete('/api/admin/erp/reportes/guardados/:id', asyncRoute(async (req, res) => {
    const r = await pool.query('DELETE FROM reportes_erp WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Reporte no encontrado' });
    res.json({ message: 'Reporte eliminado' });
}));

// ---------------------------------------------------------
// RECURSOS (ERP): una sola vista de los recursos de la empresa.
//   - Humanos     -> usuarios internos por rol (tabla usuarios)
//   - Materiales  -> inventario del SCM (tabla productos)
//   - Financieros -> ventas cobradas, por cobrar y reposición comprometida
//   - Registrados -> equipo, vehículos, instalaciones y presupuestos
//                    (tabla recursos_erp, lo único que no existía)
// ---------------------------------------------------------
const TIPOS_RECURSO = ['equipo', 'vehiculo', 'instalacion', 'presupuesto'];
const AREAS_RECURSO = ['administracion', 'ventas', 'logistica'];
const ESTADOS_RECURSO = ['disponible', 'en_uso', 'mantenimiento', 'baja'];

app.get('/api/admin/erp/recursos', asyncRoute(async (req, res) => {
    const [humanos, materiales, financieros, registrados] = await Promise.all([
        pool.query(`
            SELECT rol, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE activo)::int AS activos
            FROM usuarios GROUP BY rol`),
        pool.query(`
            SELECT COUNT(*)::int AS productos,
                   COALESCE(SUM(stock),0)::int AS unidades,
                   COALESCE(SUM(stock * COALESCE(NULLIF(costo_unitario,0), precio)),0) AS valor_costo,
                   COALESCE(SUM(stock * precio),0) AS valor_venta,
                   COUNT(*) FILTER (WHERE stock <= stock_minimo)::int AS criticos
            FROM productos WHERE activo = true`),
        pool.query(`
            SELECT
              (SELECT COALESCE(SUM(total),0) FROM pedidos WHERE estado <> 'cancelado' AND pago_estado = 'pagado') AS ingresos,
              (SELECT COALESCE(SUM(total),0) FROM pedidos WHERE estado <> 'cancelado' AND pago_estado = 'pendiente') AS por_cobrar,
              (SELECT COALESCE(SUM(oc.cantidad * COALESCE(NULLIF(pr.costo_unitario,0), pr.precio)),0)
                 FROM ordenes_compra oc JOIN productos pr ON pr.id = oc.producto_id
                WHERE oc.estado IN ('pendiente','en_proceso')) AS reposicion_comprometida`),
        pool.query(`
            SELECT r.*, u.nombre AS responsable_nombre, u.rol AS responsable_rol
            FROM recursos_erp r LEFT JOIN usuarios u ON u.id = r.responsable_id
            ORDER BY r.tipo, r.nombre`),
    ]);
    const m = materiales.rows[0];
    const f = financieros.rows[0];
    const presupuestos = registrados.rows.filter((r) => r.tipo === 'presupuesto' && r.estado !== 'baja');
    res.json({
        humanos: Object.keys(ROLES_INTERNOS).map((rol) => {
            const h = humanos.rows.find((x) => x.rol === rol) || { total: 0, activos: 0 };
            return { rol, nombre: ROLES_INTERNOS[rol].nombre, total: h.total, activos: h.activos };
        }),
        materiales: {
            productos: m.productos, unidades: m.unidades, criticos: m.criticos,
            valor_costo: Number(m.valor_costo), valor_venta: Number(m.valor_venta),
        },
        financieros: {
            ingresos: Number(f.ingresos), por_cobrar: Number(f.por_cobrar),
            reposicion_comprometida: Number(f.reposicion_comprometida),
            presupuesto_asignado: presupuestos.reduce((a, r) => a + Number(r.valor) * r.cantidad, 0),
        },
        registrados: registrados.rows.map((r) => ({ ...r, valor: Number(r.valor) })),
    });
}));

function validarRecurso(b) {
    const nombre = String(b.nombre || '').trim().slice(0, 120);
    if (!nombre) return { error: 'El nombre es obligatorio' };
    if (!TIPOS_RECURSO.includes(b.tipo)) return { error: 'Tipo no válido (equipo, vehiculo, instalacion o presupuesto)' };
    const area = AREAS_RECURSO.includes(b.area) ? b.area : 'administracion';
    const estado = ESTADOS_RECURSO.includes(b.estado) ? b.estado : 'disponible';
    const cantidad = b.cantidad === undefined || b.cantidad === '' ? 1 : Number(b.cantidad);
    const valor = b.valor === undefined || b.valor === '' ? 0 : Number(b.valor);
    if (!Number.isInteger(cantidad) || cantidad < 0) return { error: 'La cantidad debe ser un entero de 0 o más' };
    if (!Number.isFinite(valor) || valor < 0) return { error: 'El valor debe ser 0 o más' };
    const responsable_id = b.responsable_id ? Number(b.responsable_id) : null;
    return { datos: [nombre, b.tipo, area, String(b.descripcion || '').trim().slice(0, 300) || null, cantidad, valor, estado, responsable_id] };
}

app.post('/api/admin/erp/recursos', asyncRoute(async (req, res) => {
    const v = validarRecurso(req.body);
    if (v.error) return res.status(400).json({ message: v.error });
    const r = await pool.query(`
        INSERT INTO recursos_erp (nombre, tipo, area, descripcion, cantidad, valor, estado, responsable_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, v.datos);
    res.status(201).json({ message: 'Recurso registrado', recurso: r.rows[0] });
}));

app.put('/api/admin/erp/recursos/:id', asyncRoute(async (req, res) => {
    const v = validarRecurso(req.body);
    if (v.error) return res.status(400).json({ message: v.error });
    const r = await pool.query(`
        UPDATE recursos_erp SET nombre=$1, tipo=$2, area=$3, descripcion=$4, cantidad=$5, valor=$6, estado=$7, responsable_id=$8
        WHERE id = $9 RETURNING *`, [...v.datos, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Recurso no encontrado' });
    res.json({ message: 'Recurso actualizado', recurso: r.rows[0] });
}));

app.delete('/api/admin/erp/recursos/:id', asyncRoute(async (req, res) => {
    const r = await pool.query('DELETE FROM recursos_erp WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Recurso no encontrado' });
    res.json({ message: 'Recurso eliminado' });
}));

// =========================================================
// ADMIN: TIENDA EN LÍNEA (Etapa 4) — solo administrador
//   Promociones, impuestos, monederos, pagos, resumen, correos.
// =========================================================

// ---- Promociones (GET / POST / PUT /promociones) ----
function validarPromocion(b) {
    const nombre = String(b.nombre || '').trim().slice(0, 120);
    if (nombre.length < 3) return { error: 'Escribe el nombre de la promoción' };
    if (!['porcentaje', 'monto'].includes(b.tipo_descuento)) return { error: 'El tipo de descuento debe ser porcentaje o monto' };
    const valor = round2(b.valor);
    if (!(valor > 0)) return { error: 'El valor del descuento debe ser mayor a 0' };
    if (b.tipo_descuento === 'porcentaje' && valor > 90) return { error: 'El porcentaje máximo es 90 %' };
    if (b.tipo_descuento === 'monto' && valor > 100000) return { error: 'El monto es demasiado alto' };
    const alcance = ['todos', 'categoria', 'productos'].includes(b.alcance) ? b.alcance : 'todos';
    const categoria_id = alcance === 'categoria' ? Number(b.categoria_id) || null : null;
    if (alcance === 'categoria' && !categoria_id) return { error: 'Elige la categoría a la que aplica' };
    const productos = alcance === 'productos' ? [...new Set((Array.isArray(b.productos) ? b.productos : []).map(Number).filter((n) => n > 0))].slice(0, 300) : [];
    if (alcance === 'productos' && productos.length === 0) return { error: 'Elige al menos un producto' };
    const f = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const inicio = f(b.fecha_inicio), fin = f(b.fecha_fin);
    if (!inicio || !fin) return { error: 'Indica las fechas de inicio y fin' };
    if (fin < inicio) return { error: 'La fecha de fin no puede ser antes del inicio' };
    return { datos: { nombre, descripcion: String(b.descripcion || '').trim().slice(0, 300) || null, tipo_descuento: b.tipo_descuento, valor, alcance, categoria_id,
        fecha_inicio: inicio, fecha_fin: fin, estado: b.estado === 'inactiva' ? 'inactiva' : 'activa', banner: b.banner !== false, productos } };
}

const listarPromocionesAdmin = asyncRoute(async (req, res) => {
    const r = await pool.query(`
        SELECT p.*, c.nombre AS categoria_nombre, u.nombre AS creada_por,
               COALESCE(array_agg(pp.producto_id) FILTER (WHERE pp.producto_id IS NOT NULL), '{}') AS productos,
               CASE WHEN p.estado = 'inactiva' THEN 'inactiva'
                    WHEN CURRENT_DATE < p.fecha_inicio THEN 'programada'
                    WHEN CURRENT_DATE > p.fecha_fin THEN 'terminada' ELSE 'vigente' END AS vigencia,
               (SELECT COUNT(DISTINCT pd.pedido_id)::int FROM pedido_detalle pd JOIN pedidos pe ON pe.id = pd.pedido_id
                 WHERE pd.promocion_id = p.id AND pe.estado <> 'cancelado') AS pedidos,
               (SELECT COALESCE(SUM((pd.precio_lista - pd.precio_unitario) * pd.cantidad), 0) FROM pedido_detalle pd JOIN pedidos pe ON pe.id = pd.pedido_id
                 WHERE pd.promocion_id = p.id AND pe.estado <> 'cancelado') AS ahorro_otorgado
        FROM promociones p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN usuarios u ON u.id = p.usuario_id
        LEFT JOIN promocion_productos pp ON pp.promocion_id = p.id
        GROUP BY p.id, c.nombre, u.nombre
        ORDER BY CASE WHEN p.estado = 'activa' AND CURRENT_DATE BETWEEN p.fecha_inicio AND p.fecha_fin THEN 0
                      WHEN CURRENT_DATE < p.fecha_inicio THEN 1 ELSE 2 END, p.fecha_fin DESC`);
    res.json(r.rows.map((x) => ({ ...x, valor: Number(x.valor), ahorro_otorgado: Number(x.ahorro_otorgado), etiqueta: etiquetaPromo(x) })));
});

async function guardarPromocion(req, res) {
    const v = validarPromocion(req.body || {});
    if (v.error) return res.status(400).json({ message: v.error });
    const d = v.datos;
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        let id = req.params.id ? Number(req.params.id) : null;
        if (id) {
            const r = await db.query(
                `UPDATE promociones SET nombre=$1, descripcion=$2, tipo_descuento=$3, valor=$4, alcance=$5, categoria_id=$6,
                        fecha_inicio=$7, fecha_fin=$8, estado=$9, banner=$10 WHERE id=$11 RETURNING id`,
                [d.nombre, d.descripcion, d.tipo_descuento, d.valor, d.alcance, d.categoria_id, d.fecha_inicio, d.fecha_fin, d.estado, d.banner, id]);
            if (!r.rows[0]) { await db.query('ROLLBACK'); return res.status(404).json({ message: 'Promoción no encontrada' }); }
            await db.query('DELETE FROM promocion_productos WHERE promocion_id = $1', [id]);
        } else {
            const r = await db.query(
                `INSERT INTO promociones (nombre, descripcion, tipo_descuento, valor, alcance, categoria_id, fecha_inicio, fecha_fin, estado, banner, usuario_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
                [d.nombre, d.descripcion, d.tipo_descuento, d.valor, d.alcance, d.categoria_id, d.fecha_inicio, d.fecha_fin, d.estado, d.banner, req.usuario.id]);
            id = r.rows[0].id;
        }
        if (d.productos.length) {
            await db.query(`INSERT INTO promocion_productos (promocion_id, producto_id) SELECT $1, id FROM productos WHERE id = ANY($2::int[])`, [id, d.productos]);
        }
        await db.query('COMMIT');
        invalidarPromos();
        res.status(req.params.id ? 200 : 201).json({ message: req.params.id ? 'Promoción actualizada' : 'Promoción creada', id });
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
app.get('/api/admin/promociones', requireAdmin, listarPromocionesAdmin);
app.post('/api/admin/promociones', requireAdmin, asyncRoute(guardarPromocion));
app.put('/api/admin/promociones/:id', requireAdmin, asyncRoute(guardarPromocion));
app.delete('/api/admin/promociones/:id', requireAdmin, asyncRoute(async (req, res) => {
    const usada = await pool.query('SELECT 1 FROM pedido_detalle WHERE promocion_id = $1 LIMIT 1', [req.params.id]);
    if (usada.rows.length) {
        await pool.query(`UPDATE promociones SET estado = 'inactiva' WHERE id = $1`, [req.params.id]);
        invalidarPromos();
        return res.json({ message: 'La promoción ya se usó en pedidos: se desactivó en lugar de borrarla' });
    }
    const r = await pool.query('DELETE FROM promociones WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ message: 'Promoción no encontrada' });
    invalidarPromos();
    res.json({ message: 'Promoción eliminada' });
}));
// Nombres exactos del documento (POST /promociones, PUT /promociones/{id}).
app.post('/api/promociones', requireUsuario, requireAdmin, asyncRoute(guardarPromocion));
app.put('/api/promociones/:id', requireUsuario, requireAdmin, asyncRoute(guardarPromocion));

// ---- Impuestos (GET / POST / PUT /impuestos) ----
async function guardarImpuesto(req, res) {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim().slice(0, 60);
    const porcentaje = round2(b.porcentaje);
    if (nombre.length < 2) return res.status(400).json({ message: 'Escribe el nombre del impuesto' });
    if (!(porcentaje >= 0 && porcentaje <= 100)) return res.status(400).json({ message: 'El porcentaje debe estar entre 0 y 100' });
    const estado = b.estado === 'inactivo' ? 'inactivo' : 'activo';
    const descripcion = String(b.descripcion || '').trim().slice(0, 200) || null;
    const dup = await pool.query('SELECT id FROM impuestos WHERE LOWER(nombre) = LOWER($1) AND id <> COALESCE($2, 0)', [nombre, Number(req.params.id) || null]);
    if (dup.rows.length) return res.status(409).json({ message: 'Ya existe un impuesto con ese nombre' });
    let r;
    if (req.params.id) {
        r = await pool.query(`UPDATE impuestos SET nombre=$1, porcentaje=$2, estado=$3, descripcion=$4 WHERE id=$5 RETURNING *`, [nombre, porcentaje, estado, descripcion, req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ message: 'Impuesto no encontrado' });
    } else {
        r = await pool.query(`INSERT INTO impuestos (nombre, porcentaje, estado, descripcion) VALUES ($1,$2,$3,$4) RETURNING *`, [nombre, porcentaje, estado, descripcion]);
    }
    const activos = await impuestosActivos();
    res.status(req.params.id ? 200 : 201).json({
        message: req.params.id ? 'Impuesto actualizado' : 'Impuesto creado', impuesto: r.rows[0],
        tasa_total: round2(activos.reduce((a, i) => a + i.porcentaje, 0)),
    });
}
app.get('/api/admin/impuestos', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query(`
        SELECT i.*, i.porcentaje::float AS porcentaje,
               COALESCE((SELECT SUM((d->>'monto')::numeric) FROM pedidos p, jsonb_array_elements(p.impuestos_detalle) d
                          WHERE d->>'nombre' = i.nombre AND p.estado <> 'cancelado' AND p.pago_estado = 'pagado'), 0)::float AS recaudado
        FROM impuestos i ORDER BY i.id`);
    res.json(r.rows);
}));
app.post('/api/admin/impuestos', requireAdmin, asyncRoute(guardarImpuesto));
app.put('/api/admin/impuestos/:id', requireAdmin, asyncRoute(guardarImpuesto));
app.post('/api/impuestos', requireUsuario, requireAdmin, asyncRoute(guardarImpuesto));
app.put('/api/impuestos/:id', requireUsuario, requireAdmin, asyncRoute(guardarImpuesto));

// ---- Monederos (administración) ----
app.get('/api/admin/monederos', requireAdmin, asyncRoute(async (req, res) => {
    const q = String(req.query.busqueda || '').trim().slice(0, 80);
    const [lista, kpi, pendientes, mensual] = await Promise.all([
        pool.query(`
            SELECT m.id, m.cliente_id, m.saldo::float AS saldo, m.estado, m.fecha_actualizacion,
                   c.nombre AS cliente_nombre, c.correo AS cliente_correo,
                   (SELECT MAX(fecha) FROM movimientos_monedero x WHERE x.monedero_id = m.id) AS ultimo_movimiento,
                   (SELECT COALESCE(SUM(monto), 0)::float FROM movimientos_monedero x WHERE x.monedero_id = m.id AND x.tipo = 'recarga' AND x.estado = 'aplicado') AS recargado,
                   (SELECT COALESCE(-SUM(monto), 0)::float FROM movimientos_monedero x WHERE x.monedero_id = m.id AND x.tipo = 'compra') AS consumido
            FROM monederos m JOIN clientes c ON c.id = m.cliente_id
            WHERE ($1 = '' OR c.nombre ILIKE '%' || $1 || '%' OR c.correo ILIKE '%' || $1 || '%')
            ORDER BY m.saldo DESC, c.nombre LIMIT 200`, [q]),
        pool.query(`
            SELECT (SELECT COALESCE(SUM(saldo), 0)::float FROM monederos) AS saldo_total,
                   (SELECT COUNT(*)::int FROM monederos WHERE saldo > 0) AS con_saldo,
                   (SELECT COALESCE(SUM(monto), 0)::float FROM movimientos_monedero WHERE tipo = 'recarga' AND estado = 'aplicado'
                      AND fecha >= DATE_TRUNC('month', CURRENT_DATE)) AS recargas_mes,
                   (SELECT COALESCE(-SUM(monto), 0)::float FROM movimientos_monedero WHERE tipo = 'compra'
                      AND fecha >= DATE_TRUNC('month', CURRENT_DATE)) AS consumos_mes,
                   (SELECT COUNT(*)::int FROM pagos WHERE metodo_pago = 'monedero' AND estado = 'aprobado') AS compras_con_monedero`),
        pool.query(`
            SELECT mm.id, mm.monto::float AS monto, mm.referencia, mm.fecha, mm.concepto, c.id AS cliente_id, c.nombre AS cliente_nombre
            FROM movimientos_monedero mm JOIN monederos m ON m.id = mm.monedero_id JOIN clientes c ON c.id = m.cliente_id
            WHERE mm.estado = 'pendiente' ORDER BY mm.fecha`),
        pool.query(`
            SELECT TO_CHAR(g.mes, 'YYYY-MM') AS mes,
                   COALESCE(SUM(mm.monto) FILTER (WHERE mm.tipo = 'recarga' AND mm.estado = 'aplicado'), 0)::float AS recargas,
                   COALESCE(-SUM(mm.monto) FILTER (WHERE mm.tipo = 'compra'), 0)::float AS consumos
            FROM generate_series(DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months', DATE_TRUNC('month', CURRENT_DATE), INTERVAL '1 month') g(mes)
            LEFT JOIN movimientos_monedero mm ON DATE_TRUNC('month', mm.fecha) = g.mes
            GROUP BY g.mes ORDER BY g.mes`),
    ]);
    res.json({ kpis: kpi.rows[0], monederos: lista.rows, pendientes: pendientes.rows, mensual: mensual.rows });
}));

app.get('/api/admin/monederos/:clienteId', requireAdmin, asyncRoute(async (req, res) => {
    const c = await pool.query('SELECT id, nombre, correo FROM clientes WHERE id = $1', [req.params.clienteId]);
    if (!c.rows[0]) return res.status(404).json({ message: 'Cliente no encontrado' });
    const m = await monederoDe(pool, req.params.clienteId);
    const mov = await pool.query(`
        SELECT mm.*, mm.monto::float AS monto, mm.saldo_anterior::float AS saldo_anterior, mm.saldo_nuevo::float AS saldo_nuevo,
               p.numero_orden, u.nombre AS usuario_nombre
        FROM movimientos_monedero mm LEFT JOIN pedidos p ON p.id = mm.pedido_id LEFT JOIN usuarios u ON u.id = mm.usuario_id
        WHERE mm.monedero_id = $1 ORDER BY mm.fecha DESC, mm.id DESC LIMIT 200`, [m.id]);
    res.json({ cliente: c.rows[0], monedero: { ...m, saldo: Number(m.saldo) }, movimientos: mov.rows });
}));

// Ajuste manual (abono o cargo) con motivo obligatorio.
app.post('/api/admin/monederos/:clienteId/ajuste', requireAdmin, asyncRoute(async (req, res) => {
    const monto = round2(req.body.monto);
    const motivo = String(req.body.motivo || '').trim().slice(0, 140);
    if (!monto || Math.abs(monto) > 20000) return res.status(400).json({ message: 'El ajuste debe ser distinto de 0 y de máximo $20,000' });
    if (motivo.length < 5) return res.status(400).json({ message: 'Escribe el motivo del ajuste (queda en el historial)' });
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const m = await monederoDe(db, req.params.clienteId, { bloquear: true });
        const nuevo = round2(Number(m.saldo) + monto);
        if (nuevo < 0) throw Object.assign(new Error('El saldo no puede quedar negativo'), { status: 400 });
        if (nuevo > SALDO_MAX) throw Object.assign(new Error(`El saldo máximo es $${SALDO_MAX.toLocaleString('es-MX')}`), { status: 400 });
        await db.query('UPDATE monederos SET saldo = $1 WHERE id = $2', [nuevo, m.id]);
        await db.query(
            `INSERT INTO movimientos_monedero (monedero_id, tipo, monto, saldo_anterior, saldo_nuevo, concepto, usuario_id)
             VALUES ($1,'ajuste',$2,$3,$4,$5,$6)`, [m.id, monto, m.saldo, nuevo, `Ajuste: ${motivo}`, req.usuario.id]);
        await seg.registrarEvento(req, { tipo: 'ajuste_monedero', severidad: 'baja', usuario_id: req.usuario.id, detalle: `Ajuste de ${monto} al monedero del cliente ${req.params.clienteId}: ${motivo}` });
        await db.query('COMMIT');
        res.json({ message: 'Ajuste aplicado', saldo: nuevo });
    } catch (e) {
        await db.query('ROLLBACK');
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    } finally { db.release(); }
}));

app.put('/api/admin/monederos/:clienteId/estado', requireAdmin, asyncRoute(async (req, res) => {
    const estado = req.body.estado === 'bloqueado' ? 'bloqueado' : 'activo';
    await monederoDe(pool, req.params.clienteId);
    await pool.query('UPDATE monederos SET estado = $1 WHERE cliente_id = $2', [estado, req.params.clienteId]);
    res.json({ message: estado === 'bloqueado' ? 'Monedero bloqueado' : 'Monedero activado' });
}));

// Confirmar o rechazar una recarga por transferencia.
app.put('/api/admin/monedero/movimientos/:movId', requireAdmin, asyncRoute(async (req, res) => {
    const accion = req.body.accion === 'rechazar' ? 'rechazar' : 'confirmar';
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const r = await db.query(`SELECT mm.*, m.cliente_id FROM movimientos_monedero mm JOIN monederos m ON m.id = mm.monedero_id
                                  WHERE mm.id = $1 AND mm.estado = 'pendiente' FOR UPDATE OF mm`, [req.params.movId]);
        const mov = r.rows[0];
        if (!mov) throw Object.assign(new Error('La recarga ya no está pendiente'), { status: 400 });
        if (accion === 'rechazar') {
            await db.query(`UPDATE movimientos_monedero SET estado = 'rechazado', usuario_id = $2, concepto = 'Recarga por transferencia (rechazada)' WHERE id = $1`, [mov.id, req.usuario.id]);
        } else {
            const m = await monederoDe(db, mov.cliente_id, { bloquear: true });
            const nuevo = round2(Number(m.saldo) + Number(mov.monto));
            if (nuevo > SALDO_MAX) throw Object.assign(new Error('Con esta recarga se pasaría del saldo máximo'), { status: 400 });
            await db.query('UPDATE monederos SET saldo = $1 WHERE id = $2', [nuevo, m.id]);
            await db.query(`UPDATE movimientos_monedero SET estado = 'aplicado', saldo_anterior = $2, saldo_nuevo = $3, usuario_id = $4,
                                   concepto = 'Recarga por transferencia', fecha = CURRENT_TIMESTAMP WHERE id = $1`, [mov.id, m.saldo, nuevo, req.usuario.id]);
        }
        const c = (await db.query('SELECT nombre, correo FROM clientes WHERE id = $1', [mov.cliente_id])).rows[0];
        await enviarCorreo(db, { para: c.correo, tipo: 'monedero', cliente_id: mov.cliente_id,
            asunto: accion === 'confirmar' ? 'Tu recarga ya está en tu monedero' : 'No pudimos confirmar tu recarga',
            cuerpo: accion === 'confirmar' ? `Hola ${c.nombre}:\n\nConfirmamos tu transferencia ${mov.referencia} por $${mov.monto}. Ya está en tu monedero.`
                : `Hola ${c.nombre}:\n\nNo encontramos la transferencia ${mov.referencia}. Si ya pagaste, responde este correo con tu comprobante.` });
        await db.query('COMMIT');
        res.json({ message: accion === 'confirmar' ? 'Recarga confirmada y saldo actualizado' : 'Recarga rechazada' });
    } catch (e) {
        await db.query('ROLLBACK');
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    } finally { db.release(); }
}));

// ---- Pagos ----
app.get('/api/admin/pagos', requireAdmin, asyncRoute(async (req, res) => {
    const metodo = ['tarjeta', 'paypal', 'transferencia', 'monedero', 'efectivo', 'tienda'].includes(req.query.metodo) ? req.query.metodo : null;
    const estado = ['pendiente', 'aprobado', 'rechazado', 'reembolsado', 'cancelado'].includes(req.query.estado) ? req.query.estado : null;
    const [lista, porMetodo] = await Promise.all([
        pool.query(`
            SELECT pg.id, pg.pedido_id, pg.monto::float AS monto, pg.metodo_pago, pg.detalle, pg.referencia, pg.estado, pg.fecha, pg.fecha_confirmacion,
                   p.numero_orden, p.origen, p.estado AS pedido_estado, COALESCE(c.nombre, 'Cliente eliminado') AS cliente_nombre
            FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id LEFT JOIN clientes c ON c.id = p.cliente_id
            WHERE ($1::text IS NULL OR pg.metodo_pago = $1) AND ($2::text IS NULL OR pg.estado = $2)
            ORDER BY pg.fecha DESC LIMIT 300`, [metodo, estado]),
        pool.query(`
            SELECT metodo_pago, COUNT(*)::int AS pagos, COALESCE(SUM(monto) FILTER (WHERE estado = 'aprobado'), 0)::float AS cobrado,
                   COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes
            FROM pagos GROUP BY metodo_pago ORDER BY cobrado DESC`),
    ]);
    res.json({ pagos: lista.rows, por_metodo: porMetodo.rows });
}));

// ---- Resumen de la tienda en línea (reportes del negocio electrónico) ----
app.get('/api/admin/tienda/resumen', requireAdmin, asyncRoute(async (req, res) => {
    const [k, metodos, carritos, promos, tickets, topPromo, impuestosMes, ventasDia] = await Promise.all([
        pool.query(`
            SELECT COALESCE(SUM(total) FILTER (WHERE pago_estado = 'pagado'), 0)::float AS ventas,
                   COUNT(*)::int AS pedidos,
                   COALESCE(AVG(total) FILTER (WHERE pago_estado = 'pagado'), 0)::float AS ticket_promedio,
                   COALESCE(SUM(descuento_promociones), 0)::float AS ahorro_promociones,
                   COUNT(*) FILTER (WHERE descuento_promociones > 0)::int AS pedidos_con_promocion,
                   COUNT(*) FILTER (WHERE pago_estado = 'pendiente')::int AS pagos_pendientes
            FROM pedidos WHERE origen = 'en_linea' AND estado <> 'cancelado' AND fecha_pedido >= DATE_TRUNC('month', CURRENT_DATE)`),
        pool.query(`
            SELECT pg.metodo_pago, COUNT(*)::int AS pagos, COALESCE(SUM(pg.monto), 0)::float AS monto
            FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id
            WHERE p.origen = 'en_linea' AND pg.estado = 'aprobado' GROUP BY pg.metodo_pago ORDER BY monto DESC`),
        pool.query(`
            SELECT COUNT(*) FILTER (WHERE ca.estado = 'activo' AND EXISTS (SELECT 1 FROM carrito_detalle d WHERE d.carrito_id = ca.id))::int AS activos,
                   COUNT(*) FILTER (WHERE ca.estado = 'convertido')::int AS convertidos,
                   COALESCE((SELECT SUM(d.precio_unitario * d.cantidad) FROM carrito_detalle d JOIN carrito c2 ON c2.id = d.carrito_id WHERE c2.estado = 'activo'), 0)::float AS valor_activos,
                   COUNT(*) FILTER (WHERE ca.estado = 'activo' AND ca.fecha_actualizacion < CURRENT_TIMESTAMP - INTERVAL '1 day'
                                    AND EXISTS (SELECT 1 FROM carrito_detalle d WHERE d.carrito_id = ca.id))::int AS sin_movimiento
            FROM carrito ca`),
        pool.query(`SELECT COUNT(*)::int AS vigentes FROM promociones WHERE estado = 'activa' AND CURRENT_DATE BETWEEN fecha_inicio AND fecha_fin`),
        pool.query(`SELECT estado, COUNT(*)::int AS total FROM tickets_atencion GROUP BY estado`),
        pool.query(`
            SELECT pr.nombre, COUNT(DISTINCT pd.pedido_id)::int AS pedidos, COALESCE(SUM((pd.precio_lista - pd.precio_unitario) * pd.cantidad), 0)::float AS ahorro
            FROM pedido_detalle pd JOIN promociones pr ON pr.id = pd.promocion_id JOIN pedidos p ON p.id = pd.pedido_id
            WHERE p.estado <> 'cancelado' GROUP BY pr.nombre ORDER BY pedidos DESC LIMIT 5`),
        pool.query(`
            SELECT COALESCE(SUM(impuestos), 0)::float AS impuestos FROM pedidos
            WHERE estado <> 'cancelado' AND pago_estado = 'pagado' AND fecha_pedido >= DATE_TRUNC('month', CURRENT_DATE)`),
        pool.query(`
            SELECT TO_CHAR(g.d, 'YYYY-MM-DD') AS dia, COALESCE(SUM(p.total), 0)::float AS ventas, COUNT(p.id)::int AS pedidos
            FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, INTERVAL '1 day') g(d)
            LEFT JOIN pedidos p ON p.fecha_pedido::date = g.d::date AND p.origen = 'en_linea' AND p.estado <> 'cancelado' AND p.pago_estado = 'pagado'
            GROUP BY g.d ORDER BY g.d`),
    ]);
    const conv = carritos.rows[0];
    res.json({
        mes: k.rows[0], por_metodo: metodos.rows, carritos: { ...conv, tasa_conversion: conv.activos + conv.convertidos ? Math.round(conv.convertidos * 100 / (conv.activos + conv.convertidos)) : 0 },
        promociones_vigentes: promos.rows[0].vigentes, top_promociones: topPromo.rows, tickets: tickets.rows,
        impuestos_mes: impuestosMes.rows[0].impuestos, ventas_por_dia: ventasDia.rows,
    });
}));

// ---- Correos enviados (bandeja de salida simulada) ----
app.get('/api/admin/correos', requireAdmin, asyncRoute(async (req, res) => {
    const tipo = String(req.query.tipo || '').slice(0, 20);
    const r = await pool.query(
        `SELECT id, para, asunto, tipo, fecha, LEFT(cuerpo, 160) AS vista FROM correos_salida
         WHERE ($1 = '' OR tipo = $1) ORDER BY fecha DESC LIMIT 200`, [tipo]);
    res.json(r.rows);
}));
app.get('/api/admin/correos/:id', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT * FROM correos_salida WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ message: 'Correo no encontrado' });
    res.json(r.rows[0]);
}));

// =========================================================
// ADMIN: SEGURIDAD (Etapa 5) — tablero de ataques y defensas
// =========================================================
app.get('/api/admin/seguridad/resumen', requireAdmin, asyncRoute(async (req, res) => {
    const [k, porTipo, eventos, intentos, bloqueos, sesiones, topIps] = await Promise.all([
        pool.query(`
            SELECT (SELECT COUNT(*)::int FROM intentos_login WHERE NOT exito AND fecha > CURRENT_TIMESTAMP - INTERVAL '24 hours') AS fallidos_24h,
                   (SELECT COUNT(*)::int FROM intentos_login WHERE exito AND fecha > CURRENT_TIMESTAMP - INTERVAL '24 hours') AS exitosos_24h,
                   (SELECT COUNT(*)::int FROM bloqueos WHERE levantado IS NULL AND hasta > CURRENT_TIMESTAMP) AS bloqueos_activos,
                   (SELECT COUNT(*)::int FROM eventos_seguridad WHERE tipo = 'inyeccion_sql' AND fecha > CURRENT_TIMESTAMP - INTERVAL '7 days') AS sqli_7d,
                   (SELECT COUNT(*)::int FROM eventos_seguridad WHERE tipo = 'xss' AND fecha > CURRENT_TIMESTAMP - INTERVAL '7 days') AS xss_7d,
                   (SELECT COUNT(*)::int FROM eventos_seguridad WHERE tipo IN ('sesion_robada','token_invalido','sesion_revocada') AND fecha > CURRENT_TIMESTAMP - INTERVAL '7 days') AS sesiones_7d,
                   (SELECT COUNT(*)::int FROM sesiones WHERE revocada IS NULL AND expira > CURRENT_TIMESTAMP) AS sesiones_activas`),
        pool.query(`SELECT tipo, COUNT(*)::int AS total FROM eventos_seguridad WHERE fecha > CURRENT_TIMESTAMP - INTERVAL '7 days' GROUP BY tipo ORDER BY total DESC`),
        pool.query(`
            SELECT e.*, c.nombre AS cliente_nombre, u.nombre AS usuario_nombre FROM eventos_seguridad e
            LEFT JOIN clientes c ON c.id = e.cliente_id LEFT JOIN usuarios u ON u.id = e.usuario_id
            ORDER BY e.fecha DESC LIMIT 150`),
        pool.query(`SELECT * FROM intentos_login ORDER BY fecha DESC LIMIT 150`),
        pool.query(`
            SELECT b.*, (b.levantado IS NULL AND b.hasta > CURRENT_TIMESTAMP) AS activo, u.nombre AS levantado_por_nombre
            FROM bloqueos b LEFT JOIN usuarios u ON u.id = b.levantado_por ORDER BY b.creado DESC LIMIT 60`),
        pool.query(`
            SELECT s.id, s.tipo, s.ip, s.user_agent, s.creada, s.ultimo_uso, s.expira,
                   COALESCE(c.nombre, u.nombre) AS dueno, COALESCE(c.correo, u.email) AS correo
            FROM sesiones s LEFT JOIN clientes c ON c.id = s.cliente_id LEFT JOIN usuarios u ON u.id = s.usuario_id
            WHERE s.revocada IS NULL AND s.expira > CURRENT_TIMESTAMP ORDER BY s.ultimo_uso DESC LIMIT 100`),
        pool.query(`
            SELECT ip, COUNT(*)::int AS fallos, COUNT(DISTINCT correo)::int AS cuentas, MAX(fecha) AS ultimo
            FROM intentos_login WHERE NOT exito AND fecha > CURRENT_TIMESTAMP - INTERVAL '24 hours'
            GROUP BY ip ORDER BY fallos DESC LIMIT 10`),
    ]);
    const C = seg.CONFIG;
    res.json({
        kpis: k.rows[0], eventos_por_tipo: porTipo.rows, eventos: eventos.rows, intentos: intentos.rows,
        bloqueos: bloqueos.rows, sesiones: sesiones.rows.map((x) => ({ ...x, actual: req.sesion && x.id === req.sesion.id })), top_ips: topIps.rows,
        config: {
            max_fallos_cuenta: C.maxFallosCuenta, max_fallos_ip: C.maxFallosIp, ventana_min: C.ventanaMin,
            bloqueo_cuenta_min: C.bloqueoCuentaMin, bloqueo_ip_min: C.bloqueoIpMin, horas_sesion_cliente: C.horasSesionCliente,
            horas_sesion_equipo: C.horasSesionEquipo, inactividad_min_equipo: C.minInactividadEquipo, filtro_sql: C.filtroSQL, costo_bcrypt: C.costoBcrypt,
        },
    });
}));
app.post('/api/admin/seguridad/bloqueos/:id/levantar', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query(`UPDATE bloqueos SET levantado = CURRENT_TIMESTAMP, levantado_por = $2 WHERE id = $1 AND levantado IS NULL RETURNING tipo, valor`, [req.params.id, req.usuario.id]);
    if (!r.rows[0]) return res.status(404).json({ message: 'El bloqueo ya no está activo' });
    await seg.registrarEvento(req, { tipo: 'desbloqueo', severidad: 'baja', usuario_id: req.usuario.id, detalle: `Se levantó el bloqueo de ${r.rows[0].tipo} ${r.rows[0].valor}` });
    res.json({ message: 'Bloqueo levantado' });
}));
app.post('/api/admin/seguridad/sesiones/:id/revocar', requireAdmin, asyncRoute(async (req, res) => {
    await seg.revocarSesion(req.params.id, `revocada por ${req.usuario.nombre}`);
    await seg.registrarEvento(req, { tipo: 'sesion_revocada_admin', severidad: 'baja', usuario_id: req.usuario.id, detalle: `Sesión #${req.params.id} revocada desde el panel` });
    res.json({ message: 'Sesión cerrada' });
}));

// =========================================================
// ADMIN: GARANTÍAS EXTENDIDAS
// =========================================================
function conVigencia(g) {
    const hoy = new Date(new Date().toDateString());
    return {
        ...g,
        vencida: g.estado === 'activa' && new Date(g.vence) < hoy,
        dias_restantes: Math.ceil((new Date(g.vence) - hoy) / 86400000),
    };
}

app.get('/api/admin/garantias', asyncRoute(async (req, res) => {
    const { estado, busqueda } = req.query;
    const cond = [];
    const vals = [];
    let i = 1;
    if (estado && estado !== 'Todas') { cond.push(`g.estado = $${i++}`); vals.push(estado); }
    if (busqueda) {
        cond.push(`(g.folio ILIKE $${i} OR g.codigo ILIKE $${i} OR c.nombre ILIKE $${i} OR pr.nombre ILIKE $${i} OR ped.numero_orden ILIKE $${i})`);
        vals.push(`%${busqueda}%`); i++;
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(
        `SELECT g.id, g.folio, g.codigo, g.plan, g.meses, g.costo, g.inicio, g.vence, g.estado,
                g.reclamo_fecha, g.reclamo_desc, g.resuelto_fecha, g.resuelto_nota,
                c.id AS cliente_id, c.nombre AS cliente_nombre, c.correo AS cliente_correo,
                pr.nombre AS producto, ped.numero_orden, u.nombre AS resuelto_por_nombre
         FROM garantias g
         LEFT JOIN clientes c ON c.id = g.cliente_id
         LEFT JOIN productos pr ON pr.id = g.producto_id
         LEFT JOIN pedidos ped ON ped.id = g.pedido_id
         LEFT JOIN usuarios u ON u.id = g.resuelto_por
         ${where} ORDER BY g.reclamo_fecha DESC NULLS LAST, g.id DESC`,
        vals
    );
    const conteos = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE estado='activa') AS activas,
                COUNT(*) FILTER (WHERE estado='activa' AND reclamo_fecha IS NOT NULL) AS con_reclamo,
                COUNT(*) FILTER (WHERE estado='usada') AS usadas,
                COUNT(*) FILTER (WHERE estado IN ('vencida','cancelada')) AS inactivas
         FROM garantias`
    );
    res.json({ conteos: conteos.rows[0], garantias: r.rows.map(conVigencia) });
}));

// Validar una garantía por su código (herramienta de mostrador)
app.get('/api/admin/garantias/validar/:codigo', asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT g.id, g.folio, g.codigo, g.plan, g.meses, g.costo, g.inicio, g.vence, g.estado,
                g.reclamo_fecha, g.reclamo_desc, g.resuelto_fecha, g.resuelto_nota,
                c.id AS cliente_id, c.nombre AS cliente_nombre, c.correo AS cliente_correo,
                pr.nombre AS producto, ped.numero_orden
         FROM garantias g
         LEFT JOIN clientes c ON c.id = g.cliente_id
         LEFT JOIN productos pr ON pr.id = g.producto_id
         LEFT JOIN pedidos ped ON ped.id = g.pedido_id
         WHERE UPPER(g.codigo) = UPPER($1)`,
        [req.params.codigo.trim()]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: 'No existe una garantía con ese código' });
    const g = conVigencia(r.rows[0]);
    g.valida = g.estado === 'activa' && !g.vencida;
    res.json(g);
}));

// Resolver una garantía: marcarla como usada (o cerrar el reclamo)
app.put('/api/admin/garantias/:id', asyncRoute(async (req, res) => {
    const { estado, nota } = req.body;
    const validos = ['activa', 'usada', 'vencida', 'cancelada'];
    if (!validos.includes(estado)) return res.status(400).json({ message: 'Estado no válido' });
    const activa = estado === 'activa';
    const r = await pool.query(
        `UPDATE garantias
         SET estado = $1,
             resuelto_nota = $2,
             resuelto_por = $3,
             resuelto_fecha = CASE WHEN $5 THEN CURRENT_TIMESTAMP ELSE resuelto_fecha END,
             reclamo_fecha  = CASE WHEN $6 THEN NULL ELSE reclamo_fecha END
         WHERE id = $4 RETURNING *`,
        [estado, (nota || '').slice(0, 800) || null, req.usuario.id, req.params.id, !activa, activa]
    );
    if (r.rows.length === 0) return res.status(404).json({ message: 'Garantía no encontrada' });
    res.json({ message: 'Garantía actualizada', garantia: r.rows[0] });
}));

// =========================================================
// ADMIN: USUARIOS (equipo interno) + "Mi actividad"
// =========================================================

app.get('/api/admin/usuarios', asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT id, nombre, email, telefono, rol, activo, ultimo_login FROM usuarios ORDER BY id ASC');
    res.json(result.rows);
}));

// Catálogo de roles internos (para poblar el selector "Nueva cuenta")
app.get('/api/admin/roles', requireUsuario, asyncRoute(async (req, res) => {
    res.json(Object.entries(ROLES_INTERNOS).map(([clave, r]) => ({ clave, ...r })));
}));

app.post('/api/admin/usuarios', requireAdmin, asyncRoute(async (req, res) => {
    const { nombre, email, password, telefono, rol, activo } = req.body;
    if (!nombre || !email || !password) return res.status(400).json({ message: 'Nombre, email y contraseña son obligatorios' });
    if (!seg.correoValido(email)) return res.status(400).json({ message: 'El email no es válido' });
    const errPass = seg.validarPassword(password, { correo: email, nombre });
    if (errPass) return res.status(400).json({ message: errPass });
    if (!ROLES_INTERNOS[rol]) return res.status(400).json({ message: 'Rol no válido' });
    const existe = await pool.query('SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
    if (existe.rows.length > 0) return res.status(400).json({ message: 'El email ya está registrado' });

    const hash = await seg.hashPassword(password);
    const result = await pool.query(
        `INSERT INTO usuarios (nombre, email, password_hash, telefono, rol, activo)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nombre, email, telefono, rol, activo`,
        [nombre, seg.normalizarCorreo(email), hash, telefono || null, rol, activo !== undefined ? activo : true]
    );
    res.status(201).json({ message: 'Usuario creado', usuario: result.rows[0] });
}));

// Cambiar el rol de un usuario interno (solo admin). El admin no puede
// quitarse a sí mismo el rol de administrador para no quedarse fuera.
app.put('/api/admin/usuarios/:id/rol', requireAdmin, asyncRoute(async (req, res) => {
    const { rol } = req.body;
    if (!ROLES_INTERNOS[rol]) return res.status(400).json({ message: 'Rol no válido (admin, ventas o logistica)' });
    if (String(req.params.id) === String(req.usuario.id) && rol !== 'admin') {
        return res.status(400).json({ message: 'No puedes quitarte tu propio rol de administrador' });
    }
    const r = await pool.query('UPDATE usuarios SET rol = $1 WHERE id = $2 RETURNING id, nombre, email, rol, activo', [rol, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ message: `Rol actualizado a ${ROLES_INTERNOS[rol].nombre}`, usuario: r.rows[0] });
}));

// GET /usuarios/rol: rol del usuario con sesión y sus permisos (lo que
// arma el menú dinámico).
app.get('/api/usuarios/rol', requireUsuario, (req, res) => {
    const rol = req.usuario.rol;
    res.json({ rol, nombre: (ROLES_INTERNOS[rol] || {}).nombre || rol, permisos: PERMISOS[rol] || [] });
});

app.get('/api/usuarios/:id/actividad', requireUsuario, asyncRoute(async (req, res) => {
    if (req.usuario.rol !== 'admin' && String(req.usuario.id) !== String(req.params.id)) {
        return res.status(403).json({ message: 'Solo puedes ver tu propia actividad' });
    }
    const result = await pool.query(`
        SELECT i.fecha, c.nombre AS cliente, i.tipo, i.descripcion
        FROM interacciones i JOIN clientes c ON i.cliente_id = c.id
        WHERE i.usuario_id = $1 ORDER BY i.fecha DESC LIMIT 100
    `, [req.params.id]);
    res.json(result.rows);
}));

// =========================================================
app.get('/api', (req, res) => res.json({ status: 'ok', message: 'API Kozmok activa' }));

// Bases cargadas con una versión anterior de database.sql: agrega lo que
// falte sin tener que recargar todo (y sin tocar lo que ya existe).
async function migrarEsquema() {
    await pool.query('ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS direccion VARCHAR(200)');
    const costo = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'productos' AND column_name = 'costo_unitario'`
    );
    if (costo.rows.length === 0) {
        await pool.query('ALTER TABLE productos ADD COLUMN costo_unitario NUMERIC(10,2) CHECK (costo_unitario >= 0)');
        await pool.query('UPDATE productos SET costo_unitario = ROUND(precio * 0.7, 2)');
    }
    await pool.query('ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS fecha_estimada DATE');
    await pool.query(`
        UPDATE ordenes_compra oc SET fecha_estimada = oc.fecha_creacion::date + pr.tiempo_entrega_dias
        FROM proveedores pr WHERE pr.id = oc.proveedor_id AND oc.fecha_estimada IS NULL`);
    await pool.query(`CREATE TABLE IF NOT EXISTS config_scm (clave VARCHAR(40) PRIMARY KEY, valor VARCHAR(40) NOT NULL)`);

    // Etapa 3: roles empresariales Administrador / Ventas / Logística.
    // vendedor y soporte pasan a Ventas; almacén pasa a Logística.
    const rolCheck = await pool.query(`
        SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conrelid = 'usuarios'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%rol%'`);
    if (!rolCheck.rows.some((r) => r.def.includes('logistica'))) {
        const viejos = await pool.query(`
            SELECT c.conname FROM pg_constraint c
            WHERE c.conrelid = 'usuarios'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%rol%'`);
        for (const v of viejos.rows) await pool.query(`ALTER TABLE usuarios DROP CONSTRAINT "${v.conname}"`);
        await pool.query(`UPDATE usuarios SET rol = 'ventas' WHERE rol IN ('vendedor','soporte')`);
        await pool.query(`UPDATE usuarios SET rol = 'logistica' WHERE rol = 'almacen'`);
        await pool.query(`ALTER TABLE usuarios ALTER COLUMN rol SET DEFAULT 'ventas'`);
        await pool.query(`ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (rol IN ('admin','ventas','logistica'))`);
        console.log('Roles migrados a Administrador / Ventas / Logística');
    }

    // Etapa 3: tablas propias del ERP.
    await pool.query(`CREATE TABLE IF NOT EXISTS estado_erp (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        modo VARCHAR(10) NOT NULL DEFAULT 'auto' CHECK (modo IN ('auto','manual')),
        nivel VARCHAR(15) NOT NULL DEFAULT 'basico' CHECK (nivel IN ('basico','integrado','automatizado','optimizado')),
        nota VARCHAR(300), usuario_id INTEGER REFERENCES usuarios(id), actualizado TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS procesos_erp (
        id SERIAL PRIMARY KEY, pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
        paso VARCHAR(30) NOT NULL, descripcion VARCHAR(300) NOT NULL, automatico BOOLEAN NOT NULL DEFAULT TRUE,
        usuario_id INTEGER REFERENCES usuarios(id), fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_procesos_erp_pedido ON procesos_erp(pedido_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS recursos_erp (
        id SERIAL PRIMARY KEY, nombre VARCHAR(120) NOT NULL,
        tipo VARCHAR(15) NOT NULL CHECK (tipo IN ('equipo','vehiculo','instalacion','presupuesto')),
        area VARCHAR(15) NOT NULL DEFAULT 'administracion' CHECK (area IN ('administracion','ventas','logistica')),
        descripcion VARCHAR(300), cantidad INTEGER NOT NULL DEFAULT 1 CHECK (cantidad >= 0),
        valor DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (valor >= 0),
        estado VARCHAR(15) NOT NULL DEFAULT 'disponible' CHECK (estado IN ('disponible','en_uso','mantenimiento','baja')),
        responsable_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL, fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS reportes_erp (
        id SERIAL PRIMARY KEY, nombre VARCHAR(120) NOT NULL, desde DATE, hasta DATE, datos JSONB NOT NULL,
        usuario_id INTEGER REFERENCES usuarios(id), fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await migrarEtapa4();
}

// ---------------------------------------------------------
// Etapa 4 + seguridad sobre una base de una versión anterior. Las
// definiciones de las tablas nuevas se toman de db/database.sql (así no
// hay dos versiones del mismo CREATE TABLE).
// ---------------------------------------------------------
async function migrarEtapa4() {
    const fs = require('fs');
    const sql = fs.readFileSync(path.join(__dirname, 'db', 'database.sql'), 'utf8');
    const existe = async (t) => (await pool.query('SELECT to_regclass($1) AS r', [t])).rows[0].r !== null;
    const cambios = [];

    if (await existe('pedido_items') && !(await existe('pedido_detalle'))) { await pool.query('ALTER TABLE pedido_items RENAME TO pedido_detalle'); cambios.push('pedido_items → pedido_detalle'); }
    if (await existe('tickets') && !(await existe('tickets_atencion'))) { await pool.query('ALTER TABLE tickets RENAME TO tickets_atencion'); cambios.push('tickets → tickets_atencion'); }

    const NUEVAS = ['promociones', 'promocion_productos', 'impuestos', 'carrito', 'carrito_detalle', 'pagos', 'monederos',
        'movimientos_monedero', 'sesiones', 'intentos_login', 'bloqueos', 'eventos_seguridad', 'recuperaciones', 'correos_salida'];
    const faltan = [];
    for (const t of NUEVAS) if (!(await existe(t))) faltan.push(t);
    for (const m of sql.matchAll(/^CREATE TABLE (\w+) \(\n[\s\S]*?\n\);/gm)) {
        if (faltan.includes(m[1])) await pool.query(m[0].replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS '));
    }
    for (const m of sql.matchAll(/^CREATE (UNIQUE )?INDEX (\w+) ON (\w+)([^;]*);/gm)) {
        if (NUEVAS.includes(m[3]) || ['pedidos', 'pedido_detalle'].includes(m[3])) {
            await pool.query(`CREATE ${m[1] || ''}INDEX IF NOT EXISTS ${m[2]} ON ${m[3]}${m[4]}`);
        }
    }
    if (faltan.length) cambios.push('tablas nuevas: ' + faltan.join(', '));

    await pool.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS destacado BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS carrito_id INTEGER REFERENCES carrito(id) ON DELETE SET NULL');
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS impuestos_detalle JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS descuento_promociones NUMERIC(12,2) NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE pedido_detalle ADD COLUMN IF NOT EXISTS precio_lista NUMERIC(10,2)');
    await pool.query('ALTER TABLE pedido_detalle ADD COLUMN IF NOT EXISTS promocion_id INTEGER REFERENCES promociones(id) ON DELETE SET NULL');
    for (const c of ['mensaje TEXT', 'respuesta TEXT', 'fecha_respuesta TIMESTAMP', 'respondido_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL']) {
        await pool.query(`ALTER TABLE tickets_atencion ADD COLUMN IF NOT EXISTS ${c}`);
    }
    // El estado "respondido" de los tickets es nuevo.
    const chk = await pool.query(`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'tickets_atencion'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%en_proceso%'`);
    if (chk.rows.length && !chk.rows.some((r) => r.def.includes('respondido'))) {
        for (const r of chk.rows) await pool.query(`ALTER TABLE tickets_atencion DROP CONSTRAINT "${r.conname}"`);
        await pool.query(`ALTER TABLE tickets_atencion ADD CONSTRAINT tickets_atencion_estado_check CHECK (estado IN ('abierto','en_proceso','respondido','resuelto','cerrado'))`);
    }
    await pool.query(`UPDATE tickets_atencion t SET mensaje = (SELECT m.mensaje FROM ticket_mensajes m WHERE m.ticket_id = t.id AND m.autor = 'cliente' ORDER BY m.fecha, m.id LIMIT 1) WHERE t.mensaje IS NULL`);

    // Carrito anterior (carrito_items por cliente) → carrito + carrito_detalle.
    if (await existe('carrito_items')) {
        await pool.query(`INSERT INTO carrito (cliente_id) SELECT DISTINCT cliente_id FROM carrito_items WHERE cliente_id IS NOT NULL
                          ON CONFLICT (cliente_id) WHERE estado = 'activo' DO NOTHING`);
        await pool.query(`
            INSERT INTO carrito_detalle (carrito_id, producto_id, cantidad, precio_unitario, garantia_clave, garantia_plan, garantia_meses, garantia_costo, fecha_agregado)
            SELECT ca.id, ci.producto_id, LEAST(SUM(ci.cantidad), 99), MAX(p.precio), MAX(ci.garantia_clave), MAX(ci.garantia_plan), MAX(ci.garantia_meses), SUM(ci.garantia_costo), MIN(ci.fecha_agregado)
            FROM carrito_items ci JOIN carrito ca ON ca.cliente_id = ci.cliente_id AND ca.estado = 'activo' JOIN productos p ON p.id = ci.producto_id
            GROUP BY ca.id, ci.producto_id
            ON CONFLICT (carrito_id, producto_id) DO NOTHING`);
        await pool.query('DROP TABLE carrito_items');
        cambios.push('carrito_items → carrito + carrito_detalle');
    }

    // Datos base: IVA, pagos y desglose de impuestos de pedidos anteriores, monederos.
    const imp = await pool.query('SELECT COUNT(*)::int AS n FROM impuestos');
    if (imp.rows[0].n === 0) await pool.query(`INSERT INTO impuestos (nombre, descripcion, porcentaje, estado) VALUES ('IVA', 'Impuesto al Valor Agregado', 16, 'activo')`);
    await pool.query(`UPDATE pedidos SET impuestos_detalle = jsonb_build_array(jsonb_build_object('nombre', 'IVA', 'porcentaje', 16, 'monto', impuestos))
                      WHERE impuestos_detalle = '[]'::jsonb AND impuestos > 0`);
    const pg = await pool.query(`
        INSERT INTO pagos (pedido_id, monto, metodo_pago, detalle, referencia, estado, fecha, fecha_confirmacion)
        SELECT p.id, p.total,
               CASE WHEN p.metodo_pago ILIKE '%efectivo%' THEN 'efectivo'
                    WHEN p.metodo_pago ILIKE '%transfer%' OR p.metodo_pago ILIKE '%spei%' THEN 'transferencia'
                    WHEN p.metodo_pago ILIKE '%tienda%' THEN 'tienda' ELSE 'tarjeta' END,
               LEFT(p.metodo_pago, 120), p.pago_referencia,
               CASE WHEN p.estado = 'cancelado' THEN 'cancelado' WHEN p.pago_estado = 'pagado' THEN 'aprobado' ELSE 'pendiente' END,
               p.fecha_pedido, CASE WHEN p.pago_estado = 'pagado' THEN COALESCE(p.fecha_confirmacion, p.fecha_pedido) END
        FROM pedidos p WHERE NOT EXISTS (SELECT 1 FROM pagos x WHERE x.pedido_id = p.id)`);
    if (pg.rowCount) cambios.push(`${pg.rowCount} pagos registrados de pedidos anteriores`);
    await pool.query('INSERT INTO monederos (cliente_id) SELECT id FROM clientes ON CONFLICT (cliente_id) DO NOTHING');
    for (const [t, trg] of [['carrito', 'trg_carrito_fecha'], ['impuestos', 'trg_impuestos_fecha'], ['monederos', 'trg_monederos_fecha']]) {
        const e = await pool.query('SELECT 1 FROM pg_trigger WHERE tgname = $1', [trg]);
        if (!e.rows.length) await pool.query(`CREATE TRIGGER ${trg} BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION actualizar_fecha()`);
    }
    if (cambios.length) console.log('Base actualizada a la Etapa 4:', cambios.join('; '));
}

// Errores que no atrapó ninguna ruta (JSON mal formado, cuerpo muy
// grande...): respuesta corta, sin pila ni detalles internos.
app.use('/api', (req, res) => res.status(404).json({ message: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ message: 'El cuerpo de la petición no es JSON válido' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ message: 'La petición es demasiado grande' });
    console.error('Error no controlado ->', err && err.message);
    res.status(500).json({ message: 'Ocurrió un error interno. Intenta de nuevo.' });
});

app.listen(PORT, async () => {
    console.log(`Kozmok escuchando en http://localhost:${PORT}`);
    // Ping a la base para dejar claro en el arranque si conectó o no.
    try {
        const r = await pool.query('SELECT COUNT(*)::int AS n FROM productos');
        console.log(`Base de datos: conectada (${dbConfig.database}@${dbConfig.host}:${dbConfig.port}) - ${r.rows[0].n} productos`);
        if (usaValoresPorDefecto) console.warn('Aviso: no hay archivo .env; se usa la contraseña de PostgreSQL por defecto. Copia .env.example como .env.');
        console.log(`Seguridad: sesiones en cookie HttpOnly, bloqueo tras ${seg.CONFIG.maxFallosCuenta} intentos, filtro SQL "${seg.CONFIG.filtroSQL}".`);
        await migrarEsquema();
        await tareasPeriodicas();
        setInterval(tareasPeriodicas, 60 * 1000);
    } catch (err) {
        if (/relation .* does not exist/i.test(err.message)) {
            console.error(`Base de datos: conectada a ${dbConfig.database}, pero SIN TABLAS. Carga db/database.sql.`);
        } else {
            console.error(`Base de datos: SIN CONEXION — ${err.message}`);
            console.error('  Revisa que PostgreSQL esté encendido y que db.config.js tenga usuario/contraseña/puerto correctos.');
        }
    }
});
