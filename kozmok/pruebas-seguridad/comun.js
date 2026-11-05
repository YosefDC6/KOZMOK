// pruebas-seguridad/comun.js
// Utilidades para las pruebas de ataque contra NUESTRO PROPIO servidor
// (Etapa 5: demostrar que las defensas funcionan). Por defecto solo se
// permite atacar localhost; para otro servidor propio usa --objetivo-propio.
//
//   node pruebas-seguridad/1-fuerza-bruta.js [http://localhost:3000]

const args = process.argv.slice(2);
const URL_BASE = (args.find((a) => /^https?:\/\//.test(a)) || process.env.KOZMOK_URL || 'http://localhost:3000').replace(/\/+$/, '');

const host = new URL(URL_BASE).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !args.includes('--objetivo-propio')) {
    console.error(`Estas pruebas solo se corren contra tu propio servidor. ${host} no es localhost.`);
    console.error('Si de verdad es tu servidor del proyecto, agrega --objetivo-propio.');
    process.exit(1);
}

const C = { ok: '\x1b[32m', mal: '\x1b[31m', aviso: '\x1b[33m', gris: '\x1b[90m', neg: '\x1b[1m', fin: '\x1b[0m' };
const titulo = (t) => console.log(`\n${C.neg}══ ${t} ══${C.fin}`);
const paso = (t) => console.log(`${C.neg}▸ ${t}${C.fin}`);
const info = (t) => console.log(`${C.gris}  ${t}${C.fin}`);

const resultados = [];
function verificar(nombre, paso_bien, detalle = '') {
    resultados.push({ nombre, paso_bien });
    console.log(`  ${paso_bien ? C.ok + '✔ DEFENDIDO' : C.mal + '✘ VULNERABLE'}${C.fin}  ${nombre}${detalle ? C.gris + ' — ' + detalle + C.fin : ''}`);
}
function resumen() {
    const malos = resultados.filter((r) => !r.paso_bien);
    console.log(`\n${C.neg}Resultado: ${resultados.length - malos.length}/${resultados.length} ataques bloqueados${C.fin}`);
    if (malos.length) { malos.forEach((m) => console.log(`${C.mal}  ✘ ${m.nombre}${C.fin}`)); process.exitCode = 1; }
}

// Cliente HTTP con su propia "cookie jar" y su propio navegador (User-Agent).
function navegador(userAgent = 'Mozilla/5.0 (Prueba de seguridad Kozmok) Chrome/130') {
    const jar = {};
    async function pedir(metodo, ruta, { body, headers = {}, cookies = true } = {}) {
        const h = { 'User-Agent': userAgent, ...headers };
        if (body !== undefined) h['Content-Type'] = 'application/json';
        const galletas = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        if (cookies && galletas && !h.Cookie) h.Cookie = galletas;
        const r = await fetch(URL_BASE + ruta, { method: metodo, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
        for (const sc of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
            const [par] = sc.split(';');
            const i = par.indexOf('=');
            const k = par.slice(0, i), v = par.slice(i + 1);
            if (/Max-Age=0/i.test(sc) || v === '') delete jar[k]; else jar[k] = v;
        }
        const texto = await r.text();
        let json = null;
        try { json = JSON.parse(texto); } catch { /* no es JSON */ }
        return { status: r.status, json, texto, headers: r.headers };
    }
    // Inicio de sesión legítimo de la prueba: si el límite de intentos por
    // minuto (otra defensa) ya se activó, espera lo que indica Retry-After.
    async function login(body) {
        let r = await pedir('POST', '/api/auth/login', { body });
        for (let i = 0; i < 6 && r.status === 429 && r.json && /poco tiempo/.test(r.json.message || ''); i++) {
            const seg = Math.min(Math.max(Number(r.headers.get('retry-after')) || 60, 5), 70);
            console.log(`${C.gris}  (el límite de 15 intentos por minuto está activo: se espera ${seg} s y se reintenta)${C.fin}`);
            await new Promise((ok) => setTimeout(ok, seg * 1000 + 500));
            r = await pedir('POST', '/api/auth/login', { body });
        }
        if (r.status === 429) console.log(`${C.aviso}  (acceso bloqueado: ${(r.json && r.json.message) || ''} → corre "npm run desbloquear")${C.fin}`);
        return r;
    }
    return {
        jar, userAgent, login,
        get: (ruta, o) => pedir('GET', ruta, o),
        post: (ruta, body, o) => pedir('POST', ruta, { ...o, body }),
        put: (ruta, body, o) => pedir('PUT', ruta, { ...o, body }),
        del: (ruta, o) => pedir('DELETE', ruta, o),
    };
}

async function servidorArriba() {
    try {
        const r = await fetch(URL_BASE + '/api');
        if (r.ok) return true;
    } catch { /* abajo */ }
    console.error(`${C.mal}No hay servidor en ${URL_BASE}. Arráncalo con "npm start" y vuelve a intentar.${C.fin}`);
    process.exit(1);
}

module.exports = { URL_BASE, C, titulo, paso, info, verificar, resumen, navegador, servidorArriba, args };
