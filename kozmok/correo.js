// correo.js
// Envío de correos reales por SMTP (pensado para Gmail) sin dependencias:
// solo los módulos net y tls de Node.
//
// Configuración en .env:
//   SMTP_USUARIO=tucuenta@gmail.com
//   SMTP_PASSWORD=abcdefghijklmnop      (contraseña de aplicación de Google,
//                                        NO la contraseña normal de la cuenta)
//   SMTP_HOST=smtp.gmail.com            (opcional)
//   SMTP_PUERTO=465                     (465 = TLS directo; 587 = STARTTLS)
//   CORREO_REMITENTE=Kozmok             (nombre que ve el cliente)
//
// Sin SMTP_USUARIO / SMTP_PASSWORD no se manda nada: los correos se quedan
// en la tabla correos_salida y se pueden leer en el panel (Seguridad →
// Correos enviados), como antes.
require('./env.js');   // lee el .env aunque se use sin server.js (prueba-correo.js)
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const CFG = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    puerto: Number(process.env.SMTP_PUERTO) || 465,
    // TLS desde el inicio (puerto 465) o STARTTLS (puerto 587)
    tlsDirecto: process.env.SMTP_TLS_DIRECTO ? process.env.SMTP_TLS_DIRECTO === '1' : (Number(process.env.SMTP_PUERTO) || 465) === 465,
    usuario: (process.env.SMTP_USUARIO || '').trim(),
    // Google muestra la contraseña de aplicación en grupos de 4 con espacios.
    password: String(process.env.SMTP_PASSWORD || '').replace(/\s+/g, ''),
    remitente: process.env.CORREO_REMITENTE || 'Kozmok',
    // Solo para pruebas locales con un servidor SMTP de mentira.
    tlsInseguro: process.env.SMTP_TLS_INSEGURO === '1',
    timeoutMs: 20000,
};

const configurado = () => !!(CFG.usuario && CFG.password);

