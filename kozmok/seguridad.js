// =========================================================
//  Kozmok · Seguridad del servidor
//
//  Defensas contra los ataques que se prueban en la Etapa 5:
//
//   1. FUERZA BRUTA (adivinar contraseñas)
//      - Límite de peticiones por IP (en memoria, respuesta 429).
//      - Bloqueo temporal de la CUENTA tras 5 contraseñas equivocadas
//        seguidas y de la IP tras 20 fallos (tabla bloqueos).
//      - Retraso progresivo en cada fallo y bcrypt (lento a propósito).
//      - Mismo mensaje y mismo tiempo de respuesta exista o no el correo
//        (no se puede averiguar qué correos están registrados).
//
//   2. ROBO DE CREDENCIALES / DE SESIÓN
//      - Contraseñas con bcrypt y política de contraseña fuerte.
//      - Sesión en cookie HttpOnly + SameSite=Strict: JavaScript (y por lo
//        tanto un script inyectado) no puede leerla.
//      - El token es aleatorio (256 bits) y en la base solo se guarda su
//        hash SHA-256; vence, se revoca al cerrar sesión o cambiar la
//        contraseña y queda atado a la huella del navegador: si alguien
//        la copia a otro navegador se rechaza y se revoca.
//      - Cabeceras de seguridad (CSP, X-Frame-Options, nosniff...) y
//        limpieza de HTML en todo lo que entra (contra XSS).
//      - Verificación del origen en peticiones que modifican datos (CSRF).
//
//   3. INYECCIÓN SQL
//      - Todas las consultas usan parámetros ($1, $2...): el dato nunca se
//        concatena al SQL (defensa principal, en server.js).
//      - Filtro que detecta patrones de inyección, bloquea la petición y la
//        registra en la bitácora (defensa en profundidad).
//      - Identificadores numéricos validados y errores de la base que
//        nunca se muestran al usuario.
//
//  Todo lo detectado queda en eventos_seguridad y se ve en el panel
//  (Cuenta → Seguridad).
// =========================================================
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);

const CONFIG = {
    horasSesionCliente: num(process.env.SESION_HORAS_CLIENTE, 168),      // 7 días
    horasSesionEquipo:  num(process.env.SESION_HORAS_EQUIPO, 8),
    minInactividadCliente: num(process.env.INACTIVIDAD_MIN_CLIENTE, 2880), // 2 días
    minInactividadEquipo:  num(process.env.INACTIVIDAD_MIN_EQUIPO, 120),   // 2 horas
    maxFallosCuenta: num(process.env.MAX_FALLOS_CUENTA, 5),
    maxFallosIp:     num(process.env.MAX_FALLOS_IP, 20),
    ventanaMin:      num(process.env.VENTANA_FALLOS_MIN, 15),
    bloqueoCuentaMin: num(process.env.BLOQUEO_CUENTA_MIN, 15),
    bloqueoIpMin:     num(process.env.BLOQUEO_IP_MIN, 30),
    // 'bloquear' (rechaza y registra) o 'registrar' (solo deja constancia)
    filtroSQL: process.env.FILTRO_SQLI === 'registrar' ? 'registrar' : 'bloquear',
    cookieSegura: process.env.COOKIE_SEGURA === '1',
    costoBcrypt: Math.min(14, Math.max(10, num(process.env.BCRYPT_COSTO, 12))),
};

const COOKIE = { cliente: 'kz_sesion', usuario: 'kz_admin' };

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const recortar = (v, n) => (v == null ? null : String(v).slice(0, n));

function ipDe(req) {
    let ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip === '::1') ip = '127.0.0.1';
    return ip;
}
const uaDe = (req) => recortar(req.headers['user-agent'] || '', 300);
const huellaDe = (req) => sha256(req.headers['user-agent'] || '');

