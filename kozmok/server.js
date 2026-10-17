// =========================================================
//  Kozmok CRM - Backend (Express + PostgreSQL)
// =========================================================
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const path = require('path');
const { Pool } = require('pg');
const dbConfig = require('./db.config.js');
// Permisos por rol: el mismo archivo que arma el menú del panel.
const { PERMISOS, puedeVer } = require('./public/admin/js/permisos.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool(dbConfig);

// Solo se registran errores reales del servidor en la consola; nada
// decorativo. El cliente nunca ve mensajes de consola: la UI usa toasts.

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(req.method, req.originalUrl, '->', err.message);
    res.status(500).json({ error: 'Error del servidor', detalle: err.message });
});

// =========================================================
// MIDDLEWARE DE AUTENTICACIÓN (equipo interno)
// El token es el Base64 "usuario:<id>:<timestamp>" que emite
// /api/auth/login-usuario. Se envía en el header Authorization.
// =========================================================
async function requireUsuario(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return res.status(401).json({ message: 'Sesión no encontrada. Inicia sesión de nuevo.' });

        const decoded = Buffer.from(token, 'base64').toString('utf8'); // "usuario:<id>:<ts>"
        const [tipo, id] = decoded.split(':');
        if (tipo !== 'usuario' || !id) return res.status(401).json({ message: 'Token inválido' });

        const result = await pool.query('SELECT id, nombre, email, rol, activo FROM usuarios WHERE id = $1', [id]);
        if (result.rows.length === 0 || !result.rows[0].activo) {
            return res.status(403).json({ message: 'Cuenta inactiva o inexistente' });
        }
        req.usuario = result.rows[0];
        next();
    } catch (e) {
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
    admin:     { nombre: 'Administrador', descripcion: 'Acceso total: CRM, SCM y ERP, cuentas, Nivel ERP y Panel por rol.' },
    ventas:    { nombre: 'Ventas',        descripcion: 'Clientes (CRM), consulta de productos y captura de órdenes de clientes (ERP).' },
    logistica: { nombre: 'Logística',     descripcion: 'Productos, inventario, proveedores y reposición (SCM); surte y envía las órdenes (ERP).' },
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
// Token Base64 "cliente:<id>:<timestamp>" que emiten
// login-cliente y registro-cliente. Obliga a iniciar sesión
// para el carrito, los pedidos y el perfil.
// =========================================================
async function requireCliente(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return res.status(401).json({ message: 'Inicia sesión para continuar' });

        const decoded = Buffer.from(token, 'base64').toString('utf8'); // "cliente:<id>:<ts>"
        const [tipo, id] = decoded.split(':');
        if (tipo !== 'cliente' || !id) return res.status(401).json({ message: 'Sesión no válida' });

        const r = await pool.query(
            "SELECT id, nombre, correo FROM clientes WHERE id = $1 AND estado_cliente = 'activo'",
            [id]
        );
        if (r.rows.length === 0) return res.status(401).json({ message: 'Sesión no válida' });
        req.cliente = r.rows[0];
        next();
    } catch (e) {
        return res.status(401).json({ message: 'Inicia sesión para continuar' });
    }
}

// El :id de la ruta debe ser el propio cliente autenticado.
function mismoCliente(req, res, next) {
    if (String(req.cliente.id) !== String(req.params.id)) {
        return res.status(403).json({ message: 'No puedes ver ni modificar datos de otra cuenta' });
    }
    next();
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
// AUTENTICACIÓN
// =========================================================

// Login de cliente (tienda)
app.post('/api/auth/login-cliente', asyncRoute(async (req, res) => {
    const { correo, password } = req.body;
    if (!correo || !password) return res.status(400).json({ message: 'Correo y contraseña son requeridos' });

    const result = await pool.query(
        `SELECT * FROM clientes WHERE correo = $1 AND estado_cliente = 'activo'`,
        [correo]
    );
    if (result.rows.length === 0) return res.status(401).json({ message: 'Correo o contraseña incorrectos' });

    const cliente = result.rows[0];
    const valido = await bcrypt.compare(password, cliente.password).catch(() => false);
    if (!valido) return res.status(401).json({ message: 'Correo o contraseña incorrectos' });

    await pool.query('UPDATE clientes SET ultimo_login = CURRENT_TIMESTAMP WHERE id = $1', [cliente.id]);
    delete cliente.password;
    const token = Buffer.from(`cliente:${cliente.id}:${Date.now()}`).toString('base64');
    res.json({ success: true, cliente, token });
}));

// Registro de cliente
app.post('/api/auth/registro-cliente', asyncRoute(async (req, res) => {
    const { nombre, correo, password, telefono, empresa, ciudad, estado, direccion, codigo_postal } = req.body;
    if (!nombre || !correo || !password) return res.status(400).json({ message: 'Nombre, correo y contraseña son obligatorios' });
    if (password.length < 6) return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });

    const existe = await pool.query('SELECT id FROM clientes WHERE correo = $1', [correo]);
    if (existe.rows.length > 0) return res.status(400).json({ message: 'Este correo ya está registrado' });

    const hash = await bcrypt.hash(password, 10);

    // Código de socio único (reintenta si choca con uno existente)
    let codigoSocio;
    for (let intento = 0; intento < 5; intento++) {
        codigoSocio = generarCodigoSocio();
        const dup = await pool.query('SELECT 1 FROM clientes WHERE codigo_socio = $1', [codigoSocio]);
        if (dup.rows.length === 0) break;
    }

    const result = await pool.query(
        `INSERT INTO clientes (nombre, correo, password, telefono, empresa, ciudad, estado, direccion, codigo_postal, codigo_socio, estado_cliente, etapa_crm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'activo','Prospecto')
         RETURNING id, nombre, correo, telefono, empresa, ciudad, estado, codigo_socio, etapa_crm, fecha_registro`,
        [nombre, correo, hash, telefono, empresa, ciudad, estado, direccion, codigo_postal, codigoSocio]
    );
    const cliente = result.rows[0];
    await pool.query('INSERT INTO metricas_clientes (cliente_id) VALUES ($1)', [cliente.id]);

    const token = Buffer.from(`cliente:${cliente.id}:${Date.now()}`).toString('base64');
    res.status(201).json({ success: true, cliente, token });
}));

