// =========================================================
// npm run certificado
// Crea el certificado para que la tienda funcione con HTTPS en la red
// local, usando mkcert (https://github.com/FiloSottile/mkcert):
//   1. Instala en esta computadora una "autoridad" local (solo la primera
//      vez; Windows pregunta si confías en ella: di que sí).
//   2. Crea certs/kozmok.pem y certs/kozmok-key.pem para localhost,
//      kozmok.local y las IPs actuales de la computadora.
//   3. Copia la parte PÚBLICA de esa autoridad a certs/kozmok-ca.crt para
//      instalarla en los celulares de prueba (la llave nunca sale de aquí).
// Al reiniciar el servidor, abre también el 443 y las páginas por http se
// mandan a https. Si cambias de red (otra IP), vuelve a correrlo;
// kozmok.local sigue sirviendo sin hacerlo.
// =========================================================
require('./db.config.js');   // lee el .env (MDNS_NOMBRE)
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const enWindows = process.platform === 'win32';
const mkcert = (args) => spawnSync('mkcert', args, { encoding: 'utf8', shell: enWindows, stdio: ['inherit', 'pipe', 'pipe'] });

const v = mkcert(['-version']);
if (v.error || v.status !== 0) {
    console.log(`No encontré mkcert. Instálalo y vuelve a correr "npm run certificado":

  Windows (PowerShell):  winget install FiloSottile.mkcert
                         (o: choco install mkcert)  y abre otra ventana de PowerShell
  macOS:                 brew install mkcert nss
  Linux:                 sudo apt install mkcert libnss3-tools
`);
    process.exit(1);
}
console.log(`mkcert ${String(v.stdout || '').trim()} encontrado.`);

// 1. Autoridad local en esta computadora
console.log('\n1) Instalando la autoridad local (si Windows pregunta, acepta)…');
const ins = mkcert(['-install']);
process.stdout.write(ins.stdout || ''); process.stderr.write(ins.stderr || '');
if (ins.status !== 0) { console.log('No se pudo instalar la autoridad local.'); process.exit(1); }

// 2. Certificado para todos los nombres con los que se abre la tienda
const mdns = (() => {
    const n = String(process.env.MDNS_NOMBRE ?? 'kozmok').trim().toLowerCase().replace(/\.local$/, '');
    return ['', 'no', '0', 'false', 'apagado'].includes(n) ? null : `${/^[a-z0-9-]{1,40}$/.test(n) ? n : 'kozmok'}.local`;
})();
const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
const nombres = [...new Set(['localhost', '127.0.0.1', '::1', mdns, ...ips].filter(Boolean))];
const dir = path.join(__dirname, 'certs');
fs.mkdirSync(dir, { recursive: true });
console.log(`\n2) Creando el certificado para: ${nombres.join(', ')}`);
const crt = mkcert(['-cert-file', path.join(dir, 'kozmok.pem'), '-key-file', path.join(dir, 'kozmok-key.pem'), ...nombres]);
process.stdout.write(crt.stdout || ''); process.stderr.write(crt.stderr || '');
if (crt.status !== 0) { console.log('No se pudo crear el certificado.'); process.exit(1); }

// 3. Parte pública de la autoridad, para los celulares
const caroot = String(mkcert(['-CAROOT']).stdout || '').trim();
try {
    fs.copyFileSync(path.join(caroot, 'rootCA.pem'), path.join(dir, 'kozmok-ca.crt'));
    console.log('\n3) Certificado para celulares: certs/kozmok-ca.crt (solo la parte pública).');
} catch (e) { console.log(`\n3) No pude copiar rootCA.pem desde ${caroot}: ${e.message}`); }

console.log(`
Listo. Reinicia el servidor (npm start): la consola dirá "HTTPS: activo".
  - En esta computadora ya confía: abre ${mdns ? `https://${mdns}` : 'https://localhost'}
  - En cada celular de prueba, una sola vez: abre http://${mdns || ips[0] || 'localhost'}/kozmok-ca.crt
      Android: se descarga; Ajustes > Seguridad > Cifrado y credenciales >
               Instalar un certificado > Certificado de CA.
      iPhone:  Permitir el perfil; Ajustes > General > VPN y gestión de
               dispositivos > instalarlo; luego Ajustes > General > Información >
               Confianza de certificados > activarlo.
    Sin instalarlo el celular abre la tienda con un aviso de "no seguro".
  - Después de la clase puedes quitarlo de los celulares (es tu autoridad local).
  - La llave de la autoridad (rootCA-key.pem en ${caroot}) nunca se comparte.
`);