// ---------------------------------------------------------
// Bitácora de seguridad (nunca rompe la petición si falla)
// ---------------------------------------------------------
let POOL = null;
async function registrarEvento(req, { tipo, severidad = 'media', detalle = '', cliente_id = null, usuario_id = null }) {
    try {
        await POOL.query(
            `INSERT INTO eventos_seguridad (tipo, severidad, ip, user_agent, metodo, ruta, detalle, cliente_id, usuario_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [tipo, severidad, req ? ipDe(req) : null, req ? uaDe(req) : null, req ? req.method : null,
                req ? recortar(req.originalUrl, 200) : null, recortar(detalle, 500), cliente_id, usuario_id]);
    } catch (e) { console.error('Bitácora de seguridad ->', e.message); }
}

// ---------------------------------------------------------
// Cabeceras de seguridad (todas las respuestas)
// ---------------------------------------------------------
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",          // un script inyectado no puede mandar datos a otro servidor
    "frame-ancestors 'none'",      // nadie puede meter la tienda en un iframe (clickjacking)
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
].join('; ');

function cabeceras(req, res, next) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.secure || CONFIG.cookieSegura) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
}

// ---------------------------------------------------------
// Límite de peticiones por IP (ventana deslizante en memoria)
// ---------------------------------------------------------
function limitador({ nombre, ventanaMs, max, mensaje, clave = ipDe }) {
    const golpes = new Map();
    setInterval(() => {
        const limite = Date.now() - ventanaMs;
        for (const [k, arr] of golpes) {
            const vivos = arr.filter((t) => t > limite);
            if (vivos.length) golpes.set(k, vivos); else golpes.delete(k);
        }
    }, Math.min(ventanaMs, 60000)).unref();
    const mw = (req, res, next) => {
        const k = clave(req);
        const ahora = Date.now();
        const arr = (golpes.get(k) || []).filter((t) => t > ahora - ventanaMs);
        arr.push(ahora);
        golpes.set(k, arr);
        if (arr.length > max) {
            const espera = Math.ceil((arr[0] + ventanaMs - ahora) / 1000);
            res.setHeader('Retry-After', String(espera));
            if (arr.length === max + 1) registrarEvento(req, { tipo: 'limite_peticiones', severidad: 'media', detalle: `${nombre}: más de ${max} peticiones en ${ventanaMs / 1000}s` });
            return res.status(429).json({ message: mensaje || `Demasiadas solicitudes. Espera ${espera} segundos e intenta de nuevo.` });
        }
        next();
    };
    mw.limpiar = () => golpes.clear();
    return mw;
}

// ---------------------------------------------------------
// CSRF: las peticiones que modifican datos deben venir de la propia
// tienda. Un navegador siempre manda Origin (o Referer) en un POST; si
// viene de otro sitio se rechaza. (Además la cookie es SameSite=Strict.)
// ---------------------------------------------------------
function verificarOrigen(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origen = req.headers.origin || req.headers.referer;
    if (!origen) return next(); // cliente que no es navegador (curl, Postman, pruebas)
    let host = null;
    try { host = new URL(origen).host; } catch { host = null; }
    if (host && host === req.headers.host) return next();
    registrarEvento(req, { tipo: 'csrf', severidad: 'alta', detalle: `Origen no permitido: ${recortar(origen, 120)}` });
    return res.status(403).json({ message: 'Solicitud rechazada: viene de un sitio que no es Kozmok.' });
}

// ---------------------------------------------------------
// Detector de inyección SQL (defensa en profundidad).
// La protección real son las consultas parametrizadas; esto detecta el
// intento, lo registra y lo bloquea antes de que llegue a la lógica.
// ---------------------------------------------------------
const PATRONES_SQL = [
    { re: /'\s*(or|and)\s+['"]?[\w-]+['"]?\s*(=|<>|!=|like|>|<)\s*['"]?[\w-]+/i, nombre: 'tautología (\' OR \'1\'=\'1)' },
    { re: /\b(or|and)\s+\d+\s*(=|<>|>|<)\s*\d+\b/i,                         nombre: 'tautología numérica (OR 1=1)' },
    { re: /\bunion\b[\s\S]{0,40}\bselect\b/i,                                  nombre: 'UNION SELECT' },
    { re: /;\s*(drop|delete|insert|update|alter|truncate|create|grant|revoke|copy)\b/i, nombre: 'consulta apilada (; DROP ...)' },
    { re: /'\s*(--|#|\/\*)/,                                                  nombre: 'comentario para cortar la consulta' },
    { re: /\b(pg_sleep|sleep|benchmark|waitfor\s+delay)\s*\(/i,               nombre: 'inyección a ciegas por tiempo' },
    { re: /\b(information_schema|pg_catalog|pg_shadow|pg_user|pg_tables)\b/i, nombre: 'lectura del catálogo de la base' },
    { re: /\bselect\b[\s\S]{1,80}\bfrom\b[\s\S]{0,40}\b(usuarios|clientes|sesiones|pg_)/i, nombre: 'SELECT a tablas internas' },
    { re: /\b(xp_cmdshell|exec\s*\(|execute\s+immediate)\b/i,                 nombre: 'ejecución de comandos' },
];

function recorrerTextos(obj, fn, ruta = '', prof = 0) {
    if (obj == null || prof > 6) return;
    if (typeof obj === 'string') { fn(obj, ruta); return; }
    if (Array.isArray(obj)) { obj.forEach((v, i) => recorrerTextos(v, fn, `${ruta}[${i}]`, prof + 1)); return; }
    if (typeof obj === 'object') for (const k of Object.keys(obj)) recorrerTextos(obj[k], fn, ruta ? `${ruta}.${k}` : k, prof + 1);
}

function detectarSQL(valor) {
    const p = PATRONES_SQL.find((x) => x.re.test(valor));
    return p ? p.nombre : null;
}

function filtroInyeccionSQL(req, res, next) {
    let hallazgo = null;
    const revisar = (v, campo) => { if (!hallazgo) { const n = detectarSQL(v); if (n) hallazgo = { campo, valor: v, patron: n }; } };
    try { revisar(decodeURIComponent(req.path), 'ruta'); } catch { revisar(req.path, 'ruta'); }
    recorrerTextos(req.query, revisar, 'query');
    recorrerTextos(req.body, revisar, 'body');
    if (!hallazgo) return next();
    registrarEvento(req, {
        tipo: 'inyeccion_sql', severidad: 'alta',
        detalle: `${hallazgo.patron} en ${hallazgo.campo}: ${recortar(hallazgo.valor, 200)}${CONFIG.filtroSQL === 'registrar' ? ' (solo registrado)' : ' (bloqueado)'}`,
    });
    if (CONFIG.filtroSQL === 'registrar') return next();
    return res.status(400).json({
        message: 'Solicitud bloqueada: se detectó un intento de inyección SQL. El intento quedó registrado.',
        bloqueado_por: 'filtro de inyección SQL',
    });
}

// ---------------------------------------------------------
// Limpieza contra XSS: a todo texto que entra (menos contraseñas) se le
// quitan las etiquetas HTML y los caracteres que permiten salir de un
// atributo. Si había código, el intento se registra.
// ---------------------------------------------------------
const CAMPOS_SIN_LIMPIAR = /pass|contrasena|actual|nueva|token|cvv/i;
const PATRON_XSS = /<\s*\/?\s*(script|img|svg|iframe|object|embed|style|link|meta|body|a|input|form|video|audio|details|math)\b|on[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html/i;

function limpiarTexto(t) {
    return t
        .replace(/<[^>]*>/g, '')        // etiquetas completas
        .replace(/[<>`]/g, '')           // restos sueltos
        .replace(/"/g, '”')              // no rompen atributos HTML
        .replace(/'/g, '’');
}

function limpiarObjeto(obj, prof = 0, hallazgos = []) {
    if (obj == null || prof > 6) return obj;
    if (Array.isArray(obj)) return obj.map((v) => (typeof v === 'string' ? (PATRON_XSS.test(v) && hallazgos.push(v), limpiarTexto(v)) : limpiarObjeto(v, prof + 1, hallazgos)));
    if (typeof obj === 'object') {
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === 'string') {
                if (CAMPOS_SIN_LIMPIAR.test(k)) continue;
                if (PATRON_XSS.test(v)) hallazgos.push(`${k}: ${v}`);
                obj[k] = limpiarTexto(v);
            } else if (v && typeof v === 'object') obj[k] = limpiarObjeto(v, prof + 1, hallazgos);
        }
    }
    return obj;
}

