// =========================================================
// Verificación en dos pasos (2FA)
//   - App autenticadora (Google / Microsoft Authenticator, Authy...):
//     códigos TOTP de 6 dígitos que cambian cada 30 s (RFC 6238).
//   - Código por correo: 6 dígitos al azar, válido unos minutos.
// Solo usa el módulo crypto de Node; no hace falta instalar nada.
// =========================================================
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';   // base32 (RFC 4648)
const PERIODO = 30;      // segundos por código
const DIGITOS = 6;
const VENTANA = 1;       // acepta el código anterior y el siguiente (relojes desfasados)

function base32(buf) {
    let bits = 0, valor = 0, out = '';
    for (const b of buf) {
        valor = (valor << 8) | b; bits += 8;
        while (bits >= 5) { out += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31];
    return out;
}
function desdeBase32(txt) {
    const limpio = String(txt || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, valor = 0;
    const out = [];
    for (const c of limpio) {
        valor = (valor << 5) | ALFABETO.indexOf(c); bits += 5;
        if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}

// Secreto nuevo para la app: 20 bytes (160 bits), como recomienda el RFC.
const generarSecreto = () => base32(crypto.randomBytes(20));

// Código HOTP para un contador (RFC 4226).
function hotp(secreto, contador) {
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(BigInt(contador));
    const h = crypto.createHmac('sha1', desdeBase32(secreto)).update(c).digest();
    const o = h[h.length - 1] & 15;
    const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 10 ** DIGITOS).padStart(DIGITOS, '0');
}
const pasoActual = (ms = Date.now()) => Math.floor(ms / 1000 / PERIODO);
const totp = (secreto, ms = Date.now()) => hotp(secreto, pasoActual(ms));

const iguales = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const limpiarCodigo = (c) => String(c || '').replace(/\D/g, '');

// Revisa un código de la app. Devuelve el paso (contador) que coincidió, o
// null. ultimoPaso evita que el mismo código se use dos veces.
function verificarTOTP(secreto, codigo, { ultimoPaso = null, ms = Date.now() } = {}) {
    const c = limpiarCodigo(codigo);
    if (!secreto || c.length !== DIGITOS) return null;
    const ahora = pasoActual(ms);
    for (let d = -VENTANA; d <= VENTANA; d++) {
        const paso = ahora + d;
        if (ultimoPaso !== null && paso <= Number(ultimoPaso)) continue;
        if (iguales(hotp(secreto, paso), c)) return paso;
    }
    return null;
}

// Dirección que se convierte en QR para dar de alta la cuenta en la app.
function uriApp({ secreto, cuenta, emisor = 'Kozmok' }) {
    const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
    return `otpauth://totp/${etiqueta}?secret=${secreto}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=${DIGITOS}&period=${PERIODO}`;
}

// Código de 6 dígitos para mandar por correo.
const codigoCorreo = () => String(crypto.randomInt(0, 10 ** DIGITOS)).padStart(DIGITOS, '0');

// a***z@gmail.com: para decir a dónde se mandó el código sin mostrar el correo completo.
function enmascararCorreo(correo) {
    const [u, d] = String(correo || '').split('@');
    if (!d) return '';
    const vis = u.length <= 2 ? u[0] || '' : u[0] + '***' + u[u.length - 1];
    return `${vis}${u.length <= 2 ? '***' : ''}@${d}`;
}

module.exports = { generarSecreto, totp, hotp, verificarTOTP, uriApp, codigoCorreo, enmascararCorreo, limpiarCodigo, base32, desdeBase32, DIGITOS, PERIODO };
