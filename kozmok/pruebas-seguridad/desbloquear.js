// pruebas-seguridad/desbloquear.js
// Después de una demostración de fuerza bruta: levanta los bloqueos
// activos de cuentas e IPs (por si la IP de la propia computadora quedó
// bloqueada y ya no se puede entrar ni al panel). Habla directo con la base.
//
//   npm run desbloquear           levanta todos los bloqueos activos
//   npm run desbloquear -- --todo además borra intentos y eventos de la demo
const { Pool } = require('pg');
const { usaValoresPorDefecto, ...cfg } = require('../db.config.js');

(async () => {
    const pool = new Pool(cfg);
    try {
        const r = await pool.query(`UPDATE bloqueos SET levantado = CURRENT_TIMESTAMP WHERE levantado IS NULL AND hasta > CURRENT_TIMESTAMP RETURNING tipo, valor`);
        r.rows.forEach((b) => console.log(`Desbloqueado: ${b.tipo} ${b.valor}`));
        console.log(r.rowCount ? `${r.rowCount} bloqueo(s) levantados.` : 'No había bloqueos activos.');
        if (process.argv.includes('--todo')) {
            const i = await pool.query('DELETE FROM intentos_login');
            const e = await pool.query('DELETE FROM eventos_seguridad');
            console.log(`Bitácora limpia: ${i.rowCount} intentos y ${e.rowCount} eventos borrados.`);
        }
        console.log('Nota: el límite de intentos por minuto vive en memoria; si sigue apareciendo, espera un minuto o reinicia el servidor.');
    } catch (e) {
        console.error('No se pudo conectar a la base:', e.message);
        process.exitCode = 1;
    } finally { await pool.end(); }
})();