function sanitizarEntrada(req, res, next) {
    const hallazgos = [];
    if (req.body && typeof req.body === 'object') limpiarObjeto(req.body, 0, hallazgos);
    if (req.query && typeof req.query === 'object') limpiarObjeto(req.query, 0, hallazgos);
    if (hallazgos.length) {
        registrarEvento(req, { tipo: 'xss', severidad: 'alta', detalle: `Código HTML/JS neutralizado: ${recortar(hallazgos[0], 300)}` });
    }
    next();
}

// ---------------------------------------------------------
// Política de contraseñas
// ---------------------------------------------------------
const COMUNES = new Set([
    '12345678', '123456789', '1234567890', 'password', 'password1', 'contraseña', 'contrasena', 'qwerty123',
    'qwertyuiop', '11111111', '00000000', 'abc12345', 'abcd1234', 'iloveyou', 'admin123', 'administrador',
    'kozmok123', 'kozmok2026', 'demo1234', 'mexico123', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword1',
    'welcome1', 'bienvenido', 'superman', 'letmein1', 'qwerty12', 'asdfghjk', 'zxcvbnm1', 'admin1234',
]);
function validarPassword(pw, { correo = '', nombre = '' } = {}) {
    pw = String(pw || '');
    if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
    if (Buffer.byteLength(pw) > 72) return 'La contraseña es demasiado larga (máximo 72 caracteres).';
    if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return 'La contraseña debe combinar mayúsculas y minúsculas.';
    if (!/\d/.test(pw)) return 'La contraseña debe incluir al menos un número.';
    if (!/[^A-Za-z0-9]/.test(pw)) return 'La contraseña debe incluir al menos un símbolo (por ejemplo # ! $ %).';
    if (COMUNES.has(pw.toLowerCase())) return 'Esa contraseña es de las más usadas; elige otra.';
    const usuario = String(correo).split('@')[0].toLowerCase();
    if (usuario.length >= 4 && pw.toLowerCase().includes(usuario)) return 'La contraseña no debe contener tu correo.';
    const primerNombre = String(nombre).trim().split(/\s+/)[0].toLowerCase();
    if (primerNombre.length >= 4 && pw.toLowerCase().includes(primerNombre)) return 'La contraseña no debe contener tu nombre.';
    return null;
}
const hashPassword = (pw) => bcrypt.hash(String(pw), CONFIG.costoBcrypt);

