// =========================================================
// PANEL OCULTO: la entrada del equipo vive en una dirección secreta
//
//   /admin/<PANEL_RUTA>/              iniciar sesión
//   /admin/<PANEL_RUTA>/recuperar     ¿olvidaste tu contraseña?
//   /admin/<PANEL_RUTA>/restablecer   enlace del correo para poner otra
//   /admin/<PANEL_RUTA>/activar       enlace del correo de una cuenta nueva
//
// PANEL_RUTA es un código aleatorio (24 caracteres, 144 bits) que se lee
// del .env; si no está, se genera solo la primera vez y se guarda ahí.
// Con eso:
//   - /admin/login.html (y recuperar, restablecer, activar) ya no existen:
//     responden la misma página 404 que cualquier dirección inventada, y el
//     intento queda en Seguridad.
//   - El resto del panel (/admin/*.html) solo se entrega a quien trae una
//     sesión válida del equipo, y solo las pantallas que su rol puede ver
//     (las mismas claves de permisos.js que valida la API). Sin sesión no se
//     ve ni se sabe que el panel existe; con un rol que no le toca, el
//     servidor lo manda a su inicio aunque haya cambiado su rol en el
//     navegador.
// Los scripts de /admin/js/ siguen públicos: no traen datos ni la
// dirección secreta (la necesita la página de acceso antes de entrar).
// =========================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { puedeVer, homeDe } = require('./public/admin/js/permisos.js');