// Login de usuario interno (admin / ventas / logística). Responde también
// con los permisos del rol para armar el menú dinámico.
// /api/auth/login es el nombre del endpoint en el documento del ERP.
const loginUsuario = asyncRoute(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email y contraseña son requeridos' });

    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ message: 'Credenciales incorrectas' });

    const usuario = result.rows[0];
    if (!usuario.activo) return res.status(403).json({ message: 'Cuenta inactiva' });

    const valido = await bcrypt.compare(password, usuario.password_hash).catch(() => false);
    if (!valido) return res.status(401).json({ message: 'Credenciales incorrectas' });

    await pool.query('UPDATE usuarios SET ultimo_login = CURRENT_TIMESTAMP WHERE id = $1', [usuario.id]);
    delete usuario.password_hash;
    const token = Buffer.from(`usuario:${usuario.id}:${Date.now()}`).toString('base64');
    res.json({ success: true, usuario, token, permisos: PERMISOS[usuario.rol] || [] });
});
app.post('/api/auth/login-usuario', loginUsuario);
app.post('/api/auth/login', loginUsuario);

// =========================================================
// CATEGORÍAS Y PRODUCTOS (catálogo público)
// =========================================================

app.get('/api/categorias', asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT * FROM categorias ORDER BY id ASC');
    res.json(result.rows);
}));

// Catálogo con filtros: categoria, uso, precio_min, precio_max, busqueda
app.get('/api/productos', asyncRoute(async (req, res) => {
    // Atajo para el comparador: ?ids=1,2,3 (máximo 4)
    if (req.query.ids) {
        const ids = String(req.query.ids).split(',').map(Number).filter((n) => n > 0).slice(0, 4);
        if (ids.length === 0) return res.json([]);
        const r = await pool.query(
            `SELECT p.*, c.nombre AS categoria_nombre FROM productos p
             LEFT JOIN categorias c ON p.categoria_id = c.id WHERE p.id = ANY($1)`,
            [ids]
        );
        // respeta el orden pedido
        return res.json(ids.map((id) => r.rows.find((x) => x.id === id)).filter(Boolean));
    }

    const { categoria, uso, precio_min, precio_max, busqueda, marca } = req.query;
    const cond = ['p.activo = true'];
    const values = [];
    let i = 1;

    if (categoria) { cond.push(`c.nombre = $${i++}`); values.push(categoria); }
    if (uso) { cond.push(`$${i++} = ANY(p.uso_recomendado)`); values.push(uso); }
    if (marca) { cond.push(`p.marca ILIKE $${i++}`); values.push(`%${marca}%`); }
    if (precio_min) { cond.push(`p.precio >= $${i++}`); values.push(precio_min); }
    if (precio_max) { cond.push(`p.precio <= $${i++}`); values.push(precio_max); }
    if (busqueda) { cond.push(`(p.nombre ILIKE $${i} OR p.descripcion ILIKE $${i} OR p.marca ILIKE $${i})`); values.push(`%${busqueda}%`); i++; }

    const query = `
        SELECT p.*, c.nombre AS categoria_nombre, c.icono AS categoria_icono
        FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id
        WHERE ${cond.join(' AND ')}
        ORDER BY p.nombre ASC
    `;
    const result = await pool.query(query, values);
    res.json(result.rows);
}));

app.get('/api/productos/:id', asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT p.*, c.nombre AS categoria_nombre FROM productos p
         LEFT JOIN categorias c ON p.categoria_id = c.id WHERE p.id = $1`,
        [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json({ ...result.rows[0], garantias: planesParaProducto(result.rows[0].precio) });
}));

// Planes de garantía para un producto (los usa el modal del catálogo)
app.get('/api/productos/:id/garantias', asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT precio FROM productos WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(planesParaProducto(r.rows[0].precio));
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
    res.json({
        promedio: Number(stats.rows[0].promedio) || 0,
        total: stats.rows[0].total,
        resenas: lista.rows,
    });
}));

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
    const { presupuesto, uso, categoria, cliente_id, mensaje } = req.body;
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
// CARRITO  (requiere sesión de cliente)
// =========================================================
app.use('/api/carrito', requireCliente);

app.get('/api/carrito/:clienteId', asyncRoute(async (req, res) => {
    const clienteId = req.cliente.id; // el de la sesión, no el de la URL
    const result = await pool.query(
        `SELECT ci.id, ci.cantidad, ci.garantia_clave, ci.garantia_plan, ci.garantia_meses, ci.garantia_costo,
                p.id AS producto_id, p.nombre, p.precio, p.imagen_url, p.stock
         FROM carrito_items ci JOIN productos p ON ci.producto_id = p.id
         WHERE ci.cliente_id = $1 ORDER BY ci.fecha_agregado DESC`,
        [clienteId]
    );
    res.json(result.rows);
}));

app.post('/api/carrito', asyncRoute(async (req, res) => {
    const cliente_id = req.cliente.id;
    const { producto_id, cantidad = 1 } = req.body;
    const gClave = planGarantia(req.body.garantia).clave;

    const prod = await pool.query('SELECT precio FROM productos WHERE id = $1', [producto_id]);
    if (prod.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    const precio = prod.rows[0].precio;
    const gPlan = planGarantia(gClave);

    const existente = await pool.query(
        'SELECT id, cantidad, garantia_clave FROM carrito_items WHERE cliente_id = $1 AND producto_id = $2',
        [cliente_id, producto_id]
    );
    if (existente.rows.length > 0) {
        const row = existente.rows[0];
        const nuevaCantidad = row.cantidad + cantidad;
        // si se pidió una garantía explícita se toma esa; si no, se conserva la que ya tenía
        const claveFinal = (gClave !== 'none') ? gClave : row.garantia_clave;
        const pf = planGarantia(claveFinal);
        await pool.query(
            `UPDATE carrito_items SET cantidad = $1, garantia_clave = $2, garantia_plan = $3,
                 garantia_meses = $4, garantia_costo = $5 WHERE id = $6`,
            [nuevaCantidad, claveFinal, pf.meses ? pf.label : null, pf.meses, costoGarantia(precio, claveFinal) * nuevaCantidad, row.id]
        );
    } else {
        await pool.query(
            `INSERT INTO carrito_items (cliente_id, producto_id, cantidad, garantia_clave, garantia_plan, garantia_meses, garantia_costo)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [cliente_id, producto_id, cantidad, gClave, gPlan.meses ? gPlan.label : null, gPlan.meses, costoGarantia(precio, gClave) * cantidad]
        );
    }
    res.status(201).json({ message: 'Agregado al carrito' });
}));