// Hash de relleno: si el correo no existe se compara contra este, para que
// la respuesta tarde lo mismo y no delate qué correos están registrados.
const HASH_RELLENO = bcrypt.hashSync('relleno-' + crypto.randomBytes(8).toString('hex'), 10);
async function compararPassword(pw, hash) {
    try { return await bcrypt.compare(String(pw || ''), hash || HASH_RELLENO) && Boolean(hash); }
    catch { return false; }
}

// ---------------------------------------------------------
// Fuerza bruta: intentos, bloqueos de cuenta y de IP
// ---------------------------------------------------------
async function bloqueoActivo({ ambito, correo, ip }) {
    const r = await POOL.query(
        `SELECT tipo, hasta, motivo FROM bloqueos
         WHERE levantado IS NULL AND hasta > CURRENT_TIMESTAMP
           AND ((tipo = 'cuenta' AND valor = $1) OR (tipo = 'ip' AND valor = $2))
         ORDER BY hasta DESC LIMIT 1`,
        [`${ambito}:${correo}`, `${ambito}:${ip}`]);
    return r.rows[0] || null;
}

async function registrarIntento(req, { ambito, correo, exito, motivo }) {
    await POOL.query(
        `INSERT INTO intentos_login (tipo, correo, ip, user_agent, exito, motivo) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ambito, recortar(correo, 150), ipDe(req), uaDe(req), exito, motivo || null]);
}

// Registra un fallo y, si se pasó del límite, bloquea la cuenta o la IP.
// Devuelve cuántos intentos le quedan a la cuenta.
async function registrarFallo(req, { ambito, correo, motivo = 'credenciales' }) {
    const ip = ipDe(req);
    await registrarIntento(req, { ambito, correo, exito: false, motivo });
    const v = CONFIG.ventanaMin;
    const cuenta = await POOL.query(
        `SELECT COUNT(*)::int AS n FROM intentos_login
         WHERE tipo = $1 AND correo = $2 AND NOT exito AND motivo IN ('credenciales','cuenta_inactiva')
           AND fecha > GREATEST(CURRENT_TIMESTAMP - ($3 || ' minutes')::interval,
               COALESCE((SELECT MAX(fecha) FROM intentos_login WHERE tipo = $1 AND correo = $2 AND exito), '-infinity'),
               -- fin real del último bloqueo (si se levantó antes, cuenta desde ahí)
               COALESCE((SELECT MAX(LEAST(hasta, COALESCE(levantado, hasta))) FROM bloqueos WHERE tipo = 'cuenta' AND valor = $1 || ':' || $2), '-infinity'))`,
        [ambito, correo, String(v)]);
    const porIp = await POOL.query(
        `SELECT COUNT(*)::int AS n FROM intentos_login
         WHERE tipo = $1 AND ip = $2 AND NOT exito AND motivo IN ('credenciales','cuenta_inactiva')
           AND fecha > GREATEST(CURRENT_TIMESTAMP - ($3 || ' minutes')::interval,
               COALESCE((SELECT MAX(LEAST(hasta, COALESCE(levantado, hasta))) FROM bloqueos WHERE tipo = 'ip' AND valor = $1 || ':' || $2), '-infinity'))`,
        [ambito, ip, String(v)]);
    const fallosCuenta = cuenta.rows[0].n;
    const fallosIp = porIp.rows[0].n;
    let bloqueo = null;
    if (fallosCuenta >= CONFIG.maxFallosCuenta) {
        bloqueo = { tipo: 'cuenta', minutos: CONFIG.bloqueoCuentaMin };
        await POOL.query(
            `INSERT INTO bloqueos (tipo, valor, motivo, hasta) VALUES ('cuenta', $1, $2, CURRENT_TIMESTAMP + ($3 || ' minutes')::interval)`,
            [`${ambito}:${correo}`, `${fallosCuenta} contraseñas equivocadas seguidas`, String(CONFIG.bloqueoCuentaMin)]);
        await registrarEvento(req, { tipo: 'fuerza_bruta', severidad: 'alta', detalle: `Cuenta ${ambito} ${correo} bloqueada ${CONFIG.bloqueoCuentaMin} min tras ${fallosCuenta} intentos fallidos` });
    }
    if (fallosIp >= CONFIG.maxFallosIp) {
        bloqueo = { tipo: 'ip', minutos: CONFIG.bloqueoIpMin };
        await POOL.query(
            `INSERT INTO bloqueos (tipo, valor, motivo, hasta) VALUES ('ip', $1, $2, CURRENT_TIMESTAMP + ($3 || ' minutes')::interval)`,
            [`${ambito}:${ip}`, `${fallosIp} inicios de sesión fallidos desde esta IP (varias cuentas)`, String(CONFIG.bloqueoIpMin)]);
        await registrarEvento(req, { tipo: 'fuerza_bruta', severidad: 'alta', detalle: `IP ${ip} bloqueada ${CONFIG.bloqueoIpMin} min en el acceso de ${ambito}s tras ${fallosIp} fallos` });
    }
    // Retraso progresivo: cada fallo seguido tarda un poco más en responder.
    await dormir(Math.min(fallosCuenta * 250, 2000));
    return { fallos: fallosCuenta, restantes: Math.max(CONFIG.maxFallosCuenta - fallosCuenta, 0), bloqueo };
}

function minutosRestantes(hasta) {
    return Math.max(1, Math.ceil((new Date(hasta) - Date.now()) / 60000));
}

// ---------------------------------------------------------
// Sesiones
// ---------------------------------------------------------
function leerCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((par) => {
        const i = par.indexOf('=');
        if (i > 0) {
            const k = par.slice(0, i).trim();
            try { out[k] = decodeURIComponent(par.slice(i + 1).trim()); } catch { /* ignora */ }
        }
    });
    return out;
}

function ponerCookie(req, res, nombre, valor, segundos) {
    const segura = req.secure || CONFIG.cookieSegura;
    const partes = [`${nombre}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${segundos}`];
    if (segura) partes.push('Secure');
    const previas = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(previas) ? previas : previas ? [previas] : []), partes.join('; ')]);
}
const borrarCookie = (req, res, nombre) => ponerCookie(req, res, nombre, '', 0);

async function crearSesion(req, res, tipo, id) {
    const token = crypto.randomBytes(32).toString('base64url');
    const horas = tipo === 'cliente' ? CONFIG.horasSesionCliente : CONFIG.horasSesionEquipo;
    const r = await POOL.query(
        `INSERT INTO sesiones (token_hash, tipo, cliente_id, usuario_id, ip, user_agent, huella, expira)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CURRENT_TIMESTAMP + ($8 || ' hours')::interval) RETURNING id, expira`,
        [sha256(token), tipo, tipo === 'cliente' ? id : null, tipo === 'usuario' ? id : null,
            ipDe(req), uaDe(req), huellaDe(req), String(horas)]);
    ponerCookie(req, res, COOKIE[tipo], token, Math.round(horas * 3600));
    return { token, id: r.rows[0].id, expira: r.rows[0].expira };
}

function tokenDe(req, tipo) {
    const c = leerCookies(req)[COOKIE[tipo]];
    if (c) return c;
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// Devuelve la sesión válida de ese tipo o null. Si detecta un token
// alterado, vencido o usado desde otro navegador, lo registra.
async function leerSesion(req, tipo) {
    const token = tokenDe(req, tipo);
    if (!token) return null;
    if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) {
        // Tokens con otro formato: p. ej. el Base64 "cliente:1:..." de la
        // versión anterior, que cualquiera podía fabricar.
        registrarEvento(req, { tipo: 'token_invalido', severidad: 'alta', detalle: `Token con formato no válido (${recortar(token, 40)})` });
        return null;
    }
    const r = await POOL.query('SELECT * FROM sesiones WHERE token_hash = $1 AND tipo = $2', [sha256(token), tipo]);
    const s = r.rows[0];
    if (!s) {
        registrarEvento(req, { tipo: 'token_invalido', severidad: 'media', detalle: `Token de ${tipo} inexistente o alterado` });
        return null;
    }
    if (s.revocada) {
        registrarEvento(req, { tipo: 'sesion_revocada', severidad: 'media', detalle: `Se intentó reusar una sesión cerrada (${s.motivo_revocacion || 'revocada'})`, cliente_id: s.cliente_id, usuario_id: s.usuario_id });
        return null;
    }
    if (new Date(s.expira) < new Date()) return null;
    const inactividad = tipo === 'cliente' ? CONFIG.minInactividadCliente : CONFIG.minInactividadEquipo;
    if (Date.now() - new Date(s.ultimo_uso).getTime() > inactividad * 60000) {
        await revocarSesion(s.id, 'inactividad');
        return null;
    }
    if (s.huella && s.huella !== huellaDe(req)) {
        // La cookie se está usando desde otro navegador: se asume robada.
        await revocarSesion(s.id, 'usada desde otro navegador (posible robo)');
        await registrarEvento(req, {
            tipo: 'sesion_robada', severidad: 'alta', cliente_id: s.cliente_id, usuario_id: s.usuario_id,
            detalle: `Sesión #${s.id} usada con otro navegador (abierta en ${recortar(s.user_agent, 80)}); se revocó`,
        });
        return null;
    }
    if (Date.now() - new Date(s.ultimo_uso).getTime() > 60000) {
        POOL.query('UPDATE sesiones SET ultimo_uso = CURRENT_TIMESTAMP, ip = $2 WHERE id = $1', [s.id, ipDe(req)]).catch(() => {});
    }
    return s;
}

