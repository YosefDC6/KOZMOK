// =========================================================
// Google reCAPTCHA v2 (casilla "No soy un robot")
//   Claves en el .env: RECAPTCHA_SITE_KEY (va al navegador) y
//   RECAPTCHA_SECRET_KEY (solo el servidor). Sin claves, el captcha no se
//   pide y todo funciona como antes.
//   Claves: https://www.google.com/recaptcha/admin  (tipo "v2 casilla")
// =========================================================
const CFG = {
    sitio: (process.env.RECAPTCHA_SITE_KEY || '').trim(),
    secreto: (process.env.RECAPTCHA_SECRET_KEY || '').trim(),
    url: 'https://www.google.com/recaptcha/api/siteverify',
    esperaMs: 6000,
    // Dominios extra permitidos (separados por coma), p. ej. "kozmok.mx,www.kozmok.mx".
    // localhost y las IP de red local (192.168.x.x, 10.x.x.x, 172.16-31.x.x) ya se aceptan.
    dominios: (process.env.RECAPTCHA_DOMINIOS || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean),
};
const configurado = () => !!(CFG.sitio && CFG.secreto);

// Como en Google se desactiva "Verificar el origen" (para que funcione aunque
// cambie la IP de la red), aquí revisamos nosotros desde qué sitio se marcó la casilla.
function hostPermitido(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.endsWith('.local')) return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (m.slice(1).some(n => Number(n) > 255)) return false;
        return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
    }
    return CFG.dominios.some(d => h === d || h.endsWith('.' + d));
}

// Pregunta a Google si el token del navegador es válido. Cada token sirve
// una sola vez y dura 2 minutos.
async function verificar(token, ip) {
    if (!configurado()) return { ok: true, omitido: true };
    const t = String(token || '');
    if (!t || t.length > 4000) return { ok: false, errores: ['falta-token'] };
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), CFG.esperaMs);
    try {
        const r = await fetch(CFG.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret: CFG.secreto, response: t, ...(ip ? { remoteip: ip } : {}) }),
            signal: ctrl.signal,
        });
        const d = await r.json();
        if (d.success && !hostPermitido(d.hostname)) {
            return { ok: false, errores: [`sitio-no-permitido:${d.hostname || '?'}`], host: d.hostname || null };
        }
        return { ok: !!d.success, errores: d['error-codes'] || [], host: d.hostname || null };
    } catch (e) {
        return { ok: false, sinConexion: true, errores: [e.name === 'AbortError' ? 'tiempo-agotado' : 'sin-conexion'] };
    } finally {
        clearTimeout(reloj);
    }
}

module.exports = { CFG, configurado, verificar, hostPermitido };