const DIR_ADMIN = path.join(__dirname, 'public', 'admin');
const PAGINA_404 = path.join(__dirname, 'public', '404.html');
const ARCHIVO_ENV = path.join(__dirname, '.env');
const FORMATO = /^[A-Za-z0-9_-]{16,64}$/;
// Pantallas del panel a las que puede llevar ?next= (nunca a otro sitio).
const FORMATO_PANTALLA = /^\/admin\/[a-z0-9-]+\.html(\?[^#\s]*)?$/;

// Páginas de acceso: solo se entregan bajo la dirección secreta.
const ACCESO = { '': 'login.html', recuperar: 'recuperar.html', restablecer: 'restablecer.html', activar: 'activar.html' };
const ARCHIVOS_ACCESO = new Set(Object.values(ACCESO));

let RUTA = '';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
// Comparación en tiempo constante: no se puede adivinar letra por letra.
const esRuta = (s) => crypto.timingSafeEqual(sha256(s), sha256(RUTA));

// Guarda PANEL_RUTA en el .env (la reemplaza si ya había una línea).
// Un .env en UTF-16 no se toca, para no estropearlo.
function guardarEnEnv(valor) {
    try {
        let texto = '';
        if (fs.existsSync(ARCHIVO_ENV)) {
            const crudo = fs.readFileSync(ARCHIVO_ENV);
            if ((crudo[0] === 0xff && crudo[1] === 0xfe) || (crudo[0] === 0xfe && crudo[1] === 0xff)) return false;
            texto = crudo.toString('utf8');
        }
        const eol = texto.includes('\r\n') ? '\r\n' : '\n';
        const linea = `PANEL_RUTA=${valor}`;
        const re = /^[ \t]*PANEL_RUTA[ \t]*=.*$/m;
        if (re.test(texto)) texto = texto.replace(re, linea);
        else {
            if (texto && !texto.endsWith('\n')) texto += eol;
            texto += `${eol}# Dirección secreta del panel (se generó sola; ver .env.example)${eol}${linea}${eol}`;
        }
        fs.writeFileSync(ARCHIVO_ENV, texto);
        return true;
    } catch (e) {
        console.error('Panel oculto: no se pudo guardar PANEL_RUTA en el .env ->', e.message);
        return false;
    }
}

// Lee PANEL_RUTA del .env o genera una nueva. Devuelve qué pasó para el
// mensaje del arranque.
function cargarRuta() {
    const dada = (process.env.PANEL_RUTA || '').trim();
    if (FORMATO.test(dada)) { RUTA = dada; return { generada: false }; }
    RUTA = crypto.randomBytes(18).toString('base64url');
    return { generada: true, invalida: !!dada, guardada: guardarEnEnv(RUTA) };
}

// Pantalla del panel -> clave de permiso que pide (la misma que cada página
// le pasa a renderAdminSidebar). Se lee de los archivos al arrancar, así
// una pantalla nueva queda protegida sin tocar nada aquí. Sin clave (como
// recibo.html) basta con tener sesión.
function clavesDePaginas() {
    const claves = Object.create(null);
    for (const archivo of fs.readdirSync(DIR_ADMIN)) {
        if (!archivo.endsWith('.html') || ARCHIVOS_ACCESO.has(archivo)) continue;
        const html = fs.readFileSync(path.join(DIR_ADMIN, archivo), 'utf8');
        const m = html.match(/renderAdminSidebar\(\s*'([a-z0-9-]+)'\s*\)/);
        claves[archivo] = m ? m[1] : null;
    }
    return claves;
}

// Dirección completa de una página de acceso, para los correos y la consola.
function url(origen, pagina = '') {
    return `${String(origen).replace(/\/+$/, '')}/admin/${RUTA}/${pagina}`;
}

// Enlace de un correo a una pantalla del panel (p. ej. /admin/soporte.html?ticket=5).
// Pasa por la entrada secreta con ?next=: la cookie de sesión es SameSite=Strict
// y no viaja al dar clic desde Gmail, así que abrir la pantalla directo daría
// 404. La entrada revisa la sesión (o pide iniciarla) y luego abre esa pantalla.
function enlace(origen, pantalla) {
    const p = String(pantalla || '');
    return FORMATO_PANTALLA.test(p) ? `${url(origen)}?next=${encodeURIComponent(p)}` : url(origen);
}

function instalar(app, { pool, seg }) {
    const estado = cargarRuta();
    const claves = clavesDePaginas();
    // La misma respuesta que da el servidor a cualquier página que no existe.
    const noExiste = (res) => res.status(404).sendFile(PAGINA_404);

    app.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        // La ruta se revisa como la entendería el servidor de archivos
        // (decodificada, sin "..", y en Windows sin distinguir mayúsculas),
        // para que /ADMIN/LOGIN.HTML o /admin/js/../login.html no se cuelen.
        let ruta;
        try { ruta = path.posix.normalize(decodeURIComponent(req.path).replace(/\\/g, '/')); } catch { return noExiste(res); }
        const r = ruta.toLowerCase();
        if (r !== '/admin' && !r.startsWith('/admin/')) return next();
        if (/^\/admin\/js\/[^/]+$/.test(r)) return next();

        try {
            // Dirección secreta (aquí sí cuentan las mayúsculas: son parte del código).
            const m = ruta.match(/^\/admin\/([A-Za-z0-9_-]{16,64})(\/([a-z]*))?$/);
            if (m && esRuta(m[1])) {
                if (!m[2]) {
                    const q = req.originalUrl.indexOf('?');
                    return res.redirect(302, url('', '') + (q >= 0 ? req.originalUrl.slice(q) : ''));
                }
                const pagina = ACCESO[m[3]];
                if (!pagina) return noExiste(res);
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('X-Robots-Tag', 'noindex, nofollow');
                return res.sendFile(path.join(DIR_ADMIN, pagina));
            }

            const nombre = r.slice('/admin/'.length);
            if (ARCHIVOS_ACCESO.has(nombre)) {
                seg.registrarEvento(req, { tipo: 'panel_oculto', severidad: 'baja',
                    detalle: `Se intentó abrir ${req.path}: la entrada del panel es una dirección secreta` });
                return noExiste(res);
            }

            // Cualquier otra pantalla: sesión válida del equipo y un rol que la pueda ver.
            const s = await seg.leerSesion(req, 'usuario');
            if (!s) return noExiste(res);
            const u = (await pool.query('SELECT rol, activo FROM usuarios WHERE id = $1', [s.usuario_id])).rows[0];
            if (!u || !u.activo) return noExiste(res);
            if (nombre === '') return res.redirect(302, homeDe(u.rol));
            if (!(nombre in claves)) return noExiste(res);
            const clave = claves[nombre];
            if (clave && !puedeVer(u.rol, clave)) return res.redirect(302, homeDe(u.rol));
            res.setHeader('Cache-Control', 'no-store');
            return res.sendFile(path.join(DIR_ADMIN, nombre));
        } catch (e) {
            console.error('Panel oculto ->', e.message);
            return noExiste(res);
        }
    });
    return estado;
}

module.exports = { instalar, url, enlace };
