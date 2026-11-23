// cupones.js
// Cupones de descuento de cada cliente (se guardan en su cuenta, en
// "Mis cupones"). El primero es el de BIENVENIDA: se da una sola vez, cuando
// la cuenta ya tiene el correo confirmado, y llega por correo. Soporte puede
// dar otro cupón, extender su vigencia, reactivarlo o cancelarlo desde el
// ticket del cliente (queda en la bitácora con su motivo).
//
// El cupón se aplica en el checkout sobre el total con impuestos (igual que
// los puntos del Club), se marca como usado dentro de la misma transacción
// del pedido y, si el pedido se cancela, vuelve a quedar disponible.

const num = (v, def) => (v === undefined || v === '' || isNaN(Number(v)) ? def : Number(v));
const CFG = {
    // Cupón de bienvenida (CUPON_BIENVENIDA_VALOR=0 lo apaga)
    tipo: process.env.CUPON_BIENVENIDA_TIPO === 'monto' ? 'monto' : 'porcentaje',
    valor: num(process.env.CUPON_BIENVENIDA_VALOR, 10),          // 10 %  (o $ si tipo=monto)
    tope: num(process.env.CUPON_BIENVENIDA_TOPE, 1500),          // descuento máximo en pesos (porcentaje)
    minimo: num(process.env.CUPON_BIENVENIDA_MINIMO, 1000),      // compra mínima (productos con promociones, sin IVA)
    dias: num(process.env.CUPON_BIENVENIDA_DIAS, 30),            // vigencia
    // Lo más que puede dar Soporte sin ser administrador
    soportePorcentajeMax: num(process.env.CUPON_SOPORTE_PORCENTAJE_MAX, 30),
    soporteMontoMax: num(process.env.CUPON_SOPORTE_MONTO_MAX, 1000),
};
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });

// Texto corto del beneficio: "10% de descuento (hasta $1,500)" / "$300 de descuento"
function beneficio(c) {
    return c.tipo === 'porcentaje'
        ? `${Number(c.valor)}% de descuento${Number(c.tope) > 0 ? ` (hasta ${pesos(c.tope)})` : ''}`
        : `${pesos(c.valor)} de descuento`;
}
// Estado que ve la persona (un cupón disponible con fecha pasada ya venció).
function estadoReal(c) {
    if (c.estado === 'disponible' && c.vence && new Date(c.vence) < new Date()) return 'vencido';
    return c.estado;
}
// Cuánto descuenta un cupón sobre una compra.
//   base  = productos + garantías con promociones (sin IVA): para el mínimo
//   bruto = lo que se cobraría con impuestos, antes de envío y puntos
function calcular(c, { base, bruto }) {
    if (!c) return { monto: 0 };
    if (Number(base) < Number(c.minimo || 0)) return { monto: 0, error: `Este cupón es para compras desde ${pesos(c.minimo)} (sin IVA ni envío).` };
    let monto = c.tipo === 'porcentaje' ? Number(bruto) * Number(c.valor) / 100 : Number(c.valor);
    if (c.tipo === 'porcentaje' && Number(c.tope) > 0) monto = Math.min(monto, Number(c.tope));
    return { monto: r2(Math.max(0, Math.min(monto, Number(bruto)))) };
}