// ---------------------------------------------------------
// Armado del mensaje (MIME: texto plano + HTML, UTF-8)
// ---------------------------------------------------------
const b64 = (t) => Buffer.from(String(t), 'utf8').toString('base64');
// Encabezado con acentos o ñ (RFC 2047)
const encabezado = (t) => (/^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${b64(t)}?=`);
const lineas76 = (t) => b64(t).replace(/.{1,76}/g, '$&\r\n');
const limpiarCabecera = (t) => String(t || '').replace(/[\r\n]+/g, ' ').trim();

// Imágenes incrustadas en el correo (Gmail no muestra SVG ni puede abrir
// imágenes de "localhost" ni de la red local): el HTML las usa como
// <img src="cid:kzk-logo"> y solo se adjuntan las que el HTML cita.
const IMAGENES = { 'kzk-logo': 'kzk-correo.png', 'kzk-tibu': 'tibu-correo.png', 'kzk-tibu-pixel': 'tibu-pixel-correo.png' };
const cacheImg = {};
function imagen(cid) {
    if (!(cid in cacheImg)) {
        try { cacheImg[cid] = require('fs').readFileSync(require('path').join(__dirname, 'public', 'img', IMAGENES[cid])); }
        catch { cacheImg[cid] = false; }
    }
    return cacheImg[cid];
}

function armarMensaje({ para, asunto, texto, html }) {
    const frontera = 'kz_' + crypto.randomBytes(12).toString('hex');
    const fronteraRel = 'kzr_' + crypto.randomBytes(12).toString('hex');
    const adjuntas = html ? Object.keys(IMAGENES).filter((cid) => html.includes(`cid:${cid}"`) && imagen(cid)) : [];
    const dominio = CFG.usuario.split('@')[1] || 'kozmok.local';
    const cab = [
        `From: ${encabezado(limpiarCabecera(CFG.remitente))} <${CFG.usuario}>`,
        `To: <${limpiarCabecera(para)}>`,
        `Subject: ${encabezado(limpiarCabecera(asunto))}`,
        `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
        `Message-ID: <${crypto.randomBytes(10).toString('hex')}@${dominio}>`,
        'MIME-Version: 1.0',
    ];
    let cuerpo;
    if (html) {
        const alternativa = [
            `--${frontera}`,
            'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', lineas76(texto),
            `--${frontera}`,
            'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', lineas76(html),
            `--${frontera}--`, '',
        ].join('\r\n');
        if (adjuntas.length) {
            // multipart/related = texto/HTML + las imágenes que el HTML cita
            cab.push(`Content-Type: multipart/related; boundary="${fronteraRel}"; type="multipart/alternative"`);
            cuerpo = [
                `--${fronteraRel}`,
                `Content-Type: multipart/alternative; boundary="${frontera}"`, '', alternativa,
                ...adjuntas.flatMap((cid) => [
                    `--${fronteraRel}`,
                    `Content-Type: image/png; name="${cid}.png"`, 'Content-Transfer-Encoding: base64',
                    `Content-ID: <${cid}>`, `Content-Disposition: inline; filename="${cid}.png"`, '',
                    imagen(cid).toString('base64').replace(/.{1,76}/g, '$&\r\n'),
                ]),
                `--${fronteraRel}--`, '',
            ].join('\r\n');
        } else {
            cab.push(`Content-Type: multipart/alternative; boundary="${frontera}"`);
            cuerpo = alternativa;
        }
    } else {
        cab.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
        cuerpo = lineas76(texto);
    }
    return cab.join('\r\n') + '\r\n\r\n' + cuerpo;
}

// ---------------------------------------------------------
// Conversación SMTP
// ---------------------------------------------------------
function conversacion(socket) {
    let buffer = '';
    let esperando = null;
    const respuestas = [];
    const alRecibir = (d) => {
        buffer += d.toString('utf8');
        // Una respuesta termina en la línea "NNN texto" (sin guion tras el código)
        let m;
        while ((m = buffer.match(/^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/))) {
            const bloque = m[0];
            buffer = buffer.slice(bloque.length);
            const r = { codigo: Number(bloque.trim().split(/\r?\n/).pop().slice(0, 3)), texto: bloque.trim() };
            if (esperando) { const f = esperando; esperando = null; f(r); } else respuestas.push(r);
        }
    };
    socket.on('data', alRecibir);
    const leer = () => new Promise((resolve) => {
        if (respuestas.length) resolve(respuestas.shift()); else esperando = resolve;
    });
    return {
        leer,
        quitar() { socket.removeListener('data', alRecibir); },
        async enviar(linea, esperado, { ocultar = false } = {}) {
            socket.write(linea + '\r\n');
            const r = await leer();
            const ok = Array.isArray(esperado) ? esperado.includes(r.codigo) : r.codigo === esperado;
            if (!ok) {
                const cmd = ocultar ? '(credenciales)' : linea.split(' ')[0];
                throw new Error(`SMTP ${cmd}: ${r.texto.replace(/\s+/g, ' ').slice(0, 200)}`);
            }
            return r;
        },
    };
}

function conectar() {
    return new Promise((resolve, reject) => {
        const opciones = { host: CFG.host, port: CFG.puerto, servername: CFG.host, rejectUnauthorized: !CFG.tlsInseguro };
        const socket = CFG.tlsDirecto ? tls.connect(opciones) : net.connect({ host: CFG.host, port: CFG.puerto });
        socket.setTimeout(CFG.timeoutMs, () => socket.destroy(new Error('El servidor de correo no respondió a tiempo')));
        socket.once(CFG.tlsDirecto ? 'secureConnect' : 'connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

function subirATLS(socket) {
    return new Promise((resolve, reject) => {
        const seguro = tls.connect({ socket, servername: CFG.host, rejectUnauthorized: !CFG.tlsInseguro }, () => resolve(seguro));
        seguro.setTimeout(CFG.timeoutMs, () => seguro.destroy(new Error('El servidor de correo no respondió a tiempo')));
        seguro.once('error', reject);
    });
}

// Manda un correo. Lanza un Error con el motivo si algo falla.
async function enviar({ para, asunto, texto, html }) {
    if (!configurado()) throw new Error('SMTP sin configurar');
    const nombreEquipo = (os.hostname() || 'kozmok').replace(/[^A-Za-z0-9.-]/g, '') || 'kozmok';
    let socket = await conectar();
    try {
        let smtp = conversacion(socket);
        const saludo = await smtp.leer();
        if (saludo.codigo !== 220) throw new Error(`SMTP saludo: ${saludo.texto}`);
        await smtp.enviar(`EHLO ${nombreEquipo}`, 250);
        if (!CFG.tlsDirecto) {
            await smtp.enviar('STARTTLS', 220);
            smtp.quitar();
            socket = await subirATLS(socket);
            smtp = conversacion(socket);
            await smtp.enviar(`EHLO ${nombreEquipo}`, 250);
        }
        await smtp.enviar('AUTH LOGIN', 334);
        await smtp.enviar(b64(CFG.usuario), 334, { ocultar: true });
        await smtp.enviar(b64(CFG.password), 235, { ocultar: true });
        await smtp.enviar(`MAIL FROM:<${CFG.usuario}>`, 250);
        await smtp.enviar(`RCPT TO:<${limpiarCabecera(para)}>`, [250, 251]);
        await smtp.enviar('DATA', 354);
        // Punto al inicio de línea se duplica (RFC 5321 §4.5.2)
        const datos = armarMensaje({ para, asunto, texto, html }).replace(/\r\n\./g, '\r\n..');
        await smtp.enviar(datos + '\r\n.', 250);
        await smtp.enviar('QUIT', [221, 250]).catch(() => {});
    } finally {
        socket.end();
    }
}

// Comprueba usuario y contraseña sin mandar nada (al arrancar el servidor).
async function verificar() {
    if (!configurado()) return { ok: false, motivo: 'sin configurar' };
    const nombreEquipo = (os.hostname() || 'kozmok').replace(/[^A-Za-z0-9.-]/g, '') || 'kozmok';
    let socket;
    try {
        socket = await conectar();
        let smtp = conversacion(socket);
        await smtp.leer();
        await smtp.enviar(`EHLO ${nombreEquipo}`, 250);
        if (!CFG.tlsDirecto) {
            await smtp.enviar('STARTTLS', 220);
            smtp.quitar();
            socket = await subirATLS(socket);
            smtp = conversacion(socket);
            await smtp.enviar(`EHLO ${nombreEquipo}`, 250);
        }
        await smtp.enviar('AUTH LOGIN', 334);
        await smtp.enviar(b64(CFG.usuario), 334, { ocultar: true });
        await smtp.enviar(b64(CFG.password), 235, { ocultar: true });
        await smtp.enviar('QUIT', [221, 250]).catch(() => {});
        return { ok: true };
    } catch (e) {
        return { ok: false, motivo: explicarError(e) };
    } finally {
        if (socket) socket.end();
    }
}

// Mensaje entendible para los errores más comunes con Gmail.
function explicarError(e) {
    const m = String((e && e.message) || e);
    if (/535|534|Username and Password not accepted|BadCredentials/i.test(m))
        return 'Gmail rechazó el usuario o la contraseña. Usa una contraseña de aplicación (no la normal) y verifica SMTP_USUARIO.';
    if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'Sin conexión a internet o no se encontró el servidor de correo.';
    if (/ECONNREFUSED|ETIMEDOUT|no respondió/i.test(m)) return 'No se pudo conectar al servidor de correo (¿red o firewall bloquean el puerto?).';
    return m.slice(0, 280);
}

// ---------------------------------------------------------
// ¿El correo puede existir? Se acepta cualquier terminación (gmail,
// hotmail, outlook, la de una escuela o empresa…) siempre que el dominio
// exista y tenga servidor de correo (registro MX en el DNS). Así se
// detectan errores como "@gmial.com" o "@hotmail.con" antes de crear la
// cuenta. Que el BUZÓN exista se comprueba después con el código de
// verificación que se le manda.
// ---------------------------------------------------------
const dns = require('dns').promises;

const POPULARES = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.mx', 'live.com',
    'live.com.mx', 'icloud.com', 'hotmail.es', 'outlook.es', 'prodigy.net.mx', 'protonmail.com', 'aol.com'];
// Errores de dedo frecuentes que SÍ existen como dominio (están estacionados
// y hasta tienen MX), así que el DNS no los atraparía.
const ERRATAS = {
    'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmal.com': 'gmail.com',
    'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com',
    'gmail.om': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmali.com': 'gmail.com',
    'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotamil.com': 'hotmail.com', 'hotmai.com': 'hotmail.com',
    'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'hotmil.com': 'hotmail.com', 'homail.com': 'hotmail.com',
    'outlok.com': 'outlook.com', 'outllok.com': 'outlook.com', 'outlook.con': 'outlook.com', 'outlook.co': 'outlook.com',
    'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhoo.com': 'yahoo.com',
    'icloud.con': 'icloud.com', 'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com',
};

function distancia(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}
function sugerirDominio(dominio) {
    if (ERRATAS[dominio]) return ERRATAS[dominio];
    let mejor = null, min = 3;
    for (const p of POPULARES) { const x = distancia(dominio, p); if (x > 0 && x < min) { min = x; mejor = p; } }
    return mejor;
}

const cacheDominios = new Map();   // dominio -> { ok, hasta }
const conTiempo = (promesa, ms) => Promise.race([promesa,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('tiempo'), { code: 'ETIMEOUT' })), ms))]);

// ¿Funciona el DNS? Sin internet TODOS los dominios fallarían, así que
// antes de rechazar uno se prueba con gmail.com (resultado guardado 5 min).
let dnsFunciona = { ok: null, hasta: 0 };
async function hayDNS() {
    if (dnsFunciona.hasta > Date.now()) return dnsFunciona.ok;
    let ok;
    try { ok = (await conTiempo(dns.resolveMx('gmail.com'), 4000)).length > 0; } catch { ok = false; }
    dnsFunciona = { ok, hasta: Date.now() + 5 * 60 * 1000 };
    return ok;
}

// Devuelve { ok: true } o { ok: false, motivo, sugerencia }.
// Si el DNS no responde (sin internet), no se bloquea el registro.
async function dominioRecibeCorreo(correoCompleto) {
    const [usuario, dominioCrudo] = String(correoCompleto || '').toLowerCase().split('@');
    const dominio = (dominioCrudo || '').trim();
    const sugerir = (d) => (d ? `${usuario}@${d}` : null);
    if (!dominio) return { ok: false, motivo: 'Falta la terminación del correo (lo que va después de @).' };
    if (ERRATAS[dominio]) {
        return { ok: false, sugerencia: sugerir(ERRATAS[dominio]),
            motivo: `"@${dominio}" parece un error de escritura. ¿Quisiste decir ${sugerir(ERRATAS[dominio])}?` };
    }
    if (POPULARES.includes(dominio)) return { ok: true };
    const c = cacheDominios.get(dominio);
    let ok;
    if (c && c.hasta > Date.now()) ok = c.ok;
    else {
        try {
            const mx = await conTiempo(dns.resolveMx(dominio), 4000);
            // MX nulo ("." , RFC 7505) = el dominio declara que no recibe correo
            ok = mx.some((r) => r.exchange && r.exchange !== '.');
        } catch (e) {
            if (!['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME'].includes(e.code)) return { ok: true, sinComprobar: true };
            ok = false;
        }
        // Falló: si ni gmail.com responde, el problema es la red, no el correo.
        if (!ok && !(await hayDNS())) return { ok: true, sinComprobar: true };
        cacheDominios.set(dominio, { ok, hasta: Date.now() + (ok ? 6 : 1) * 3600 * 1000 });
    }
    if (ok) return { ok: true };
    const s = sugerirDominio(dominio);
    return { ok: false, sugerencia: sugerir(s),
        motivo: `No encontramos el dominio "@${dominio}" o no recibe correos.` + (s ? ` ¿Quisiste decir ${sugerir(s)}?` : ' Revisa que esté bien escrito.') };
}

module.exports = { enviar, verificar, configurado, explicarError, armarMensaje, dominioRecibeCorreo, CFG };
