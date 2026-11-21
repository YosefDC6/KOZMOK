// ATAQUE 1 · FUERZA BRUTA
// Un atacante prueba muchas contraseñas contra una cuenta hasta atinarle.
// Qué debe pasar: tras 5 contraseñas equivocadas la cuenta se bloquea 15
// minutos y, aunque después pruebe la contraseña correcta, NO entra.
// Con --ip también prueba "relleno de credenciales" (una contraseña contra
// muchas cuentas) para ver el límite por conexión y el bloqueo de la IP.
//
//   npm run prueba:fuerza-bruta -- --correo=prueba@tucorreo.com --password=TuClave#1
//   (agrega --ip para probar también el bloqueo por conexión)
const { titulo, paso, info, verificar, resumen, navegador, servidorArriba, args, C, cuentaPrueba } = require('./comun');

const { correo: cuenta, password: correcta } = cuentaPrueba();
// Diccionario corto de contraseñas comunes; la correcta va al final.
const DICCIONARIO = ['123456', 'password', 'qwerty123', 'Hola2026', 'contrasena1', 'Mexico2026!', 'Kozmok123', correcta];

(async () => {
    await servidorArriba();
    // Antes del ataque (con la cuenta aún sin bloquear): si se hiciera después,
    // se compararía una cuenta bloqueada contra un correo nuevo.
    paso('Mismo mensaje exista o no el correo (no se puede adivinar quién está registrado)');
    const a = await navegador().login({ tipo: 'cliente', correo: cuenta, password: 'Equivocada#1' });
    const b = await navegador().login({ tipo: 'cliente', correo: 'no-existe-' + Date.now() + '@correo.com', password: 'Equivocada#1' });
    const limpio = (m) => String(m || '').replace(/ Te quedan.*$/, '');
    verificar('Respuesta igual para un correo real y uno inexistente', a.status === b.status && limpio(a.json && a.json.message) === limpio(b.json && b.json.message), `"${limpio(a.json && a.json.message)}"`);

    titulo(`Fuerza bruta contra ${cuenta}`);
    const atacante = navegador('Hydra-simulado/1.0');
    let bloqueada = false, entro = false, captcha = false;
    for (const [i, pw] of DICCIONARIO.entries()) {
        const r = await atacante.post('/api/auth/login', { tipo: 'cliente', correo: cuenta, password: pw });
        const estado = r.status === 200 ? `${C.mal}ENTRÓ${C.fin}` : r.status === 429 ? `${C.aviso}BLOQUEADO${C.fin}` : `${C.gris}rechazado${C.fin}`;
        console.log(`  intento ${String(i + 1).padStart(2)}  ${pw.padEnd(14)} → ${r.status} ${estado}  ${C.gris}${(r.json && r.json.message) || ''}${C.fin}`);
        if (r.status === 429) bloqueada = true;
        if (r.status === 400 && r.json && r.json.captcha) captcha = true;
        if (r.status === 200) { entro = true; break; }
    }
    if (captcha && !bloqueada) {
        // Desde otra computadora con reCAPTCHA activo: el captcha frena el ataque antes del bloqueo.
        verificar('reCAPTCHA frena el ataque: ningún intento llega a revisar la contraseña', !entro);
        info('Para ver además el bloqueo de la cuenta, corre las pruebas en la computadora del servidor (npm run prueba:seguridad).');
    } else verificar('La cuenta se bloquea antes de agotar el diccionario', bloqueada);
    verificar('Ni con la contraseña correcta entra mientras está bloqueada', !entro);
    info('En el panel: Cuenta → Seguridad → Bloqueos (ahí se puede desbloquear).');

    paso('Un correo que no existe también se "bloquea" (el bloqueo no delata qué cuentas existen)');
    const fantasma = 'no-existe-' + Date.now() + '@correo.com', bot = navegador('Hydra-simulado/1.0');
    let fb = null;
    for (let i = 0; i < 6; i++) fb = await bot.login({ tipo: 'cliente', correo: fantasma, password: 'Equivocada#' + i });
    if (fb.status === 400 && fb.json && fb.json.captcha) info('(se omite: reCAPTCHA frena estos intentos antes del bloqueo)');
    else verificar('Tras los mismos intentos responde "cuenta bloqueada" aunque no exista', fb.status === 429 && /bloqueada/.test((fb.json && fb.json.message) || ''), `${fb.status}`);

    if (args.includes('--ip')) {
        titulo('Relleno de credenciales (una contraseña contra muchas cuentas)');
        const bot = navegador('credential-stuffing/1.0');
        let limitado = false, ipBloqueada = false;
        for (let i = 1; i <= 25; i++) {
            const r = await bot.post('/api/auth/login', { tipo: 'cliente', correo: `victima${i}@correo.com`, password: 'Verano2026!' });
            if (r.status === 429) { limitado = true; if (/conexión/.test(r.json.message)) ipBloqueada = true; }
            process.stdout.write(r.status === 429 ? `${C.aviso}■${C.fin}` : `${C.gris}·${C.fin}`);
        }
        console.log('');
        verificar('El servidor frena la ráfaga de intentos desde la misma conexión (429)', limitado);
        info(ipBloqueada ? 'Además la IP quedó bloqueada 30 min para el acceso de clientes.' : 'El límite por minuto respondió antes del bloqueo de IP.');
    }
    info('Para volver a dejar todo como estaba: npm run desbloquear');
    resumen();
})();
