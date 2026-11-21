// pruebas-seguridad/todas.js — corre los tres ataques en orden y al final
// levanta los bloqueos que dejó la prueba de fuerza bruta.
//
//   npm run prueba:seguridad
const { spawnSync } = require('child_process');
const path = require('path');

const extra = process.argv.slice(2);
const correr = (archivo, args = []) => spawnSync(process.execPath, [path.join(__dirname, archivo), ...args, ...extra], { stdio: 'inherit' }).status;

(async () => {
// Antes de empezar: se levantan bloqueos viejos y se comprueba que la cuenta
// de prueba entra (si no, las pruebas de sesión darían resultados falsos).
const { navegador, cuentaPrueba, motivoSinSesion, servidorArriba, C } = require('./comun');
const cuenta = cuentaPrueba();
await servidorArriba();
correr('desbloquear.js');
const r = await navegador().login({ tipo: 'cliente', ...cuenta });
const motivo = motivoSinSesion(r);
if (motivo) {
    console.log(`\n${C.mal}La cuenta de prueba ${cuenta.correo} no pudo iniciar sesión:${C.fin} ${motivo}\n`);
    process.exitCode = 1;
    return;
}
console.log(`${C.ok}Cuenta de prueba lista: ${cuenta.correo}${C.fin}\n`);

// Entre pruebas se levantan los bloqueos que dejó la anterior (si no, la
// IP de esta computadora queda bloqueada y la siguiente prueba no entra).
const fallos = [
    correr('1-fuerza-bruta.js'), correr('desbloquear.js') && 0,
    correr('2-inyeccion-sql.js'),
    correr('3-robo-de-sesion.js'),
].filter((s) => s !== 0).length;
console.log('\n── Limpieza ──');
correr('desbloquear.js');
console.log(fallos ? `\n${fallos} prueba(s) encontraron algo vulnerable.` : '\nTodas las defensas respondieron como se esperaba.');
process.exitCode = fallos ? 1 : 0;
})();
