// =========================================================
// Dirección secreta del panel interno.
//
// Las pantallas del panel viven en public/admin/, pero ya no se abren en
// /admin/...: se sirven en una ruta difícil de adivinar (PANEL_RUTA en el
// .env; si no hay, se genera una al azar y se guarda en .panel-ruta para que
// no cambie entre reinicios). Quien pruebe /admin/... recibe la página 404 de
// la tienda, sin pista de que el panel existe.
//
// Esto se suma a las defensas reales (sesión, dos pasos, permisos por rol en
// cada llamada a la API); no las reemplaza.
//
// Contra el robo de roles, dentro de la ruta secreta las pantallas del
// panel (salvo las de acceso: login, recuperar, restablecer y activar) solo
// se entregan con una sesión válida del equipo y si el rol de esa sesión
// puede verlas (la misma clave que cada página le pasa a
// renderAdminSidebar, validada con permisos.js). Sin sesión se va al login
// con ?next= (así un enlace de un correo abre su pantalla después de
// entrar); con un rol que no le toca, a su inicio, aunque haya cambiado su
// rol en el navegador.
//
// El código del panel sigue escribiendo "/admin/..." en sus enlaces; al
// servirlo se cambia por la ruta secreta, igual que en las respuestas de
// /api/admin/... y en los correos al equipo.
// =========================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function crearPanel({ dirPublico, dirProyecto, pool = null, seg = null }) {
    const dirAdmin = path.join(dirPublico, 'admin');
    const { puedeVer, homeDe } = require(path.join(dirAdmin, 'js', 'permisos.js'));
    // Pantallas de acceso: se abren sin sesión.
    const ACCESO = new Set(['login.html', 'recuperar.html', 'restablecer.html', 'activar.html']);
    // Pantalla -> clave de permiso que pide (null = basta con tener sesión).
    // Se lee de los archivos al arrancar: una pantalla nueva queda protegida sola.
    const CLAVES = Object.create(null);
    for (const a of fs.readdirSync(dirAdmin)) {
        if (!a.endsWith('.html') || ACCESO.has(a)) continue;
        const m = fs.readFileSync(path.join(dirAdmin, a), 'utf8').match(/renderAdminSidebar\(\s*'([a-z0-9-]+)'\s*\)/);
        CLAVES[a] = m ? m[1] : null;
    }
    const ruta = leerRuta();
    const PREFIJO = '/' + ruta + '/';
    const oculto = ruta.toLowerCase() !== 'admin';
    // Solo enlaces a archivos del panel ("/admin/soporte.html?ticket=4",
    // "/admin/js/permisos.js"); las llamadas a la API ("/admin/tickets/4",
    // que api() convierte en /api/admin/...) y "/api/admin/..." no se tocan.
    const RE_ADMIN = /(?<![\w.-])\/admin(?=\/(?:[\w-]+\/)*[\w-]+\.(?:html|js|css)\b)/g;
    const traducir = (txt) => (oculto ? String(txt).replace(RE_ADMIN, '/' + ruta) : String(txt));

    function leerRuta() {
        let r = String(process.env.PANEL_RUTA || '').trim().replace(/^\/+|\/+$/g, '');
        const archivo = path.join(dirProyecto, '.panel-ruta');
        if (!r) {
            try { r = fs.readFileSync(archivo, 'utf8').trim(); } catch { /* primera vez */ }
            if (!r) {
                r = 'kz-' + crypto.randomBytes(8).toString('hex');
                try { fs.writeFileSync(archivo, r + '\n'); } catch (e) { console.warn('No se pudo guardar .panel-ruta:', e.message); }
            }
        }
        const choca = fs.existsSync(path.join(dirPublico, r)) && r.toLowerCase() !== 'admin';
        if (!/^[a-z0-9][a-z0-9_-]{3,63}$/i.test(r) || choca || /^api$/i.test(r)) {
            console.warn(`PANEL_RUTA "${r}" no es válida (letras, números y guiones, 4 a 64; no puede ser una carpeta de la tienda). Se usa /admin.`);
            r = 'admin';
        }
        return r;
    }

    // Archivos de texto del panel, ya traducidos (se recargan si cambian).
    const cache = new Map();
    function leerTraducido(archivo) {
        const st = fs.statSync(archivo);
        const c = cache.get(archivo);
        if (c && c.mtime === st.mtimeMs) return c;
        let txt = traducir(fs.readFileSync(archivo, 'utf8'));
        if (archivo.endsWith('.html')) {
            txt = txt.replace(/<head>/i, `<head>\n<meta name="kz-panel" content="${PREFIJO}">\n<meta name="robots" content="noindex, nofollow">`);
        }
        const nuevo = { mtime: st.mtimeMs, txt, etag: '"' + crypto.createHash('sha1').update(txt).digest('base64').slice(0, 20) + '"' };
        cache.set(archivo, nuevo);
        return nuevo;
    }
    const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

    // Normaliza lo que pidió el navegador: decodifica, quita "..", barras
    // invertidas y mayúsculas (en Windows /ADMIN/ abriría la carpeta igual).
    function normalizar(p) {
        let d = p;
        try { d = decodeURIComponent(p); } catch { /* se deja como venía */ }
        return path.posix.normalize(d.replace(/\\/g, '/')).toLowerCase();
    }

    // Sesión del equipo que trae la petición (o null) y su rol.
    async function sesionDe(req) {
        if (!pool || !seg) return { rol: '*' };   // sin base (pruebas): solo se oculta la ruta
        const s = await seg.leerSesion(req, 'usuario');
        if (!s) return null;
        const u = (await pool.query('SELECT rol, activo FROM usuarios WHERE id = $1', [s.usuario_id])).rows[0];
        return u && u.activo ? { rol: u.rol } : null;
    }

    async function middleware(req, res, next) {
        try { return await atender(req, res, next); } catch (e) { console.error('Panel ->', e.message); return no(res); }
    }
    async function atender(req, res, next) {
        if (req.path.startsWith('/api/')) return next();
        const norm = normalizar(req.path);
        const pre = PREFIJO.toLowerCase();
        if (norm === pre.slice(0, -1) || norm === pre) return res.redirect(PREFIJO + 'login.html');
        if (norm.startsWith(pre)) {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            let rel;
            try { rel = decodeURIComponent(req.path).slice(PREFIJO.length); } catch { return no(res); }
            const archivo = path.resolve(dirAdmin, rel);
            if (!archivo.startsWith(dirAdmin + path.sep) || !fs.existsSync(archivo) || !fs.statSync(archivo).isFile()) return no(res);
            res.setHeader('X-Robots-Tag', 'noindex, nofollow');
            const ext = path.extname(archivo).toLowerCase();
            // Pantallas (no las de acceso): sesión del equipo y rol que la pueda ver.
            const nombre = path.basename(archivo);
            if (ext === '.html' && !ACCESO.has(nombre)) {
                const quien = await sesionDe(req);
                if (!quien) {
                    res.setHeader('Cache-Control', 'no-store');
                    return res.redirect(302, `${PREFIJO}login.html?next=${encodeURIComponent(req.originalUrl)}`);
                }
                const clave = CLAVES[nombre];
                if (quien.rol !== '*' && clave && !puedeVer(quien.rol, clave)) {
                    res.setHeader('Cache-Control', 'no-store');
                    return res.redirect(302, traducir(homeDe(quien.rol)));
                }
            }
            if (!TIPOS[ext]) return res.sendFile(archivo);
            const { txt, etag } = leerTraducido(archivo);
            res.setHeader('Content-Type', TIPOS[ext]);
            res.setHeader('Cache-Control', ext === '.html' ? 'no-store' : 'no-cache');
            res.setHeader('ETag', etag);
            if (ext !== '.html' && req.headers['if-none-match'] === etag) return res.status(304).end();
            return res.send(txt);
        }
        // La carpeta real no se sirve directo cuando hay ruta secreta. Quien
        // intenta abrir el login por su dirección conocida queda en Seguridad.
        if (oculto && (norm === '/admin' || norm.startsWith('/admin/'))) {
            if (seg && /^\/admin\/(login|recuperar|restablecer|activar)\.html/.test(norm)) {
                seg.registrarEvento(req, { tipo: 'panel_oculto', severidad: 'baja',
                    detalle: `Se intentó abrir ${String(req.path).slice(0, 120)}: el panel está en una dirección secreta` });
            }
            return no(res);
        }
        next();
    }
    function no(res) {
        res.status(404).sendFile(path.join(dirPublico, '404.html'));
    }

    // Respuestas JSON de /api/admin: los enlaces a pantallas del panel
    // (notificaciones, bandeja de soporte...) salen con la ruta secreta.
    function json(req, res, next) {
        if (!oculto || !req.path.startsWith('/api/admin')) return next();
        const original = res.json.bind(res);
        res.json = (cuerpo) => original(recorrer(cuerpo));
        next();
    }
    function recorrer(v) {
        if (typeof v === 'string') return v.includes('/admin') ? traducir(v) : v;
        if (Array.isArray(v)) return v.map(recorrer);
        if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
            const o = {};
            for (const k of Object.keys(v)) o[k] = recorrer(v[k]);
            return o;
        }
        return v;
    }

    return {
        ruta, oculto,
        prefijo: PREFIJO,
        // Enlace a una pantalla del panel: url('/admin/login.html') -> '/<ruta>/login.html'
        url: (p) => traducir(p),
        middleware, json,
    };
};
