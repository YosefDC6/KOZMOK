// env.js
// Carga las variables del archivo .env (junto a server.js) en process.env.
// Sin dependencias: formato CLAVE=valor, una por línea; las líneas que
// empiezan con # se ignoran (y lo que va después de ' #' también) y el
// valor puede ir entre comillas.
// Una variable que ya exista en el entorno del sistema NO se sobrescribe,
// así en un servidor se pueden definir directamente sin archivo .env.
const fs = require('fs');
const path = require('path');

const archivo = path.join(__dirname, '.env');

if (fs.existsSync(archivo)) {
    // El Bloc de notas o PowerShell (echo > .env) a veces lo guardan en
    // UTF-16 o con BOM: se aceptan ambos.
    const crudo = fs.readFileSync(archivo);
    const texto = crudo[0] === 0xff && crudo[1] === 0xfe ? crudo.toString('utf16le')
        : crudo[0] === 0xfe && crudo[1] === 0xff ? Buffer.from(crudo).swap16().toString('utf16le')
        : crudo.toString('utf8');
    for (const linea of texto.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let valor = m[2];
        if (/^(['"]).*\1$/.test(valor)) valor = valor.slice(1, -1);
        else valor = valor.replace(/\s+#.*$/, ''); // comentario al final de la línea
        if (process.env[m[1]] === undefined) process.env[m[1]] = valor;
    }
}

module.exports = { hayArchivoEnv: fs.existsSync(archivo) };
