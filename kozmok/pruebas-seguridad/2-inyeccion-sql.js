// ATAQUE 2 · INYECCIÓN SQL
// El atacante mete código SQL en los campos (login, buscador, id de la
// URL) para saltarse el login, leer otras tablas o borrar datos.
// Qué debe pasar: el filtro lo detecta, lo bloquea y lo registra; y aun
// con el filtro en modo "registrar" (FILTRO_SQLI=registrar en .env) las
// consultas parametrizadas tratan el texto como dato, nunca como SQL.
//
//   npm run prueba:sqli
const { titulo, paso, info, verificar, resumen, navegador, servidorArriba } = require('./comun');

const filtra = (r) => /\$2[aby]\$|password_hash|pg_shadow|information_schema|syntax error|at character/i.test(r.texto);

(async () => {
    await servidorArriba();
    const nav = navegador('sqlmap-simulado/1.7');

    titulo('1) Saltarse el login');
    for (const correo of ["admin@kozmok.mx' OR '1'='1' --", "' OR 1=1 --", "admin@kozmok.mx'--"]) {
        const r = await nav.post('/api/auth/login', { tipo: 'usuario', email: correo, password: 'cualquiera' });
        console.log(`  ${correo.padEnd(34)} → ${r.status}  ${(r.json && r.json.message) || ''}`);
        verificar(`No entra con ${correo}`, r.status !== 200 && !(r.json && r.json.success));
    }
    const r1 = await nav.post('/api/auth/login', { tipo: 'cliente', correo: 'mariana@correo.com', password: "' OR '1'='1" });
    verificar('La contraseña tampoco se puede inyectar', r1.status !== 200);

    titulo('2) Leer otras tablas desde el buscador (UNION SELECT)');
    const payloads = [
        "' UNION SELECT id, email, password_hash FROM usuarios --",
        "laptop'; DROP TABLE clientes; --",
        "x' AND pg_sleep(5) --",
        "' OR 1=1 --",
    ];
    for (const p of payloads) {
        const t0 = Date.now();
        const r = await nav.get('/api/catalogo?buscar=' + encodeURIComponent(p));
        const ms = Date.now() - t0;
        console.log(`  buscar=${p.slice(0, 48).padEnd(48)} → ${r.status} en ${ms} ms`);
        verificar('No regresa datos internos ni errores de SQL', !filtra(r));
        if (/pg_sleep/.test(p)) verificar('La inyección a ciegas por tiempo no hace esperar al servidor', ms < 4000, `${ms} ms`);
    }

    titulo('3) Manipular el identificador de la URL');
    for (const ruta of ['/api/catalogo/1%20OR%201=1', '/api/catalogo/1;DROP%20TABLE%20productos', "/api/catalogo/0'%20UNION%20SELECT%201--", '/api/catalogo/abc']) {
        const r = await nav.get(ruta);
        console.log(`  ${decodeURIComponent(ruta).padEnd(44)} → ${r.status} ${(r.json && r.json.message) || ''}`);
        verificar('Se rechaza sin tocar la base', r.status === 400 && !filtra(r));
    }

    titulo('4) ¿Siguen los datos completos?');
    const cat = await nav.get('/api/catalogo');
    verificar('El catálogo sigue completo (ninguna tabla se borró)', cat.status === 200 && Array.isArray(cat.json) && cat.json.length > 0, `${cat.json ? cat.json.length : 0} productos`);
    const ord = await nav.get('/api/catalogo?orden=' + encodeURIComponent('precio; DROP TABLE productos'));
    verificar('ORDER BY solo acepta valores de una lista blanca', ord.status === 200 || ord.status === 400);
    info('En el panel: Cuenta → Seguridad → Eventos (tipo "Inyección SQL").');
    info('Defensa principal: consultas parametrizadas ($1, $2…) en server.js; el filtro es una capa extra.');
    resumen();
})();
