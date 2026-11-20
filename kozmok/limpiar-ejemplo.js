// limpiar-ejemplo.js
// Quita de una base YA CREADA los datos de ejemplo que traía el script
// inicial (las instalaciones nuevas ya no los traen):
//   - los 4 clientes de prueba (@correo.com) con sus pedidos, puntos,
//     monederos, reseñas, tickets, garantías, direcciones y favoritos;
//   - los 2 empleados de ejemplo (Laura y Paola): se desactivan, no se
//     borran, porque su nombre queda en la bitácora;
//   - la promoción de ejemplo ya vencida.
// No toca productos, categorías, proveedores, impuestos ni nada que hayas
// creado tú. La bitácora de auditoría no se borra: queda un registro de
// esta limpieza.
//
//   npm run limpiar:ejemplo                 -> solo muestra qué borraría
//   npm run limpiar:ejemplo -- --confirmar  -> lo borra (no se puede deshacer)
const { Pool } = require('pg');
const { usaValoresPorDefecto, ...configPg } = require('./db.config.js');

const CORREOS_DEMO = ['mariana@correo.com', 'diego@correo.com', 'sofia@correo.com', 'carlos@correo.com'];
const EMPLEADOS_DEMO = ['laura.ventas@kozmok.mx', 'paola.logistica@kozmok.mx'];
const confirmar = process.argv.includes('--confirmar');

(async () => {
    const pool = new Pool(configPg);
    const db = await pool.connect();
    try {
        const cli = (await db.query(
            `SELECT c.id, c.nombre, c.correo,
                    (SELECT COUNT(*)::int FROM pedidos p WHERE p.cliente_id = c.id) AS pedidos
             FROM clientes c WHERE LOWER(c.correo) = ANY($1) ORDER BY c.id`, [CORREOS_DEMO])).rows;
        const emp = (await db.query(
            'SELECT id, nombre, email, activo FROM usuarios WHERE LOWER(email) = ANY($1) ORDER BY id', [EMPLEADOS_DEMO])).rows;
        const promo = (await db.query(
            "SELECT id, nombre FROM promociones WHERE nombre = 'Regreso a clases' AND descripcion ILIKE '%ejemplo%'")).rows;

        console.log('\nDatos de ejemplo encontrados:\n');
        if (!cli.length && !emp.length && !promo.length) { console.log('  Ninguno. La base ya está limpia.\n'); return; }
        cli.forEach((c) => console.log(`  Cliente   ${c.nombre} <${c.correo}> · ${c.pedidos} pedido(s)  -> se borra`));
        emp.forEach((u) => console.log(`  Empleado  ${u.nombre} <${u.email}>${u.activo ? '' : ' (ya inactivo)'}  -> se desactiva`));
        promo.forEach((p) => console.log(`  Promoción ${p.nombre} (ejemplo vencida)  -> se borra`));

        if (!confirmar) {
            console.log('\nNo se borró nada. Para hacerlo de verdad (no se puede deshacer):');
            console.log('  npm run limpiar:ejemplo -- --confirmar\n');
            return;
        }

        const ids = cli.map((c) => c.id);
        await db.query('BEGIN');
        // Los movimientos de puntos, monedero, pedidos, etc. son "solo agregar":
        // la purga es la única excepción y vive solo dentro de esta transacción.
        await db.query("SET LOCAL kozmok.purga = 'si'");
        const ped = await db.query('DELETE FROM pedidos WHERE cliente_id = ANY($1) RETURNING id', [ids]);
        await db.query('UPDATE chatbot_consultas SET cliente_id = NULL WHERE cliente_id = ANY($1)', [ids]);
        const borrados = await db.query('DELETE FROM clientes WHERE id = ANY($1) RETURNING id', [ids]);
        await db.query("UPDATE usuarios SET activo = FALSE WHERE LOWER(email) = ANY($1)", [EMPLEADOS_DEMO]);
        await db.query('DELETE FROM sesiones WHERE usuario_id = ANY($1)', [emp.map((u) => u.id)]);
        for (const p of promo) {
            await db.query('DELETE FROM promociones WHERE id = $1', [p.id]).catch(() =>
                db.query("UPDATE promociones SET estado = 'inactiva' WHERE id = $1", [p.id]));
        }
        await db.query(
            `INSERT INTO auditoria (usuario_nombre, rol, accion, entidad, antes, despues, motivo)
             VALUES ('Script limpiar-ejemplo', 'sistema', 'limpieza_datos_ejemplo', 'base', $1, $2, $3)`,
            [JSON.stringify({ clientes: cli, empleados: emp, promociones: promo }),
                JSON.stringify({ clientes_borrados: borrados.rowCount, pedidos_borrados: ped.rowCount, empleados_desactivados: emp.length }),
                'Se quitaron los datos de ejemplo del script inicial']);
        await db.query('COMMIT');
        console.log(`\nListo: ${borrados.rowCount} cliente(s) y ${ped.rowCount} pedido(s) de ejemplo borrados, ${emp.length} empleado(s) desactivado(s).`);
        console.log('Las existencias de productos no se tocaron.\n');
    } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('\nNo se pudo limpiar (no se borró nada):', e.message, '\n');
        process.exitCode = 1;
    } finally {
        db.release();
        await pool.end();
    }
})();