module.exports = function crearCupones({ pool, enviarCorreo, urlBase }) {
    async function migrar() {
        await pool.query(`CREATE TABLE IF NOT EXISTS cupones (
            id SERIAL PRIMARY KEY,
            codigo VARCHAR(20) UNIQUE NOT NULL,
            cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
            origen VARCHAR(20) NOT NULL DEFAULT 'bienvenida',
            descripcion VARCHAR(160),
            tipo VARCHAR(12) NOT NULL CHECK (tipo IN ('porcentaje','monto')),
            valor NUMERIC(10,2) NOT NULL CHECK (valor > 0),
            tope NUMERIC(10,2) NOT NULL DEFAULT 0,
            minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
            vence TIMESTAMP,
            estado VARCHAR(12) NOT NULL DEFAULT 'disponible' CHECK (estado IN ('disponible','usado','cancelado')),
            pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
            fecha_uso TIMESTAMP,
            usuario_id INTEGER REFERENCES usuarios(id),
            motivo VARCHAR(300),
            fecha TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_cupones_cliente ON cupones(cliente_id)');
        // Un solo cupón de bienvenida por cliente
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_cupon_bienvenida ON cupones(cliente_id) WHERE origen = 'bienvenida'`);
        await pool.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cupon_id INTEGER REFERENCES cupones(id) ON DELETE SET NULL');
        await pool.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS descuento_cupon NUMERIC(10,2) NOT NULL DEFAULT 0');
        await pool.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cupon_id INTEGER REFERENCES cupones(id) ON DELETE SET NULL');
        // Desde dónde se da el cupón de bienvenida (no se les da a las cuentas
        // que ya existían cuando llegó esta función).
        await pool.query(`CREATE TABLE IF NOT EXISTS notif_cursor (fuente VARCHAR(30) PRIMARY KEY, ultimo_id BIGINT NOT NULL DEFAULT 0)`);
        await pool.query(`INSERT INTO notif_cursor (fuente, ultimo_id) SELECT 'cupon_bienvenida', COALESCE(MAX(id), 0) FROM clientes ON CONFLICT DO NOTHING`);
    }

    async function codigoNuevo(db, prefijo = 'KZ') {
        const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        for (let i = 0; i < 10; i++) {
            let c = '';
            for (let j = 0; j < 8; j++) c += letras[require('crypto').randomInt(letras.length)];
            const codigo = `${prefijo}-${c}`;
            const ya = await db.query('SELECT 1 FROM cupones WHERE codigo = $1', [codigo]);
            if (!ya.rows.length) return codigo;
        }
        throw new Error('No se pudo generar el código del cupón');
    }

    // Da el cupón de bienvenida (una sola vez) y manda el correo. Devuelve el
    // cupón o null si no aplica (apagado, ya lo tenía, cuenta sin confirmar).
    async function darBienvenida(db, clienteId, { base } = {}) {
        if (!(CFG.valor > 0)) return null;
        const c = (await db.query('SELECT id, nombre, correo, correo_verificado FROM clientes WHERE id = $1', [clienteId])).rows[0];
        if (!c || c.correo_verificado === false) return null;
        const codigo = await codigoNuevo(db, 'BIENVENIDA');
        const ins = await db.query(
            `INSERT INTO cupones (codigo, cliente_id, origen, descripcion, tipo, valor, tope, minimo, vence)
             VALUES ($1,$2,'bienvenida','Regalo de bienvenida',$3,$4,$5,$6, CURRENT_TIMESTAMP + make_interval(days => $7::int))
             ON CONFLICT DO NOTHING RETURNING *`,
            [codigo, clienteId, CFG.tipo, CFG.valor, CFG.tipo === 'porcentaje' ? CFG.tope : 0, CFG.minimo, Math.max(1, CFG.dias)]);
        const cup = ins.rows[0];
        if (!cup) return null;
        const url = `${base || urlBase()}`;
        const vence = new Date(cup.vence).toLocaleDateString('es-MX', { dateStyle: 'long', timeZone: 'America/Mexico_City' });
        await enviarCorreo(db, {
            para: c.correo, tipo: 'cupon', cliente_id: clienteId,
            asunto: `¡Bienvenido a Kozmok, ${c.nombre.split(' ')[0]}! Aquí está tu regalo`,
            cuerpo: `Hola ${c.nombre.split(' ')[0]}:\n\n¡Gracias por unirte a Kozmok! Para tu primera compra te regalamos un cupón:\n\n`
                + `- ${beneficio(cup)}\n- Código: ${cup.codigo}\n`
                + `${Number(cup.minimo) > 0 ? `- En compras desde ${pesos(cup.minimo)} (sin IVA ni envío)\n` : ''}`
                + `- Válido hasta el ${vence}\n\n`
                + `Ya está guardado en tu cuenta, en Mi cuenta > Mis cupones, y lo eliges al pagar. Se usa una vez.\n\n`
                + `Si tienes algún problema con tu cupón, escríbenos desde Soporte y lo revisamos.`,
            boton: { texto: 'Ver mis cupones', url: `${url}/cupones.html` },
        }).catch((e) => console.error('Correo del cupón de bienvenida:', e.message));
        return cup;
    }

    // Revisión periódica: da el cupón de bienvenida a las cuentas nuevas que
    // ya confirmaron su correo y no lo tienen (cubre todos los caminos:
    // código del correo, restablecer contraseña, alta desde el panel…).
    async function revisarBienvenidas() {
        if (!(CFG.valor > 0)) return 0;
        const desde = Number((await pool.query(`SELECT ultimo_id FROM notif_cursor WHERE fuente = 'cupon_bienvenida'`)).rows[0]?.ultimo_id || 0);
        const r = await pool.query(
            `SELECT c.id FROM clientes c WHERE c.id > $1 AND c.correo_verificado IS NOT FALSE AND c.correo IS NOT NULL AND c.estado_cliente = 'activo'
               AND NOT EXISTS (SELECT 1 FROM cupones x WHERE x.cliente_id = c.id AND x.origen = 'bienvenida') ORDER BY c.id LIMIT 50`, [desde]);
        let n = 0;
        for (const { id } of r.rows) if (await darBienvenida(pool, id).catch(() => null)) n++;
        return n;
    }

    // Cupón de un cliente listo para usarse (o un error que se le puede mostrar).
    async function paraUsar(db, clienteId, codigo, { bloquear = false } = {}) {
        const cod = String(codigo || '').trim().toUpperCase().slice(0, 20);
        if (!cod) return { cupon: null };
        const c = (await db.query(`SELECT * FROM cupones WHERE codigo = $1 AND cliente_id = $2 ${bloquear ? 'FOR UPDATE' : ''}`, [cod, clienteId])).rows[0];
        if (!c) return { error: 'Ese cupón no existe en tu cuenta. Revisa el código en Mis cupones.' };
        const est = estadoReal(c);
        if (est === 'usado') return { error: 'Este cupón ya se usó. Si crees que es un error, escríbenos desde Soporte.' };
        if (est === 'vencido') return { error: 'Este cupón ya venció. Si tuviste algún problema para usarlo, escríbenos desde Soporte.' };
        if (est === 'cancelado') return { error: 'Este cupón ya no está activo. Escríbenos desde Soporte si tienes dudas.' };
        return { cupon: c };
    }

    // Al crear el pedido: se marca como usado. Al cancelarlo: vuelve.
    async function marcarUsado(db, cuponId, pedidoId) {
        await db.query(`UPDATE cupones SET estado = 'usado', pedido_id = $2, fecha_uso = CURRENT_TIMESTAMP WHERE id = $1`, [cuponId, pedidoId]);
    }
    async function liberarDePedido(db, pedidoId) {
        await db.query(`UPDATE cupones SET estado = 'disponible', pedido_id = NULL, fecha_uso = NULL WHERE pedido_id = $1 AND estado = 'usado'`, [pedidoId]);
    }

    const SELECT = `SELECT cu.*, p.numero_orden, u.nombre AS usuario_nombre FROM cupones cu
                    LEFT JOIN pedidos p ON p.id = cu.pedido_id LEFT JOIN usuarios u ON u.id = cu.usuario_id`;
    const publico = (c) => ({
        id: c.id, codigo: c.codigo, origen: c.origen, descripcion: c.descripcion, tipo: c.tipo, valor: Number(c.valor),
        tope: Number(c.tope), minimo: Number(c.minimo), vence: c.vence, estado: estadoReal(c), beneficio: beneficio(c),
        numero_orden: c.numero_orden || null, fecha_uso: c.fecha_uso, fecha: c.fecha,
    });

    function rutas(app, { asyncRoute, requireCliente, mismoCliente, puedeVer }) {
        // ---- Cliente: Mis cupones ----
        app.get('/api/clientes/:id/cupones', requireCliente, mismoCliente, asyncRoute(async (req, res) => {
            const r = await pool.query(`${SELECT} WHERE cu.cliente_id = $1 ORDER BY (cu.estado = 'disponible') DESC, cu.fecha DESC`, [req.params.id]);
            res.json(r.rows.map(publico));
        }));

        // ---- Panel (Soporte / Administrador) ----
        app.get('/api/admin/clientes/:id/cupones', asyncRoute(async (req, res) => {
            const r = await pool.query(`${SELECT} WHERE cu.cliente_id = $1 ORDER BY cu.fecha DESC`, [req.params.id]);
            res.json(r.rows.map((c) => ({ ...publico(c), motivo: c.motivo, usuario_nombre: c.usuario_nombre })));
        }));
        // Dar un cupón a un cliente (compensación, error con otro cupón…)
        app.post('/api/admin/clientes/:id/cupones', asyncRoute(async (req, res) => {
            const b = req.body || {};
            const tipo = b.tipo === 'monto' ? 'monto' : 'porcentaje';
            const valor = r2(b.valor);
            const motivo = String(b.motivo || '').trim().slice(0, 300);
            const dias = Math.min(365, Math.max(1, Math.floor(Number(b.dias) || 30)));
            const minimo = Math.max(0, r2(b.minimo || 0));
            const tope = tipo === 'porcentaje' ? Math.max(0, r2(b.tope || 0)) : 0;
            if (!(valor > 0)) return res.status(400).json({ message: 'Escribe el valor del descuento' });
            if (tipo === 'porcentaje' && valor > 90) return res.status(400).json({ message: 'El porcentaje no puede pasar de 90%' });
            if (motivo.length < 5) return res.status(400).json({ message: 'Escribe el motivo (queda en la bitácora)' });
            const esAdmin = req.usuario.rol === 'admin';
            if (!esAdmin && tipo === 'porcentaje' && (valor > CFG.soportePorcentajeMax || !(tope > 0) || tope > CFG.soporteMontoMax)) {
                return res.status(403).json({ message: `Soporte puede dar hasta ${CFG.soportePorcentajeMax}% con un tope de ${pesos(CFG.soporteMontoMax)}. Para más, pídeselo a un administrador.` });
            }
            if (!esAdmin && tipo === 'monto' && valor > CFG.soporteMontoMax) {
                return res.status(403).json({ message: `Soporte puede dar cupones de hasta ${pesos(CFG.soporteMontoMax)}. Para más, pídeselo a un administrador.` });
            }
            const c = (await pool.query('SELECT id, nombre, correo FROM clientes WHERE id = $1', [req.params.id])).rows[0];
            if (!c) return res.status(404).json({ message: 'Cliente no encontrado' });
            const codigo = await codigoNuevo(pool, 'KZ');
            const cup = (await pool.query(
                `INSERT INTO cupones (codigo, cliente_id, origen, descripcion, tipo, valor, tope, minimo, vence, usuario_id, motivo)
                 VALUES ($1,$2,'soporte',$3,$4,$5,$6,$7, CURRENT_TIMESTAMP + make_interval(days => $8::int), $9, $10) RETURNING *`,
                [codigo, c.id, String(b.descripcion || 'Cupón de Soporte').slice(0, 160), tipo, valor, tope, minimo, dias, req.usuario.id, motivo])).rows[0];
            if (c.correo) {
                await enviarCorreo(pool, {
                    para: c.correo, tipo: 'cupon', cliente_id: c.id,
                    asunto: 'Te enviamos un cupón de descuento',
                    cuerpo: `Hola ${c.nombre.split(' ')[0]}:\n\nTe enviamos un cupón a tu cuenta de Kozmok:\n\n- ${beneficio(cup)}\n- Código: ${cup.codigo}\n`
                        + `${Number(cup.minimo) > 0 ? `- En compras desde ${pesos(cup.minimo)} (sin IVA ni envío)\n` : ''}`
                        + `- Válido hasta el ${new Date(cup.vence).toLocaleDateString('es-MX', { dateStyle: 'long', timeZone: 'America/Mexico_City' })}\n\n`
                        + 'Lo encuentras en Mi cuenta > Mis cupones y lo eliges al pagar.',
                    boton: { texto: 'Ver mis cupones', url: `${urlBase()}/cupones.html` },
                }).catch(() => {});
            }
            res.status(201).json({ message: `Cupón ${cup.codigo} enviado a ${c.nombre}`, cupon: publico(cup) });
        }));
        // Extender vigencia, reactivar (si se usó en un pedido cancelado o
        // hubo un error) o cancelar. Todo pide motivo.
        app.put('/api/admin/cupones/:id', asyncRoute(async (req, res) => {
            const b = req.body || {};
            const motivo = String(b.motivo || '').trim().slice(0, 300);
            if (motivo.length < 5) return res.status(400).json({ message: 'Escribe el motivo (queda en la bitácora)' });
            const c = (await pool.query('SELECT * FROM cupones WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
            if (!c) return res.status(404).json({ message: 'Cupón no encontrado' });
            const nota = `${c.motivo ? c.motivo + ' | ' : ''}${new Date().toLocaleDateString('es-MX')} ${req.usuario.nombre}: ${motivo}`.slice(-300);
            if (b.accion === 'extender') {
                const dias = Math.min(90, Math.max(1, Math.floor(Number(b.dias) || 15)));
                if (c.estado === 'usado') return res.status(400).json({ message: 'El cupón ya se usó; para ayudar al cliente reactívalo o dale uno nuevo.' });
                await pool.query(`UPDATE cupones SET vence = GREATEST(COALESCE(vence, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP) + make_interval(days => $2::int),
                                  estado = CASE WHEN estado = 'cancelado' THEN estado ELSE 'disponible' END, motivo = $3 WHERE id = $1`, [c.id, dias, nota]);
                return res.json({ message: `Vigencia extendida ${dias} días` });
            }
            if (b.accion === 'reactivar') {
                if (c.estado === 'usado' && c.pedido_id) {
                    const p = (await pool.query('SELECT estado, numero_orden FROM pedidos WHERE id = $1', [c.pedido_id])).rows[0];
                    if (p && p.estado !== 'cancelado') return res.status(400).json({ message: `El cupón se usó en ${p.numero_orden}, que sigue activo. Si el cliente necesita otro descuento, dale un cupón nuevo.` });
                }
                await pool.query(`UPDATE cupones SET estado = 'disponible', pedido_id = NULL, fecha_uso = NULL,
                                  vence = GREATEST(COALESCE(vence, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP + INTERVAL '7 days'), motivo = $2 WHERE id = $1`, [c.id, nota]);
                return res.json({ message: 'Cupón disponible otra vez (con al menos 7 días de vigencia)' });
            }
            if (b.accion === 'cancelar') {
                if (c.estado === 'usado') return res.status(400).json({ message: 'El cupón ya se usó; no se puede cancelar.' });
                await pool.query(`UPDATE cupones SET estado = 'cancelado', motivo = $2 WHERE id = $1`, [c.id, nota]);
                return res.json({ message: 'Cupón cancelado' });
            }
            res.status(400).json({ message: 'Acción no válida' });
        }));
    }

    return { CFG, migrar, darBienvenida, revisarBienvenidas, paraUsar, calcular, marcarUsado, liberarDePedido, beneficio, rutas };
};
module.exports.calcular = calcular;
module.exports.beneficio = beneficio;
