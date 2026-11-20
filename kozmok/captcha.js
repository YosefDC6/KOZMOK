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
};
const configurado = () => !!(CFG.sitio && CFG.secreto);

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
        return { ok: !!d.success, errores: d['error-codes'] || [], host: d.hostname || null };
    } catch (e) {
        return { ok: false, sinConexion: true, errores: [e.name === 'AbortError' ? 'tiempo-agotado' : 'sin-conexion'] };
    } finally {
        clearTimeout(reloj);
    }
}

module.exports = { CFG, configurado, verificar };