async function revocarSesion(id, motivo) {
    await POOL.query(`UPDATE sesiones SET revocada = CURRENT_TIMESTAMP, motivo_revocacion = $2 WHERE id = $1 AND revocada IS NULL`, [id, recortar(motivo, 80)]);
}
async function revocarSesionesDe(tipo, id, motivo, exceptoId = null) {
    const col = tipo === 'cliente' ? 'cliente_id' : 'usuario_id';
    const r = await POOL.query(
        `UPDATE sesiones SET revocada = CURRENT_TIMESTAMP, motivo_revocacion = $3
         WHERE ${col} = $1 AND revocada IS NULL AND ($2::int IS NULL OR id <> $2) RETURNING id`,
        [id, exceptoId, recortar(motivo, 80)]);
    return r.rowCount;
}

// ---------------------------------------------------------
// Validaciones de datos de entrada
// ---------------------------------------------------------
const RE_CORREO = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
const normalizarCorreo = (c) => String(c || '').trim().toLowerCase();
const correoValido = (c) => RE_CORREO.test(String(c || '')) && String(c).length <= 150;
const telefonoValido = (t) => !t || /^[0-9+()\-\s.]{7,20}$/.test(String(t));
const nombreValido = (n) => /^[\p{L}][\p{L}\s.’\-]{1,149}$/u.test(String(n || '').trim());
const esId = (v) => /^\d{1,9}$/.test(String(v));

