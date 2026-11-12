// ATAQUE 1 · FUERZA BRUTA
// Un atacante prueba muchas contraseñas contra una cuenta hasta atinarle.
// Qué debe pasar: tras 5 contraseñas equivocadas la cuenta se bloquea 15
// minutos y, aunque después pruebe la contraseña correcta, NO entra.
// Con --ip también prueba "relleno de credenciales" (una contraseña contra
// muchas cuentas) para ver el límite por conexión y el bloqueo de la IP.
//
//   npm run prueba:fuerza-bruta
//   node pruebas-seguridad/1-fuerza-bruta.js --cuenta=diego@correo.com --ip
const { titulo, paso, info, verificar, resumen, navegador, servidorArriba, args, C } = require('./comun');

const cuenta = (args.find((a) => a.startsWith('--cuenta=')) || '--cuenta=diego@correo.com').split('=')[1];
const correcta = (args.find((a) => a.startsWith('--real=')) || '--real=Demo#KZ2026').split('=')[1];
// Diccionario corto de contraseñas comunes; la correcta va al final.
const DICCIONARIO = ['123456', 'password', 'qwerty123', 'Diego2026', 'diego123', 'Mexico2026!', 'Kozmok123', correcta];

(async () => {
    await servidorArriba();
    titulo(`Fuerza bruta contra ${cuenta}`);
    const atacante = navegador('Hydra-simulado/1.0');
    let bloqueada = false, entro = false;
    for (const [i, pw] of DICCIONARIO.entries()) {
        const r = await atacante.post('/api/auth/login', { tipo: 'cliente', correo: cuenta, password: pw });
        const estado = r.status === 200 ? `${C.mal}ENTRÓ${C.fin}` : r.status === 429 ? `${C.aviso}BLOQUEADO${C.fin}` : `${C.gris}rechazado${C.fin}`;
        console.log(`  intento ${String(i + 1).padStart(2)}  ${pw.padEnd(14)} → ${r.status} ${estado}  ${C.gris}${(r.json && r.json.message) || ''}${C.fin}`);
        if (r.status === 429) bloqueada = true;
        if (r.status === 200) { entro = true; break; }
    }
    verificar('La cuenta se bloquea antes de agotar el diccionario', bloqueada);
    verificar('Ni con la contraseña correcta entra mientras está bloqueada', !entro);
    info('En el panel: Cuenta → Seguridad → Bloqueos (ahí se puede desbloquear).');

    paso('Mismo mensaje exista o no el correo (no se puede adivinar quién está registrado)');
    const a = await navegador().post('/api/auth/login', { tipo: 'cliente', correo: 'mariana@correo.com', password: 'Equivocada#1' });
    const b = await navegador().post('/api/auth/login', { tipo: 'cliente', correo: 'no-existe-' + Date.now() + '@correo.com', password: 'Equivocada#1' });
    const limpio = (m) => String(m || '').replace(/ Te quedan.*$/, '');
    verificar('Respuesta igual para un correo real y uno inexistente', a.status === b.status && limpio(a.json.message) === limpio(b.json.message), `"${limpio(a.json.message)}"`);

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