app.put('/api/carrito/:id', asyncRoute(async (req, res) => {
    const cur = await pool.query(
        `SELECT ci.id, ci.cantidad, ci.garantia_clave, p.precio
         FROM carrito_items ci JOIN productos p ON p.id = ci.producto_id
         WHERE ci.id = $1 AND ci.cliente_id = $2`,
        [req.params.id, req.cliente.id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ message: 'Ítem no encontrado en tu carrito' });
    const row = cur.rows[0];
    const cantidad = req.body.cantidad !== undefined ? Math.max(1, Number(req.body.cantidad)) : row.cantidad;
    const gClave = req.body.garantia !== undefined ? planGarantia(req.body.garantia).clave : row.garantia_clave;
    const pf = planGarantia(gClave);
    await pool.query(
        `UPDATE carrito_items SET cantidad = $1, garantia_clave = $2, garantia_plan = $3,
             garantia_meses = $4, garantia_costo = $5 WHERE id = $6`,
        [cantidad, gClave, pf.meses ? pf.label : null, pf.meses, costoGarantia(row.precio, gClave) * cantidad, req.params.id]
    );
    res.json({ message: 'Carrito actualizado' });
}));

app.delete('/api/carrito', asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM carrito_items WHERE cliente_id = $1', [req.cliente.id]);
    res.json({ message: 'Carrito vaciado' });
}));

app.delete('/api/carrito/:id', asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM carrito_items WHERE id = $1 AND cliente_id = $2', [req.params.id, req.cliente.id]);
    res.json({ message: 'Producto eliminado del carrito' });
}));

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
    const items = await client.query('SELECT producto_id, cantidad FROM pedido_items WHERE pedido_id = $1', [pedido.id]);
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
    await client.query(`UPDATE pedidos SET estado = 'cancelado' WHERE id = $1`, [pedido.id]);
    return { canjeados, ganados, productos: items.rows.length };
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

app.post('/api/pedidos', requireCliente, asyncRoute(async (req, res) => {
    const cliente_id = req.cliente.id;
    const { items, metodo_pago, direccion_envio, notas } = req.body;
    const metodo_tipo = ['tarjeta', 'spei', 'tienda'].includes(req.body.metodo_tipo) ? req.body.metodo_tipo : 'tarjeta';
    let puntos_canjear = Math.max(0, Math.floor(Number(req.body.puntos_canjear) || 0));
    if (!items || items.length === 0) {
        return res.status(400).json({ message: 'El carrito no tiene productos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let subtotal = 0;
        let garantiasTotal = 0;
        const detalles = [];
        const numero_orden = 'ORD-' + Date.now();

        for (const item of items) {
            const prod = await client.query('SELECT precio, stock, nombre FROM productos WHERE id = $1 FOR UPDATE', [item.producto_id]);
            if (prod.rows.length === 0) throw new Error(`Producto ${item.producto_id} no encontrado`);
            const p = prod.rows[0];
            if (p.stock < item.cantidad) throw new Error(`Stock insuficiente para "${p.nombre}" (disponible: ${p.stock})`);

            const lineaSubtotal = p.precio * item.cantidad;
            subtotal += Number(lineaSubtotal);

            const gp = planGarantia(item.garantia);
            const gCosto = costoGarantia(p.precio, gp.clave) * item.cantidad;
            garantiasTotal += gCosto;

            detalles.push({
                producto_id: item.producto_id, cantidad: item.cantidad, precio_unitario: p.precio, subtotal: lineaSubtotal,
                garantia_clave: gp.clave, garantia_plan: gp.meses ? gp.label : null, garantia_meses: gp.meses, garantia_costo: gCosto,
            });

            await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [item.cantidad, item.producto_id]);
            await client.query(
                `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo) VALUES ($1,'salida',$2,$3)`,
                [item.producto_id, item.cantidad, `Venta en línea ${numero_orden}`]
            );
            await generarOrdenAutomaticaSiCritico(client, item.producto_id, 'demanda');
        }

        subtotal += garantiasTotal;
        const impuestos = Math.round(subtotal * 0.16 * 100) / 100;
        const envio = subtotal >= 10000 ? 0 : 199;

        // ---- Club: canje de puntos como descuento ----
        let descuento = 0;
        if (puntos_canjear > 0) {
            const cli = await client.query('SELECT puntos FROM clientes WHERE id = $1 FOR UPDATE', [cliente_id]);
            const saldo = cli.rows[0].puntos;
            puntos_canjear = Math.min(puntos_canjear, saldo);
            puntos_canjear = puntos_canjear - (puntos_canjear % 100);          // solo múltiplos de 100
            descuento = Math.min(puntos_canjear * VALOR_PUNTO, subtotal);      // nunca deja el subtotal en negativo
            puntos_canjear = Math.round(descuento / VALOR_PUNTO);
        }

        const total = Math.round((subtotal + impuestos + envio - descuento) * 100) / 100;

        // Tarjeta = se paga al instante. SPEI / tienda = pago pendiente + código.
        const inmediato = metodo_tipo === 'tarjeta';
        const pago_estado = inmediato ? 'pagado' : 'pendiente';
        const estado = inmediato ? 'confirmado' : 'pendiente';
        const pago_referencia = inmediato ? null : generarReferenciaPago(metodo_tipo);
        const pago_vence = inmediato ? null : new Date(Date.now() + (metodo_tipo === 'spei' ? 3 : 5) * 86400000);

        const pedido = await client.query(
            `INSERT INTO pedidos (numero_orden, cliente_id, subtotal, impuestos, envio, descuento, total, estado,
                                  metodo_pago, pago_estado, pago_referencia, pago_vence, direccion_envio, notas, fecha_confirmacion)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [numero_orden, cliente_id, subtotal, impuestos, envio, descuento, total, estado,
                metodo_pago, pago_estado, pago_referencia, pago_vence, direccion_envio, notas,
                inmediato ? new Date() : null]
        );
        const pedidoId = pedido.rows[0].id;

        for (const d of detalles) {
            const it = await client.query(
                `INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unitario, subtotal, garantia_plan, garantia_meses, garantia_costo)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
                [pedidoId, d.producto_id, d.cantidad, d.precio_unitario, d.subtotal, d.garantia_plan, d.garantia_meses, d.garantia_costo]
            );
            if (d.garantia_meses > 0) {
                const vence = new Date();
                vence.setMonth(vence.getMonth() + d.garantia_meses);
                const g = await client.query(
                    `INSERT INTO garantias (folio, codigo, pedido_id, pedido_item_id, cliente_id, producto_id, plan, meses, costo, inicio, vence)
                     VALUES ('GAR-TMP', $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE, $9)
                     RETURNING id`,
                    [codigoGarantia(), pedidoId, it.rows[0].id, cliente_id, d.producto_id, d.garantia_plan, d.garantia_meses, d.garantia_costo, vence.toISOString().slice(0, 10)]
                );
                await client.query(`UPDATE garantias SET folio = 'GAR-' || (100000 + id) WHERE id = $1`, [g.rows[0].id]);
            }
        }

        // El canje de puntos siempre se retiene al crear el pedido (si se
        // cancela, se devuelve). Los puntos GANADOS y las métricas solo se
        // aplican cuando el pago está confirmado.
        if (puntos_canjear > 0) {
            await client.query('UPDATE clientes SET puntos = puntos - $1 WHERE id = $2', [puntos_canjear, cliente_id]);
            await client.query(
                `INSERT INTO movimientos_puntos (cliente_id, tipo, puntos, motivo, pedido_id) VALUES ($1,'canjeado',$2,$3,$4)`,
                [cliente_id, -puntos_canjear, `Descuento en ${numero_orden}`, pedidoId]
            );
        }

        let puntos_ganados = 0;
        if (inmediato) {
            puntos_ganados = await aplicarCobroPedido(client, pedido.rows[0]);
        }

        await client.query('DELETE FROM carrito_items WHERE cliente_id = $1', [cliente_id]);
        await client.query('COMMIT');

        res.status(201).json({
            ...pedido.rows[0], puntos_ganados, puntos_canjeados: puntos_canjear,
            metodo_tipo, garantias_total: garantiasTotal,
        });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: error.message });
    } finally {
        client.release();
    }
}));