// Errores de PostgreSQL -> mensaje genérico (nunca se muestra el SQL ni
// el detalle interno, que le daría pistas a un atacante).
function mensajeSeguro(e) {
    if (e && e.code && /^[0-9A-Z]{5}$/.test(e.code)) {
        if (e.code === '23505') return 'Ese registro ya existe.';
        if (e.code === '23503') return 'El registro está relacionado con otros datos.';
        if (e.code === '23514' || e.code === '22003') return 'Algún valor está fuera del rango permitido.';
        if (e.code.startsWith('22')) return 'Algún dato no tiene el formato correcto.';
        return 'No se pudo completar la operación.';
    }
    return (e && e.message) || 'No se pudo completar la operación.';
}

function instalar(app, pool) {
    POOL = pool;
    app.disable('x-powered-by');
    app.use(cabeceras);
}

module.exports = {
    CONFIG, COOKIE, instalar, cabeceras, limitador, verificarOrigen, filtroInyeccionSQL, sanitizarEntrada,
    registrarEvento, validarPassword, hashPassword, compararPassword,
    bloqueoActivo, registrarIntento, registrarFallo, minutosRestantes,
    crearSesion, leerSesion, revocarSesion, revocarSesionesDe, borrarCookie, tokenDe, sha256,
    ipDe, uaDe, normalizarCorreo, correoValido, telefonoValido, nombreValido, esId, mensajeSeguro,
    detectarSQL, limpiarTexto,
};
