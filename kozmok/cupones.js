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

module.exports = function crearCupones({ pool, enviarCorreo, urlBase, niveles = [] }) {
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
        // Envíos a varios clientes a la vez (todos, por criterios o una lista)
        await pool.query(`CREATE TABLE IF NOT EXISTS cupon_lotes (
            id SERIAL PRIMARY KEY,
            nombre VARCHAR(160) NOT NULL,
            modo VARCHAR(12) NOT NULL,
            criterios JSONB,
            resumen VARCHAR(400),
            total INTEGER NOT NULL DEFAULT 0,
            usuario_id INTEGER REFERENCES usuarios(id),
            motivo VARCHAR(300),
            fecha TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query('ALTER TABLE cupones ADD COLUMN IF NOT EXISTS lote_id INTEGER REFERENCES cupon_lotes(id) ON DELETE SET NULL');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_cupones_lote ON cupones(lote_id)');
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

    // Datos de un cupón que da el equipo (uno o muchos). Ventas y Soporte
    // tienen tope; el administrador no.
    function leerDatos(b, usuario) {
        const tipo = b.tipo === 'monto' ? 'monto' : 'porcentaje';
        const valor = r2(b.valor);
        const motivo = String(b.motivo || '').trim().slice(0, 300);
        const dias = Math.min(365, Math.max(1, Math.floor(Number(b.dias) || 30)));
        const minimo = Math.max(0, r2(b.minimo || 0));
        const tope = tipo === 'porcentaje' ? Math.max(0, r2(b.tope || 0)) : 0;
        const descripcion = String(b.descripcion || '').trim().slice(0, 160);
        if (!(valor > 0)) return { status: 400, message: 'Escribe el valor del descuento' };
        if (tipo === 'porcentaje' && valor > 90) return { status: 400, message: 'El porcentaje no puede pasar de 90%' };
        if (tipo === 'monto' && valor > 50000) return { status: 400, message: 'Un cupón de monto fijo no puede pasar de $50,000' };
        if (tope > 50000) return { status: 400, message: 'El descuento máximo no puede pasar de $50,000' };
        if (minimo > 5000000) return { status: 400, message: 'La compra mínima no puede pasar de $5,000,000' };
        if (motivo.length < 5) return { status: 400, message: 'Escribe el motivo (queda en la bitácora)' };
        if (usuario.rol !== 'admin') {
            if (tipo === 'porcentaje' && (valor > CFG.soportePorcentajeMax || !(tope > 0) || tope > CFG.soporteMontoMax)) {
                return { status: 403, message: `Tu rol puede dar hasta ${CFG.soportePorcentajeMax}% con un tope de ${pesos(CFG.soporteMontoMax)}. Para más, pídeselo a un administrador.` };
            }
            if (tipo === 'monto' && valor > CFG.soporteMontoMax) {
                return { status: 403, message: `Tu rol puede dar cupones de hasta ${pesos(CFG.soporteMontoMax)}. Para más, pídeselo a un administrador.` };
            }
        }
        return { datos: { tipo, valor, motivo, dias, minimo, tope, descripcion } };
    }
    function correoCupon(c, cup) {
        if (!c.correo) return Promise.resolve();
        return enviarCorreo(pool, {
            para: c.correo, tipo: 'cupon', cliente_id: c.id,
            asunto: 'Te enviamos un cupón de descuento',
            cuerpo: `Hola ${String(c.nombre || '').split(' ')[0]}:\n\nTe enviamos un cupón a tu cuenta de Kozmok:\n\n`
                + `${cup.descripcion ? `${cup.descripcion}\n` : ''}- ${beneficio(cup)}\n- Código: ${cup.codigo}\n`
                + `${Number(cup.minimo) > 0 ? `- En compras desde ${pesos(cup.minimo)} (sin IVA ni envío)\n` : ''}`
                + `- Válido hasta el ${new Date(cup.vence).toLocaleDateString('es-MX', { dateStyle: 'long', timeZone: 'America/Mexico_City' })}\n\n`
                + 'Lo encuentras en Mi cuenta > Mis cupones y lo eliges al pagar.',
            boton: { texto: 'Ver mis cupones', url: `${urlBase()}/cupones.html` },
        }).catch(() => {});
    }

    // ---- A quién le llega un envío ----
    // modo 'todos' | 'criterios' | 'clientes' (lista de ids). Solo clientes
    // activos y, si se pide, con el correo confirmado.
    const MAX_MASIVO = Math.max(1, Number(process.env.CUPON_MASIVO_MAX) || 2000);
    const ETAPAS = ['prospecto', 'activo', 'frecuente', 'inactivo'];
    const COBRADOS = `('confirmado','procesando','enviado','entregado')`;
    // Nivel del Club en SQL, con la misma regla que el servidor (gasto o compras).
    // (NIVELES se define después en server.js: se lee al usarse.)
    const listaNiveles = () => (typeof niveles === 'function' ? niveles() : niveles) || [];
    const nivelSQL = () => { const nv = listaNiveles(); return nv.length ? `CASE ${[...nv].reverse().map((n) =>
        `WHEN COALESCE(m.valor_total_compras,0) >= ${Number(n.minGasto)} OR COALESCE(m.total_compras,0) >= ${Number(n.minCompras)} THEN '${n.clave}'`).join(' ')} ELSE '${nv[0].clave}' END` : `'bronce'`; };
    function audiencia(b) {
        const modo = ['todos', 'criterios', 'clientes'].includes(b.modo) ? b.modo : null;
        if (!modo) return { error: 'Elige a quién darle el cupón' };
        const k = b.criterios || {};
        const cond = [`c.estado_cliente = 'activo'`], vals = [], txt = [];
        const v = (x) => { vals.push(x); return `$${vals.length}`; };
        if (modo === 'clientes') {
            const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => n > 0))].slice(0, MAX_MASIVO);
            if (!ids.length) return { error: 'Agrega al menos un cliente a la lista' };
            cond.push(`c.id = ANY(${v(ids)}::int[])`);
            txt.push(`${ids.length} cliente(s) elegidos`);
        } else {
            if (k.solo_confirmados !== false) { cond.push('c.correo_verificado'); txt.push('correo confirmado'); }
            if (modo === 'criterios') {
                const nivs = (Array.isArray(k.niveles) ? k.niveles : []).filter((n) => listaNiveles().some((x) => x.clave === n));
                if (nivs.length) { cond.push(`(${nivelSQL()}) = ANY(${v(nivs)}::text[])`); txt.push('nivel ' + nivs.join('/')); }
                const ets = (Array.isArray(k.etapas) ? k.etapas : []).map((e) => String(e).toLowerCase()).filter((e) => ETAPAS.includes(e));
                if (ets.length) { cond.push(`LOWER(c.etapa_crm) = ANY(${v(ets)}::text[])`); txt.push('etapa ' + ets.join('/')); }
                if (k.compras === 'ninguna') { cond.push('COALESCE(m.total_compras,0) = 0'); txt.push('sin compras'); }
                else if (Number(k.compras_min) > 0) { cond.push(`COALESCE(m.total_compras,0) >= ${v(Math.floor(Number(k.compras_min)))}`); txt.push(`${Math.floor(Number(k.compras_min))}+ compras`); }
                if (Number(k.gasto_min) > 0) { cond.push(`COALESCE(m.valor_total_compras,0) >= ${v(r2(k.gasto_min))}`); txt.push(`gasto desde ${pesos(k.gasto_min)}`); }
                if (Number(k.sin_comprar_dias) > 0) {
                    const d = Math.min(3650, Math.floor(Number(k.sin_comprar_dias)));
                    cond.push(`EXISTS (SELECT 1 FROM pedidos px WHERE px.cliente_id = c.id AND px.estado IN ${COBRADOS})
                        AND NOT EXISTS (SELECT 1 FROM pedidos px WHERE px.cliente_id = c.id AND px.estado IN ${COBRADOS}
                                        AND px.fecha_pedido >= CURRENT_TIMESTAMP - make_interval(days => ${v(d)}::int))`);
                    txt.push(`ya compró pero no en ${d} días`);
                }
                if (Number(k.registrados_dias) > 0) {
                    const d = Math.min(3650, Math.floor(Number(k.registrados_dias)));
                    cond.push(`c.fecha_registro >= CURRENT_TIMESTAMP - make_interval(days => ${v(d)}::int)`); txt.push(`registrados en los últimos ${d} días`);
                }
                if (k.cumple_mes) {
                    cond.push(`EXTRACT(MONTH FROM c.fecha_nacimiento) = EXTRACT(MONTH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City'))`);
                    txt.push('cumplen años este mes');
                }
            }
        }
        if (k.sin_cupon_disponible) {
            cond.push(`NOT EXISTS (SELECT 1 FROM cupones x WHERE x.cliente_id = c.id AND x.origen <> 'bienvenida' AND x.estado = 'disponible'
                        AND (x.vence IS NULL OR x.vence >= CURRENT_TIMESTAMP))`);
            txt.push('sin otro cupón disponible');
        }
        const desde = `FROM clientes c LEFT JOIN metricas_clientes m ON m.cliente_id = c.id WHERE ${cond.join(' AND ')}`;
        return { modo, desde, vals, resumen: (modo === 'todos' ? 'Todos los clientes' : modo === 'criterios' ? 'Por criterios' : 'Lista de clientes') + (txt.length ? ': ' + txt.join(', ') : '') };
    }
    async function contarAudiencia(a) {
        const t = (await pool.query(`SELECT COUNT(*)::int AS n ${a.desde}`, a.vals)).rows[0].n;
        const muestra = (await pool.query(`SELECT c.id, c.nombre, c.correo, ${nivelSQL()} AS nivel, COALESCE(m.total_compras,0)::int AS compras
            ${a.desde} ORDER BY c.nombre LIMIT 12`, a.vals)).rows;
        return { total: t, muestra };
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

        // ---- Panel: pantalla Cupones (Tienda) ----
        // Todos los cupones con filtros, indicadores y la configuración vigente.
        app.get('/api/admin/cupones', asyncRoute(async (req, res) => {
            const q = String(req.query.q || '').trim().slice(0, 80);
            const est = String(req.query.estado || '');
            const origen = String(req.query.origen || '');
            const cond = [], vals = [];
            if (q) { vals.push(`%${q}%`); cond.push(`(cu.codigo ILIKE $${vals.length} OR c.nombre ILIKE $${vals.length} OR c.correo ILIKE $${vals.length})`); }
            if (['bienvenida', 'soporte', 'campana'].includes(origen)) { vals.push(origen); cond.push(`cu.origen = $${vals.length}`); }
            if (Number(req.query.lote) > 0) { vals.push(Number(req.query.lote)); cond.push(`cu.lote_id = $${vals.length}`); }
            if (est === 'disponible') cond.push(`cu.estado = 'disponible' AND (cu.vence IS NULL OR cu.vence >= CURRENT_TIMESTAMP)`);
            else if (est === 'vencido') cond.push(`cu.estado = 'disponible' AND cu.vence < CURRENT_TIMESTAMP`);
            else if (est === 'por_vencer') cond.push(`cu.estado = 'disponible' AND cu.vence BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '7 days'`);
            else if (est === 'usado' || est === 'cancelado') { vals.push(est); cond.push(`cu.estado = $${vals.length}`); }
            const r = await pool.query(
                `SELECT cu.*, p.numero_orden, p.descuento_cupon, u.nombre AS usuario_nombre, c.nombre AS cliente_nombre, c.correo AS cliente_correo
                   FROM cupones cu JOIN clientes c ON c.id = cu.cliente_id
                   LEFT JOIN pedidos p ON p.id = cu.pedido_id LEFT JOIN usuarios u ON u.id = cu.usuario_id
                  ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY cu.fecha DESC LIMIT 300`, vals);
            const k = (await pool.query(`SELECT
                    COUNT(*) FILTER (WHERE estado = 'disponible' AND (vence IS NULL OR vence >= CURRENT_TIMESTAMP))::int AS disponibles,
                    COUNT(*) FILTER (WHERE estado = 'disponible' AND vence BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '7 days')::int AS por_vencer,
                    COUNT(*) FILTER (WHERE estado = 'usado')::int AS usados,
                    COUNT(*) FILTER (WHERE origen = 'bienvenida')::int AS bienvenida,
                    COUNT(*) FILTER (WHERE origen = 'bienvenida' AND estado = 'usado')::int AS bienvenida_usados,
                    COUNT(*) FILTER (WHERE fecha >= date_trunc('month', CURRENT_TIMESTAMP))::int AS dados_mes
                  FROM cupones`)).rows[0];
            const d = (await pool.query(`SELECT COALESCE(SUM(p.descuento_cupon), 0) AS total,
                    COALESCE(SUM(p.descuento_cupon) FILTER (WHERE p.fecha_pedido >= date_trunc('month', CURRENT_TIMESTAMP)), 0) AS mes,
                    COALESCE(SUM(p.total), 0) AS ventas
                  FROM pedidos p WHERE p.cupon_id IS NOT NULL AND p.estado <> 'cancelado'`)).rows[0];
            const lotes = (await pool.query(`SELECT l.id, l.nombre, l.resumen, l.total, l.fecha, u.nombre AS usuario_nombre,
                    COUNT(cu.id) FILTER (WHERE cu.estado = 'usado')::int AS usados,
                    COUNT(cu.id) FILTER (WHERE cu.estado = 'disponible' AND (cu.vence IS NULL OR cu.vence >= CURRENT_TIMESTAMP))::int AS disponibles,
                    COALESCE(SUM(p.descuento_cupon) FILTER (WHERE p.estado <> 'cancelado'), 0) AS descuento
                  FROM cupon_lotes l LEFT JOIN cupones cu ON cu.lote_id = l.id LEFT JOIN pedidos p ON p.id = cu.pedido_id
                  LEFT JOIN usuarios u ON u.id = l.usuario_id GROUP BY l.id, u.nombre ORDER BY l.fecha DESC LIMIT 8`)).rows
                .map((x) => ({ ...x, descuento: Number(x.descuento) }));
            res.json({
                lotes, puede_masivo: puedeVer(req.usuario.rol, 'cupones-masivo'),
                resumen: { ...k, descuento_total: Number(d.total), descuento_mes: Number(d.mes), ventas_con_cupon: Number(d.ventas) },
                config: { bienvenida: CFG.valor > 0 ? { beneficio: beneficio(CFG), minimo: CFG.minimo, dias: CFG.dias } : null,
                    limite_rol: req.usuario.rol === 'admin' ? null : { porcentaje: CFG.soportePorcentajeMax, monto: CFG.soporteMontoMax } },
                cupones: r.rows.map((c) => ({ ...publico(c), cliente_id: c.cliente_id, cliente_nombre: c.cliente_nombre, cliente_correo: c.cliente_correo,
                    motivo: c.motivo, usuario_nombre: c.usuario_nombre, lote_id: c.lote_id, descuento_aplicado: c.descuento_cupon != null ? Number(c.descuento_cupon) : null })),
            });
        }));
        // Buscar a quién darle un cupón (sin necesitar la sección Clientes).
        app.get('/api/admin/cupones/clientes', asyncRoute(async (req, res) => {
            const q = String(req.query.q || '').trim().slice(0, 80);
            if (q.length < 2) return res.json([]);
            const r = await pool.query(`SELECT id, nombre, correo FROM clientes WHERE estado_cliente = 'activo'
                AND (nombre ILIKE $1 OR correo ILIKE $1) ORDER BY nombre LIMIT 8`, [`%${q}%`]);
            res.json(r.rows);
        }));

        // ---- Envío a varios clientes (permiso 'cupones-masivo') ----
        const puedeMasivo = (req, res) => {
            if (puedeVer(req.usuario.rol, 'cupones-masivo')) return true;
            res.status(403).json({ message: 'Tu rol puede dar cupones de uno en uno. Para enviarlos a varios clientes, pídeselo a un administrador o a Ventas.' });
            return false;
        };
        // Cuántos clientes recibirían el cupón (y algunos de ejemplo).
        app.post('/api/admin/cupones/audiencia', asyncRoute(async (req, res) => {
            if (!puedeMasivo(req, res)) return;
            const a = audiencia(req.body || {});
            if (a.error) return res.status(400).json({ message: a.error });
            res.json({ ...(await contarAudiencia(a)), resumen: a.resumen, maximo: MAX_MASIVO });
        }));
        app.post('/api/admin/cupones/masivo', asyncRoute(async (req, res) => {
            if (!puedeMasivo(req, res)) return;
            const b = req.body || {};
            const l = leerDatos(b, req.usuario);
            if (l.message) return res.status(l.status).json({ message: l.message });
            const d = l.datos;
            const a = audiencia(b);
            if (a.error) return res.status(400).json({ message: a.error });
            const nombre = String(b.nombre || '').trim().slice(0, 160);
            if (nombre.length < 3) return res.status(400).json({ message: 'Ponle un nombre al envío (lo ve el cliente en su cupón)' });
            const client = await pool.connect();
            let lote, destinatarios;
            try {
                await client.query('BEGIN');
                destinatarios = (await client.query(`SELECT c.id, c.nombre, c.correo ${a.desde} ORDER BY c.id`, a.vals)).rows;
                if (!destinatarios.length) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Ningún cliente cumple esos criterios' }); }
                if (destinatarios.length > MAX_MASIVO) { await client.query('ROLLBACK'); return res.status(400).json({ message: `Son ${destinatarios.length} clientes; el máximo por envío es ${MAX_MASIVO}. Ajusta los criterios.` }); }
                // Lo que se vio en la vista previa debe ser lo que se envía.
                if (Number(b.confirmar_total) !== destinatarios.length) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ message: `Ahora son ${destinatarios.length} clientes (antes ${Number(b.confirmar_total) || 0}). Revisa la vista previa y vuelve a enviar.`, total: destinatarios.length });
                }
                lote = (await client.query(`INSERT INTO cupon_lotes (nombre, modo, criterios, resumen, total, usuario_id, motivo)
                    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                    [nombre, a.modo, JSON.stringify(b.criterios || {}), a.resumen.slice(0, 400), destinatarios.length, req.usuario.id, d.motivo])).rows[0];
                for (const c of destinatarios) {
                    c.cup = (await client.query(
                        `INSERT INTO cupones (codigo, cliente_id, origen, descripcion, tipo, valor, tope, minimo, vence, usuario_id, motivo, lote_id)
                         VALUES ($1,$2,'campana',$3,$4,$5,$6,$7, CURRENT_TIMESTAMP + make_interval(days => $8::int), $9, $10, $11) RETURNING *`,
                        [await codigoNuevo(client, 'KZ'), c.id, nombre, d.tipo, d.valor, d.tope, d.minimo, d.dias, req.usuario.id, d.motivo, lote.id])).rows[0];
                }
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            } finally { client.release(); }
            res.status(201).json({ message: `Se dieron ${destinatarios.length} cupones (${nombre}). Los correos se van enviando en este momento.`, lote_id: lote.id, total: destinatarios.length });
            // Correos uno tras otro, sin detener la respuesta.
            (async () => { for (const c of destinatarios) { if (b.notificar !== false) await correoCupon(c, c.cup); } })();
        }));
        // Pasarle a un lote vencidos/cancelados no aplica; cancelar todo lo que
        // siga disponible de un envío (por ejemplo, si se mandó con un error).
        app.post('/api/admin/cupones/lotes/:id/cancelar', asyncRoute(async (req, res) => {
            if (!puedeMasivo(req, res)) return;
            const motivo = String((req.body || {}).motivo || '').trim().slice(0, 200);
            if (motivo.length < 5) return res.status(400).json({ message: 'Escribe el motivo (queda en la bitácora)' });
            const r = await pool.query(`UPDATE cupones SET estado = 'cancelado',
                    motivo = RIGHT(CONCAT_WS(' | ', motivo, $2::text), 300)
                 WHERE lote_id = $1 AND estado = 'disponible'`, [Number(req.params.id) || 0, `${new Date().toLocaleDateString('es-MX')} ${req.usuario.nombre}: ${motivo}`]);
            res.json({ message: `Se cancelaron ${r.rowCount} cupones que no se habían usado` });
        }));

        // ---- Panel (Soporte / Administrador) ----
        app.get('/api/admin/clientes/:id/cupones', asyncRoute(async (req, res) => {
            const r = await pool.query(`${SELECT} WHERE cu.cliente_id = $1 ORDER BY cu.fecha DESC`, [req.params.id]);
            res.json(r.rows.map((c) => ({ ...publico(c), motivo: c.motivo, usuario_nombre: c.usuario_nombre })));
        }));
        // Dar un cupón a un cliente (compensación, error con otro cupón…)
        app.post('/api/admin/clientes/:id/cupones', asyncRoute(async (req, res) => {
            const l = leerDatos(req.body || {}, req.usuario);
            if (l.message) return res.status(l.status).json({ message: l.message });
            const { tipo, valor, motivo, dias, minimo, tope, descripcion } = l.datos;
            const c = (await pool.query('SELECT id, nombre, correo FROM clientes WHERE id = $1', [req.params.id])).rows[0];
            if (!c) return res.status(404).json({ message: 'Cliente no encontrado' });
            const codigo = await codigoNuevo(pool, 'KZ');
            const cup = (await pool.query(
                `INSERT INTO cupones (codigo, cliente_id, origen, descripcion, tipo, valor, tope, minimo, vence, usuario_id, motivo)
                 VALUES ($1,$2,'soporte',$3,$4,$5,$6,$7, CURRENT_TIMESTAMP + make_interval(days => $8::int), $9, $10) RETURNING *`,
                [codigo, c.id, descripcion || 'Cupón de regalo', tipo, valor, tope, minimo, dias, req.usuario.id, motivo])).rows[0];
            await correoCupon(c, cup);
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
