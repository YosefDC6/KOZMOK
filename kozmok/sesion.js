// sesion.js
// Tokens de sesión firmados (mismo principio que un JWT con HS256):
//
//   <datos en base64url>.<firma HMAC-SHA256 en base64url>
//
// datos = { t: 'usuario' | 'cliente', id, iat, exp, pv }
//   - La firma se calcula con SESSION_SECRET (archivo .env): sin la
//     clave nadie puede fabricar ni modificar un token (por ejemplo,
//     cambiar el id para hacerse pasar por otro usuario).
//   - exp: fecha de vencimiento; un token vencido se rechaza.
//   - pv: huella de la contraseña actual. Si la contraseña cambia, los
//     tokens emitidos antes dejan de ser válidos (se cierran las demás
//     sesiones).
require('./env.js');
const crypto = require('crypto');

let SECRETO = process.env.SESSION_SECRET || '';
let secretoTemporal = false;
if (SECRETO.length < 32) {
    // Sin clave configurada se usa una aleatoria: funciona, pero las
    // sesiones se cierran cada vez que se reinicia el servidor.
    SECRETO = crypto.randomBytes(48).toString('hex');
    secretoTemporal = true;
}

const HORAS = {
    usuario: Number(process.env.SESION_HORAS_EQUIPO) || 12,
    cliente: Number(process.env.SESION_HORAS_CLIENTE) || 168,
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const firmar = (texto) => crypto.createHmac('sha256', SECRETO).update(texto).digest('base64url');

// Huella corta del hash de la contraseña (no revela nada del hash).
function huellaPassword(hash) {
    return crypto.createHmac('sha256', SECRETO).update('pv:' + String(hash || '')).digest('base64url').slice(0, 16);
}

function crearToken(tipo, id, passwordHash) {
    const ahora = Math.floor(Date.now() / 1000);
    const datos = { t: tipo, id: Number(id), iat: ahora, exp: ahora + HORAS[tipo] * 3600, pv: huellaPassword(passwordHash) };
    const cuerpo = b64url(JSON.stringify(datos));
    return `${cuerpo}.${firmar(cuerpo)}`;
}

// Devuelve los datos del token si la firma es correcta, no ha vencido y
// es del tipo esperado; si no, null. La huella de la contraseña se
// compara después, con el hash leído de la base (ver coincidePassword).
function leerToken(token, tipoEsperado) {
    if (typeof token !== 'string') return null;
    const partes = token.split('.');
    if (partes.length !== 2) return null;
    const [cuerpo, firma] = partes;
    const esperada = Buffer.from(firmar(cuerpo));
    const recibida = Buffer.from(firma);
    if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
    let datos;
    try { datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8')); } catch { return null; }
    if (!datos || (tipoEsperado && datos.t !== tipoEsperado) || !Number.isInteger(datos.id)) return null;
    if (!datos.exp || datos.exp < Math.floor(Date.now() / 1000)) return null;
    return datos;
}

function coincidePassword(datos, passwordHash) {
    return datos && datos.pv === huellaPassword(passwordHash);
}

// Token del header "Authorization: Bearer <token>".
function tokenDe(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
}

module.exports = { crearToken, leerToken, coincidePassword, tokenDe, secretoTemporal, HORAS };