app.get('/api/pedidos/cliente/:clienteId', requireCliente, asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT p.*, STRING_AGG(pr.nombre, ', ') AS productos
         FROM pedidos p LEFT JOIN pedido_items pi ON p.id = pi.pedido_id
         LEFT JOIN productos pr ON pi.producto_id = pr.id
         WHERE p.cliente_id = $1 GROUP BY p.id ORDER BY p.fecha_pedido DESC`,
        [req.cliente.id]
    );
    res.json(result.rows);
}));

app.get('/api/pedidos/:id/detalle', asyncRoute(async (req, res) => {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
    if (pedido.rows.length === 0) return res.status(404).json({ message: 'Pedido no encontrado' });
    const items = await pool.query(
        `SELECT pi.*, p.nombre, p.imagen_url FROM pedido_items pi JOIN productos p ON pi.producto_id = p.id WHERE pi.pedido_id = $1`,
        [req.params.id]
    );
    const garantias = await pool.query(
        `SELECT g.folio, g.codigo, g.plan, g.meses, g.costo, g.inicio, g.vence, g.estado, pr.nombre AS producto
         FROM garantias g LEFT JOIN productos pr ON pr.id = g.producto_id
         WHERE g.pedido_id = $1 ORDER BY g.id`,
        [req.params.id]
    );
    res.json({ ...pedido.rows[0], items: items.rows, garantias: garantias.rows });
}));

// Recibo / comprobante de un pedido. Lo puede ver el cliente dueño o
// cualquier usuario interno (admin / vendedor / soporte / almacén).
app.get('/api/pedidos/:id/recibo', asyncRoute(async (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    let quien = null;
    try {
        const [tipo, tid] = Buffer.from(token || '', 'base64').toString('utf8').split(':');
        if (tipo === 'cliente' && tid) quien = { tipo: 'cliente', id: Number(tid) };
        else if (tipo === 'usuario' && tid) {
            const u = await pool.query('SELECT id, activo FROM usuarios WHERE id = $1', [tid]);
            if (u.rows[0] && u.rows[0].activo) quien = { tipo: 'usuario', id: Number(tid) };
        }
    } catch (e) { /* token inválido */ }
    if (!quien) return res.status(401).json({ message: 'Inicia sesión para ver el comprobante' });

    const pr = await pool.query(
        `SELECT p.*, c.nombre AS cliente_nombre, c.correo AS cliente_correo
         FROM pedidos p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = $1`,
        [req.params.id]
    );
    if (pr.rows.length === 0) return res.status(404).json({ message: 'Pedido no encontrado' });
    const pedido = pr.rows[0];
    if (quien.tipo === 'cliente' && quien.id !== Number(pedido.cliente_id)) {
        return res.status(403).json({ message: 'Este comprobante no es de tu cuenta' });
    }

    const items = await pool.query(
        `SELECT pi.cantidad, pi.precio_unitario, pi.subtotal, pi.garantia_plan, pi.garantia_meses, pi.garantia_costo, p.nombre
         FROM pedido_items pi JOIN productos p ON p.id = pi.producto_id
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

// Cambiar contraseña (verifica la actual)
app.put('/api/clientes/:id/password', asyncRoute(async (req, res) => {
    const { actual, nueva } = req.body;
    if (!actual || !nueva) return res.status(400).json({ message: 'Contraseña actual y nueva son requeridas' });
    if (nueva.length < 6) return res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });

    const result = await pool.query('SELECT password FROM clientes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado' });

    const valido = await bcrypt.compare(actual, result.rows[0].password).catch(() => false);
    if (!valido) return res.status(401).json({ message: 'La contraseña actual no es correcta' });

    const hash = await bcrypt.hash(nueva, 10);
    await pool.query('UPDATE clientes SET password = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ message: 'Contraseña actualizada' });
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
// TICKETS DE SOPORTE (cliente)
// =========================================================
app.get('/api/clientes/:id/tickets', asyncRoute(async (req, res) => {
    const r = await pool.query(
        `SELECT t.*, (SELECT COUNT(*) FROM ticket_mensajes m WHERE m.ticket_id = t.id) AS mensajes
         FROM tickets t WHERE t.cliente_id = $1 ORDER BY t.fecha_actualizacion DESC`,
        [req.params.id]
    );
    res.json(r.rows);
}));

app.post('/api/clientes/:id/tickets', asyncRoute(async (req, res) => {
    const { asunto, categoria, descripcion, prioridad, pedido_id } = req.body;
    if (!asunto || !descripcion) return res.status(400).json({ message: 'Asunto y descripción son requeridos' });

    const ins = await pool.query(
        `INSERT INTO tickets (folio, cliente_id, asunto, categoria, prioridad, pedido_id)
         VALUES ('TMP-' || substr(gen_random_uuid()::text, 1, 12), $1,$2,$3,$4,$5) RETURNING id`,
        [req.params.id, asunto.slice(0, 160), (categoria || 'general').slice(0, 40),
            ['baja', 'media', 'alta'].includes(prioridad) ? prioridad : 'media', pedido_id || null]
    );
    const t = await pool.query(
        "UPDATE tickets SET folio = 'TK-' || (1000 + id) WHERE id = $1 RETURNING *",
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
    const t = await pool.query('SELECT * FROM tickets WHERE id = $1 AND cliente_id = $2', [req.params.ticketId, req.params.id]);
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
    const t = await pool.query('SELECT id, estado FROM tickets WHERE id = $1 AND cliente_id = $2', [req.params.ticketId, req.params.id]);
    if (t.rows.length === 0) return res.status(404).json({ message: 'Ticket no encontrado' });

    await pool.query(
        `INSERT INTO ticket_mensajes (ticket_id, autor, mensaje) VALUES ($1, 'cliente', $2)`,
        [req.params.ticketId, mensaje]
    );
    // Si estaba resuelto/cerrado, se reabre
    if (['resuelto', 'cerrado'].includes(t.rows[0].estado)) {
        await pool.query("UPDATE tickets SET estado = 'abierto' WHERE id = $1", [req.params.ticketId]);
    } else {
        await pool.query("UPDATE tickets SET fecha_actualizacion = CURRENT_TIMESTAMP WHERE id = $1", [req.params.ticketId]);
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
        if (digits.length < 13 || digits.length > 19) {
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

        const { canjeados } = await cancelarPedido(client, pedido);
        await client.query('COMMIT');
        res.json({ message: canjeados > 0 ? `Pedido cancelado. Se devolvieron ${canjeados} puntos y el stock.` : 'Pedido cancelado y stock restaurado' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: error.message });
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
    { ruta: /^\/scm\/(config|reabasto)$/,               metodos: TODO, permisos: ['ordenes-compra'] },
    { ruta: /^\/scm\//,                                metodos: LEER, permisos: ['scm', 'nivel-scm', 'reportes-scm', 'ordenes-compra'] },
    // ERP
    { ruta: /^\/erp\/(clientes|productos)$/,            metodos: TODO, permisos: ['orden-nueva'] },
    { ruta: /^\/erp\/ordenes(\/procesar)?$/,            metodos: ['POST'], permisos: ['orden-nueva'] },
    { ruta: /^\/erp\/ordenes\/\d+\/estado$/,            metodos: ['PUT'], permisos: ['ordenes-erp'] },
    { ruta: /^\/erp\/estado$/,                          metodos: ['PUT'], permisos: ['nivel-erp'] },
    { ruta: /^\/erp\/reportes\/guardados(\/|$)/,        metodos: TODO, permisos: ['reportes-erp'] },
    { ruta: /^\/erp\/recursos(\/|$)/,                 metodos: TODO, permisos: ['recursos'] },
    { ruta: /^\/erp\//,                                metodos: LEER, permisos: ['erp', 'ordenes-erp', 'reportes-erp', 'nivel-erp'] },
    // Cuentas (solo admin; además cada ruta lleva requireAdmin)
    { ruta: /^\/usuarios(\/|$)/,                       metodos: TODO, permisos: ['usuarios'] },
];

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
    const { busqueda, etapa } = req.query;
    const cond = [];
    const values = [];
    let i = 1;
    if (busqueda) { cond.push(`(nombre ILIKE $${i} OR correo ILIKE $${i} OR empresa ILIKE $${i})`); values.push(`%${busqueda}%`); i++; }
    if (etapa && etapa !== 'Todas') { cond.push(`etapa_crm = $${i++}`); values.push(etapa); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const result = await pool.query(
        `SELECT id, nombre, correo, telefono, empresa, ciudad, estado_cliente, etapa_crm, fecha_registro
         FROM clientes ${where} ORDER BY id ASC`,
        values
    );
    res.json(result.rows);
}));

// Alta de cliente desde el panel (equivale al registro, pero lo hace un admin)
app.post('/api/admin/clientes', requireAdmin, asyncRoute(async (req, res) => {
    const { nombre, correo, password, telefono, empresa, ciudad, estado } = req.body;
    if (!nombre || !correo || !password) return res.status(400).json({ message: 'Nombre, correo y contraseña son obligatorios' });
    if (password.length < 6) return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });

    const existe = await pool.query('SELECT id FROM clientes WHERE correo = $1', [correo]);
    if (existe.rows.length > 0) return res.status(400).json({ message: 'Ese correo ya está registrado' });

    const hash = await bcrypt.hash(password, 10);
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
        [nombre, correo, hash, telefono || null, empresa || null, ciudad || null, estado || null, codigoSocio]
    );
    await pool.query('INSERT INTO metricas_clientes (cliente_id) VALUES ($1) ON CONFLICT (cliente_id) DO NOTHING', [r.rows[0].id]);
    res.status(201).json({ message: 'Cliente creado', cliente: r.rows[0] });
}));

app.get('/api/admin/clientes/:id/pedidos', asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT p.id, p.numero_orden, p.fecha_pedido, p.total, p.estado, p.metodo_pago,
                p.pago_estado, p.pago_reportado,
                STRING_AGG(pr.nombre, ', ') AS productos
         FROM pedidos p
         LEFT JOIN pedido_items pi ON p.id = pi.pedido_id
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
               (SELECT COUNT(*) FROM tickets      WHERE cliente_id = $1)                          AS tickets,
               (SELECT COUNT(*) FROM tickets      WHERE cliente_id = $1 AND estado IN ('abierto','en_proceso')) AS tickets_abiertos
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
    const { tipo, descripcion, usuario_id } = req.body;
    if (!tipo || !descripcion) return res.status(400).json({ message: 'Tipo y descripción son requeridos' });
    const result = await pool.query(
        `INSERT INTO interacciones (cliente_id, usuario_id, tipo, descripcion) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.id, usuario_id || null, tipo, descripcion]
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
         FROM tickets t
         JOIN clientes c ON t.cliente_id = c.id
         LEFT JOIN usuarios u ON t.asignado_a = u.id
         ${where}
         ORDER BY CASE t.estado WHEN 'abierto' THEN 0 WHEN 'en_proceso' THEN 1 ELSE 2 END,
                  CASE t.prioridad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
                  t.fecha_actualizacion DESC`,
        values
    );
    const counts = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE estado = 'abierto')    AS abiertos,
               COUNT(*) FILTER (WHERE estado = 'en_proceso') AS en_proceso,
               COUNT(*) FILTER (WHERE estado = 'resuelto')   AS resueltos,
               COUNT(*) FILTER (WHERE estado = 'cerrado')    AS cerrados
        FROM tickets`);
    res.json({ conteos: counts.rows[0], tickets: rows.rows });
}));

app.get('/api/admin/tickets/:id', asyncRoute(async (req, res) => {
    const t = await pool.query(
        `SELECT t.*, c.nombre AS cliente_nombre, c.correo AS cliente_correo, c.telefono AS cliente_telefono
         FROM tickets t JOIN clientes c ON t.cliente_id = c.id WHERE t.id = $1`,
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

app.post('/api/admin/tickets/:id/mensajes', asyncRoute(async (req, res) => {
    const { mensaje } = req.body;
    if (!mensaje) return res.status(400).json({ message: 'El mensaje es requerido' });
    const t = await pool.query('SELECT id FROM tickets WHERE id = $1', [req.params.id]);
    if (t.rows.length === 0) return res.status(404).json({ message: 'Ticket no encontrado' });
    await pool.query(
        `INSERT INTO ticket_mensajes (ticket_id, autor, usuario_id, mensaje) VALUES ($1, 'equipo', $2, $3)`,
        [req.params.id, req.usuario.id, mensaje]
    );
    await pool.query(
        "UPDATE tickets SET fecha_actualizacion = CURRENT_TIMESTAMP, estado = CASE WHEN estado = 'abierto' THEN 'en_proceso' ELSE estado END WHERE id = $1",
        [req.params.id]
    );
    res.status(201).json({ message: 'Respuesta enviada' });
}));

app.put('/api/admin/tickets/:id', asyncRoute(async (req, res) => {
    const { estado, prioridad, asignado_a } = req.body;
    const est = ['abierto', 'en_proceso', 'resuelto', 'cerrado'];
    const pri = ['baja', 'media', 'alta'];
    const r = await pool.query(
        `UPDATE tickets SET
            estado    = COALESCE($1, estado),
            prioridad = COALESCE($2, prioridad),
            asignado_a = COALESCE($3, asignado_a)
         WHERE id = $4 RETURNING *`,
        [est.includes(estado) ? estado : null, pri.includes(prioridad) ? prioridad : null,
            asignado_a || null, req.params.id]
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
        FROM tickets
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
        LEFT JOIN pedido_items pi ON pi.producto_id = p.id
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
    const result = await pool.query(`
        SELECT p.*, c.nombre AS categoria_nombre, pr.nombre AS proveedor_nombre
        FROM productos p
        LEFT JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
        ORDER BY p.id ASC
    `);
    res.json(result.rows);
}));

app.post('/api/admin/productos', asyncRoute(async (req, res) => {
    const {
        nombre, descripcion, categoria_id, marca, precio, stock, stock_minimo,
        procesador, ram_gb, almacenamiento, tarjeta_grafica, pantalla,
        uso_recomendado, imagen_url, proveedor_id, vendedor_id, activo, restock, costo_unitario
    } = req.body;

    if (!nombre || precio === undefined || precio < 0) {
        return res.status(400).json({ message: 'Nombre y precio válido son requeridos' });
    }

    const result = await pool.query(
        `INSERT INTO productos
         (nombre, descripcion, categoria_id, marca, precio, stock, stock_minimo,
          procesador, ram_gb, almacenamiento, tarjeta_grafica, pantalla,
          uso_recomendado, imagen_url, proveedor_id, vendedor_id, activo, restock, costo_unitario)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING *`,
        [nombre, descripcion || '', categoria_id || null, marca || '', precio, stock || 0, stock_minimo || 5,
            procesador || null, ram_gb || null, almacenamiento || null, tarjeta_grafica || null, pantalla || null,
            uso_recomendado || [], imagen_url || '', proveedor_id || null, vendedor_id || null,
            activo !== undefined ? activo : true, restock || 'push',
            costo_unitario === undefined || costo_unitario === '' ? null : costo_unitario]
    );
    await generarOrdenAutomaticaSiCritico(pool, result.rows[0].id);
    res.status(201).json({ message: 'Producto creado', producto: result.rows[0] });
}));

app.put('/api/admin/productos/:id', asyncRoute(async (req, res) => {
    const {
        nombre, descripcion, categoria_id, marca, precio, stock, stock_minimo,
        procesador, ram_gb, almacenamiento, tarjeta_grafica, pantalla,
        uso_recomendado, imagen_url, proveedor_id, activo, restock, costo_unitario
    } = req.body;

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
            restock = COALESCE($17, restock), costo_unitario = COALESCE($18, costo_unitario)
         WHERE id = $19 RETURNING *`,
        [nombre, descripcion, categoria_id, marca, precio, stock, stock_minimo, procesador, ram_gb,
            almacenamiento, tarjeta_grafica, pantalla, uso_recomendado, imagen_url, proveedor_id, activo, restock,
            costo_unitario === '' ? null : costo_unitario, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    await generarOrdenAutomaticaSiCritico(pool, result.rows[0].id);
    res.json({ message: 'Producto actualizado', producto: result.rows[0] });
}));

app.delete('/api/admin/productos/:id', asyncRoute(async (req, res) => {
    const enUso = await pool.query('SELECT id FROM pedido_items WHERE producto_id = $1 LIMIT 1', [req.params.id]);
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
            FROM pedido_items pi
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
    const { estado } = req.body;
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
        LEFT JOIN pedido_items pi ON pi.producto_id = p.id
        LEFT JOIN pedidos pe ON pi.pedido_id = pe.id
        WHERE p.activo = true
        GROUP BY p.id ORDER BY unidades_vendidas DESC LIMIT 6
    `);

    // (el stock se suma aparte: con el JOIN a las partidas se contaría una
    // vez por cada venta del producto)
    const rotacion = await pool.query(`
        SELECT
            (SELECT COALESCE(SUM(pi.cantidad), 0) FROM pedido_items pi
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
    const nivel = cumplidos <= 1 ? 'inicial' : cumplidos <= 3 ? 'en_desarrollo' : 'optimizado';

    res.json({
        stats: stats.rows[0],
        mas_vendidos: masVendidos.rows,
        rotacion_pct: rotacionPct,
        push_pull: { push, pull, valor_push: valorPush, valor_pull: valorPull },
        madurez: { nivel, checklist, cumplidos, total: checklist.length },
    });
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
        LEFT JOIN pedido_items pi ON pi.producto_id = p.id
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

app.get('/api/proveedores', asyncRoute(async (req, res) => {
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
        SELECT p.*, c.nombre AS cliente_nombre, c.correo AS cliente_correo
        FROM pedidos p JOIN clientes c ON p.cliente_id = c.id
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
               c.nombre AS cliente_nombre, c.correo AS cliente_correo, c.telefono AS cliente_telefono,
               c.empresa AS cliente_empresa, c.ciudad AS cliente_ciudad, c.etapa_crm AS cliente_etapa, c.puntos AS cliente_puntos,
               COALESCE(m.total_compras, 0)::int AS cliente_compras, COALESCE(m.valor_total_compras, 0) AS cliente_valor
        FROM pedidos p
        JOIN clientes c ON p.cliente_id = c.id
        LEFT JOIN metricas_clientes m ON m.cliente_id = c.id
        LEFT JOIN usuarios u ON p.vendedor_id = u.id
        WHERE p.id = $1`, [req.params.id]);
    if (p.rows.length === 0) return res.status(404).json({ message: 'Pedido no encontrado' });
    const pedido = p.rows[0];
    const items = await pool.query(
        `SELECT pi.*, pr.nombre, pr.stock, pr.stock_minimo FROM pedido_items pi JOIN productos pr ON pi.producto_id = pr.id WHERE pi.pedido_id = $1`,
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
        res.status(e.status || 400).json({ message: e.message });
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
        FROM pedido_items pi
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
            (SELECT COALESCE(SUM(pi.cantidad),0) FROM pedido_items pi JOIN pedidos p ON pi.pedido_id = p.id WHERE p.estado <> 'cancelado')::int AS productos_vendidos,
            (SELECT COUNT(*) FROM productos WHERE activo = true)::int AS productos_activos,
            (SELECT COUNT(*) FROM productos WHERE activo = true AND stock <= stock_minimo)::int AS stock_critico,
            (SELECT COUNT(*) FROM proveedores WHERE activo = true)::int AS proveedores,
            (SELECT COUNT(*) FROM ordenes_compra WHERE estado IN ('pendiente','en_proceso'))::int AS ordenes_compra_abiertas,
            (SELECT COUNT(*) FROM clientes)::int AS clientes_total,
            (SELECT COUNT(*) FROM interacciones)::int AS interacciones
    `);
    const ultimas = await pool.query(`
        SELECT p.id, p.numero_orden, p.fecha_pedido, p.total, p.estado, p.pago_estado, p.origen, c.nombre AS cliente_nombre
        FROM pedidos p JOIN clientes c ON p.cliente_id = c.id
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
    const cond = [];
    const values = [];
    if (busqueda) { values.push(`%${busqueda}%`); cond.push(`(p.numero_orden ILIKE $${values.length} OR c.nombre ILIKE $${values.length} OR c.correo ILIKE $${values.length})`); }
    if (estado && estado !== 'Todos') { values.push(estado); cond.push(`p.estado = $${values.length}`); }
    if (origen && origen !== 'Todos') { values.push(origen); cond.push(`p.origen = $${values.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(`
        SELECT p.id, p.numero_orden, p.fecha_pedido, p.subtotal, p.total, p.estado, p.pago_estado, p.metodo_pago, p.origen,
               c.id AS cliente_id, c.nombre AS cliente_nombre, c.correo AS cliente_correo, c.empresa AS cliente_empresa,
               u.nombre AS registrado_por,
               (SELECT COALESCE(SUM(cantidad),0)::int FROM pedido_items WHERE pedido_id = p.id) AS piezas
        FROM pedidos p
        JOIN clientes c ON p.cliente_id = c.id
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

// Alta rápida de cliente desde el paso 1 (queda en el CRM como Prospecto
// y pasa a Activo al confirmarse su primera compra). La contraseña es
// temporal: el cliente la cambia en la tienda.
app.post('/api/admin/erp/clientes', requirePermiso('orden-nueva'), asyncRoute(async (req, res) => {
    const { nombre, correo, telefono, empresa, ciudad } = req.body;
    if (!nombre || !correo) return res.status(400).json({ message: 'Nombre y correo son obligatorios' });
    const existe = await pool.query('SELECT id FROM clientes WHERE LOWER(correo) = LOWER($1)', [correo]);
    if (existe.rows.length > 0) return res.status(400).json({ message: 'Ese correo ya está registrado en el CRM' });

    const temporal = 'KZ-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const hash = await bcrypt.hash(temporal, 10);
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
    res.status(201).json({ cliente: { ...r.rows[0], total_compras: 0, direccion: null }, password_temporal: temporal });
}));

// Productos del SCM para el paso 2 (solo activos; el stock es el real).
app.get('/api/admin/erp/productos', asyncRoute(async (req, res) => {
    const q = (req.query.busqueda || '').trim();
    const r = await pool.query(`
        SELECT p.id, p.nombre, p.marca, p.precio, p.stock, p.stock_minimo, p.imagen_url, p.proveedor_id, c.nombre AS categoria,
               (SELECT oc.folio || '|' || oc.fecha_estimada FROM ordenes_compra oc
                 WHERE oc.producto_id = p.id AND oc.estado IN ('pendiente','en_proceso') ORDER BY oc.id DESC LIMIT 1) AS reposicion_en_curso
        FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id
        WHERE p.activo = true
          AND ($1 = '' OR p.nombre ILIKE '%' || $1 || '%' OR p.marca ILIKE '%' || $1 || '%' OR c.nombre ILIKE '%' || $1 || '%')
        ORDER BY c.nombre, p.nombre
    `, [q]);
    res.json(r.rows);
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
        for (const l of lineas) {
            const pr = await client.query('SELECT id, nombre, precio, stock, activo FROM productos WHERE id = $1 FOR UPDATE', [l.producto_id]);
            if (pr.rows.length === 0 || !pr.rows[0].activo) throw new Error(`Producto ${l.producto_id} no disponible`);
            const p = pr.rows[0];
            if (p.stock < l.cantidad) throw new Error(`Stock insuficiente para "${p.nombre}" (disponible: ${p.stock})`);
            const lineaSub = Math.round(Number(p.precio) * l.cantidad * 100) / 100;
            subtotal += lineaSub;
            detalle.push({ ...l, nombre: p.nombre, precio: Number(p.precio), subtotal: lineaSub });
        }
        pasos.push({ clave: 'stock', texto: `Stock validado (${detalle.length} producto${detalle.length === 1 ? '' : 's'})` });

        // 2) Crear la orden.
        subtotal = Math.round(subtotal * 100) / 100;
        const impuestos = Math.round(subtotal * 0.16 * 100) / 100;
        const envio = subtotal >= 10000 ? 0 : 199;
        const total = Math.round((subtotal + impuestos + envio) * 100) / 100;
        const m = METODOS_ERP[metodo];
        const folio = await client.query(`SELECT 'OR-' || LPAD(nextval('folio_erp_seq')::text, 3, '0') AS folio`);
        const numero_orden = folio.rows[0].folio;
        const ped = await client.query(
            `INSERT INTO pedidos (numero_orden, cliente_id, vendedor_id, origen, subtotal, impuestos, envio, descuento, total,
                                  estado, metodo_pago, pago_estado, pago_referencia, pago_vence, direccion_envio, notas, fecha_confirmacion)
             VALUES ($1,$2,$3,'erp',$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [numero_orden, cliente_id, req.usuario.id, subtotal, impuestos, envio, total,
                m.inmediato ? 'confirmado' : 'pendiente', m.texto, m.inmediato ? 'pagado' : 'pendiente',
                m.inmediato ? null : 'ERP-' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0'),
                m.inmediato ? null : new Date(Date.now() + 3 * 86400000),
                direccion_envio || null, notas || null, m.inmediato ? new Date() : null]
        );
        const pedido = ped.rows[0];
        pasos.push({ clave: 'orden', texto: `Orden ${numero_orden} creada` });

        // 3) Partidas + descuento de stock + movimiento de inventario.
        for (const d of detalle) {
            await client.query(
                `INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unitario, subtotal) VALUES ($1,$2,$3,$4,$5)`,
                [pedido.id, d.producto_id, d.cantidad, d.precio, d.subtotal]
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
        res.status(400).json({ message: e.message });
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
            (SELECT COALESCE(SUM(pi.cantidad),0) FROM pedido_items pi JOIN pedidos p ON p.id = pi.pedido_id
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
        SELECT COALESCE(SUM(pi.cantidad),0)::int AS n FROM pedido_items pi JOIN pedidos p ON pi.pedido_id = p.id
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
               COALESCE((SELECT SUM(pi.cantidad) FROM pedido_items pi JOIN pedidos pe ON pi.pedido_id = pe.id
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
    if (password.length < 6) return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
    if (!ROLES_INTERNOS[rol]) return res.status(400).json({ message: 'Rol no válido' });
    const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existe.rows.length > 0) return res.status(400).json({ message: 'El email ya está registrado' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
        `INSERT INTO usuarios (nombre, email, password_hash, telefono, rol, activo)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nombre, email, telefono, rol, activo`,
        [nombre, email, hash, telefono, rol, activo !== undefined ? activo : true]
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
}

app.listen(PORT, async () => {
    console.log(`Kozmok escuchando en http://localhost:${PORT}`);
    // Ping a la base para dejar claro en el arranque si conectó o no.
    try {
        const r = await pool.query('SELECT COUNT(*)::int AS n FROM productos');
        console.log(`Base de datos: conectada (${dbConfig.database}@${dbConfig.host}:${dbConfig.port}) - ${r.rows[0].n} productos`);
        await migrarEsquema();
        await procesarReabastoAutomatico();
        setInterval(procesarReabastoAutomatico, 60 * 1000);
    } catch (err) {
        if (/relation .* does not exist/i.test(err.message)) {
            console.error(`Base de datos: conectada a ${dbConfig.database}, pero SIN TABLAS. Carga db/database.sql.`);
        } else {
            console.error(`Base de datos: SIN CONEXION — ${err.message}`);
            console.error('  Revisa que PostgreSQL esté encendido y que db.config.js tenga usuario/contraseña/puerto correctos.');
        }
    }
});
