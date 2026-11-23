// notificaciones.js
// Notificaciones para las cuentas del panel: en la página (campana del menú)
// y por correo. Cada minuto revisa lo nuevo en la base (tickets, reclamos,
// devoluciones, reseñas, pedidos, recargas, stock, bajas y seguridad) y avisa
// a las personas cuyo rol ve esa sección. Los avisos que no salen de la base
// (un cliente que reporta su pago) se crean al momento con crear().
//
// Cada persona elige, por categoría, si la quiere en el panel y por correo
// (usuarios.notif_prefs). Los correos de una misma revisión se juntan en uno
// solo por persona, para no llenarle la bandeja.

const CATEGORIAS = [
    { clave: 'tickets',      label: 'Tickets de soporte',      desc: 'Tickets nuevos y mensajes de clientes',          permisos: ['soporte'] },
    { clave: 'garantias',    label: 'Reclamos de garantía',    desc: 'Reclamos nuevos y mensajes de clientes',         permisos: ['garantias'] },
    { clave: 'devoluciones', label: 'Devoluciones',            desc: 'Solicitudes nuevas de devolución o cambio',      permisos: ['devoluciones'] },
    { clave: 'resenas',      label: 'Reseñas',                 desc: 'Reseñas de 3 estrellas o menos',                 permisos: ['evaluaciones'] },
    { clave: 'pedidos',      label: 'Pedidos nuevos',          desc: 'Compras hechas en la tienda en línea',           permisos: ['ordenes-erp'] },
    { clave: 'pagos',        label: 'Pagos por confirmar',     desc: 'Clientes que avisan que ya pagaron (SPEI o tienda)', permisos: ['pagos', 'pedidos'] },
    { clave: 'monedero',     label: 'Recargas por confirmar',  desc: 'Transferencias al monedero',                     permisos: ['monedero'] },
    { clave: 'inventario',   label: 'Stock crítico',           desc: 'Productos que llegan a su mínimo o se agotan',   permisos: ['inventario'] },
    { clave: 'bajas',        label: 'Bajas por aprobar',       desc: 'Bajas de inventario que esperan aprobación',     permisos: ['auditoria'] },
    { clave: 'seguridad',    label: 'Alertas de seguridad',    desc: 'Eventos de severidad alta',                      permisos: ['seguridad'] },
];
const POR_CLAVE = Object.fromEntries(CATEGORIAS.map((c) => [c.clave, c]));

module.exports = function crearNotificaciones({ pool, enviarCorreo, puedeVer, urlBase }) {
    const ve = (rol, cat) => (POR_CLAVE[cat] || { permisos: [] }).permisos.some((k) => puedeVer(rol, k));
    const categoriasDe = (rol) => CATEGORIAS.filter((c) => ve(rol, c.clave));
    const prefsDe = (u) => {
        const p = u.notif_prefs || {};
        return { panel_off: new Set(p.panel_off || []), correo_off: new Set(p.correo_off || []), correo: p.correo !== false };
    };

    async function migrar() {
        await pool.query(`CREATE TABLE IF NOT EXISTS notificaciones (
            id BIGSERIAL PRIMARY KEY,
            usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            categoria VARCHAR(20) NOT NULL,
            titulo VARCHAR(160) NOT NULL,
            cuerpo VARCHAR(400),
            url VARCHAR(200),
            leida BOOLEAN NOT NULL DEFAULT FALSE,
            fecha TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_notif_usuario ON notificaciones(usuario_id, leida, id DESC)');
        await pool.query(`CREATE TABLE IF NOT EXISTS notif_cursor (fuente VARCHAR(30) PRIMARY KEY, ultimo_id BIGINT NOT NULL DEFAULT 0)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS notif_stock (producto_id INTEGER PRIMARY KEY, agotado BOOLEAN NOT NULL DEFAULT FALSE)`);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS notif_prefs JSONB NOT NULL DEFAULT '{}'::jsonb`);
    }

    // Reparte los eventos entre las personas que deben verlos, los guarda y
    // manda un solo correo por persona con lo suyo.
    //   evento: { categoria, titulo, cuerpo, url, urls, excluir_usuario }
    //   urls: [[permiso, url], ...] -> cada quien recibe el enlace de la
    //   primera pantalla que su rol puede abrir (si no, se usa url).
    const urlPara = (ev, rol) => {
        const op = (ev.urls || []).find(([k]) => puedeVer(rol, k));
        return op ? op[1] : ev.url || null;
    };
    async function crear(eventos) {
        if (!eventos.length) return 0;
        const us = (await pool.query('SELECT id, nombre, email, rol, notif_prefs FROM usuarios WHERE activo')).rows;
        const correoDe = new Map();
        let n = 0;
        for (const ev of eventos) {
            for (const u of us) {
                if (!ve(u.rol, ev.categoria) || Number(ev.excluir_usuario) === Number(u.id)) continue;
                const pr = prefsDe(u);
                const url = urlPara(ev, u.rol);
                if (!pr.panel_off.has(ev.categoria)) {
                    await pool.query(
                        'INSERT INTO notificaciones (usuario_id, categoria, titulo, cuerpo, url) VALUES ($1,$2,$3,$4,$5)',
                        [u.id, ev.categoria, String(ev.titulo).slice(0, 160), ev.cuerpo ? String(ev.cuerpo).slice(0, 400) : null, url]);
                    n++;
                }
                if (pr.correo && !pr.correo_off.has(ev.categoria) && u.email) {
                    if (!correoDe.has(u.id)) correoDe.set(u.id, { u, lista: [] });
                    correoDe.get(u.id).lista.push({ ...ev, url });
                }
            }
        }
        const base = urlBase();
        for (const { u, lista } of correoDe.values()) {
            const asunto = lista.length === 1 ? `Kozmok · ${lista[0].titulo}` : `Kozmok · Tienes ${lista.length} avisos nuevos en el panel`;
            const lineas = lista.map((e) => `- ${e.titulo}${e.cuerpo ? ` — ${e.cuerpo}` : ''}${e.url ? `\n  ${base}${e.url}` : ''}`).join('\n');
            const destino = lista.length === 1 && lista[0].url ? `${base}${lista[0].url}` : `${base}/admin/login.html`;
            await enviarCorreo(pool, {
                para: u.email, tipo: 'panel', asunto,
                cuerpo: `Hola ${u.nombre}:\n\n${lista.length === 1 ? 'Hay algo nuevo en el panel de Kozmok:' : 'Hay cosas nuevas en el panel de Kozmok:'}\n\n${lineas}\n\n`
                    + `Abrir el panel: ${destino}\n\nPuedes elegir qué avisos te llegan por correo en el panel, en tu menú → "Notificaciones".`,
                boton: { texto: 'Abrir el panel', url: destino },
            }).catch((e) => console.error('Correo de notificación:', e.message));
        }
        return n;
    }

    // ---- Revisión periódica ----
    async function cursor(fuente, maxSql) {
        const r = await pool.query('SELECT ultimo_id FROM notif_cursor WHERE fuente = $1', [fuente]);
        if (r.rows.length) return Number(r.rows[0].ultimo_id);
        // Primera vez: se empieza desde lo que ya hay (no se avisa lo viejo).
        const m = Number((await pool.query(maxSql)).rows[0].m) || 0;
        await pool.query('INSERT INTO notif_cursor (fuente, ultimo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fuente, m]);
        return null;
    }
    const avanzar = (fuente, id) => pool.query('UPDATE notif_cursor SET ultimo_id = GREATEST(ultimo_id, $2) WHERE fuente = $1', [fuente, id]);
    const corto = (t, n = 120) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const dinero = (v) => '$' + Number(v || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });

    // Lee filas nuevas de una tabla (por id) y avanza su cursor.
    async function nuevas(fuente, tabla, sql) {
        const desde = await cursor(fuente, `SELECT MAX(id) AS m FROM ${tabla}`);
        if (desde === null) return [];
        const r = await pool.query(sql, [desde]);
        const max = Math.max(desde, ...r.rows.map((x) => Number(x._id)));
        if (max > desde) await avanzar(fuente, max);
        return r.rows;
    }

    async function revisar() {
        const ev = [];
        // Tickets: nuevos y mensajes de clientes
        for (const m of await nuevas('ticket_mensajes', 'ticket_mensajes', `
            SELECT m.id AS _id, m.autor, m.mensaje, t.id, t.folio, t.asunto, t.prioridad, c.nombre,
                   m.id = (SELECT MIN(id) FROM ticket_mensajes WHERE ticket_id = t.id) AS primero
            FROM ticket_mensajes m JOIN tickets t ON t.id = m.ticket_id JOIN clientes c ON c.id = t.cliente_id
            WHERE m.id > $1 ORDER BY m.id LIMIT 500`)) {
            if (m.autor !== 'cliente') continue;
            ev.push({ categoria: 'tickets', dedupe: 'tk' + m.id, url: `/admin/soporte.html?ticket=${m.id}`,
                titulo: m.primero ? `Ticket nuevo ${m.folio}${m.prioridad === 'alta' ? ' (prioridad alta)' : ''}` : `${m.nombre} respondió en ${m.folio}`,
                cuerpo: `${m.primero ? `${m.nombre}: ${m.asunto}. ` : ''}${corto(m.mensaje) || 'Mandó fotos'}` });
        }
        // Reclamos de garantía: nuevos y mensajes de clientes
        for (const r of await nuevas('reclamos', 'reclamos_garantia', `
            SELECT r.id AS _id, r.id, r.folio, r.descripcion, c.nombre, pr.nombre AS producto
            FROM reclamos_garantia r JOIN clientes c ON c.id = r.cliente_id JOIN garantias g ON g.id = r.garantia_id
            LEFT JOIN productos pr ON pr.id = g.producto_id WHERE r.id > $1 ORDER BY r.id LIMIT 200`)) {
            ev.push({ categoria: 'garantias', dedupe: 'rc' + r.id, url: `/admin/garantias.html?reclamo=${r.id}`,
                titulo: `Reclamo de garantía nuevo ${r.folio}`, cuerpo: `${r.nombre}${r.producto ? ` · ${r.producto}` : ''}: ${corto(r.descripcion)}` });
        }
        for (const m of await nuevas('reclamo_mensajes', 'reclamo_mensajes', `
            SELECT m.id AS _id, m.autor, m.interno, m.mensaje, r.id, r.folio, c.nombre
            FROM reclamo_mensajes m JOIN reclamos_garantia r ON r.id = m.reclamo_id JOIN clientes c ON c.id = r.cliente_id
            WHERE m.id > $1 ORDER BY m.id LIMIT 500`)) {
            if (m.autor !== 'cliente' || m.interno) continue;
            ev.push({ categoria: 'garantias', dedupe: 'rc' + m.id, url: `/admin/garantias.html?reclamo=${m.id}`,
                titulo: `${m.nombre} escribió en el reclamo ${m.folio}`, cuerpo: corto(m.mensaje) || 'Mandó fotos' });
        }
        // Devoluciones nuevas
        for (const d of await nuevas('devoluciones', 'devoluciones', `
            SELECT d.id AS _id, d.id, d.folio, d.resolucion, d.monto, p.numero_orden, c.nombre
            FROM devoluciones d JOIN pedidos p ON p.id = d.pedido_id LEFT JOIN clientes c ON c.id = d.cliente_id
            WHERE d.id > $1 ORDER BY d.id LIMIT 200`)) {
            ev.push({ categoria: 'devoluciones', url: `/admin/devoluciones.html?dev=${d.id}`,
                titulo: `Devolución solicitada ${d.folio}`, cuerpo: `${d.nombre || 'Cliente'} · pedido ${d.numero_orden} · ${d.resolucion === 'cambio' ? 'cambio' : 'reembolso'} por ${dinero(d.monto)}` });
        }
        // Reseñas de 3 estrellas o menos
        for (const r of await nuevas('resenas', 'resenas', `
            SELECT re.id AS _id, re.id, re.calificacion, re.comentario, c.nombre, p.nombre AS producto
            FROM resenas re JOIN clientes c ON c.id = re.cliente_id JOIN productos p ON p.id = re.producto_id
            WHERE re.id > $1 ORDER BY re.id LIMIT 200`)) {
            if (r.calificacion > 3) continue;
            ev.push({ categoria: 'resenas', url: `/admin/evaluaciones.html?resena=${r.id}`,
                titulo: `Reseña de ${r.calificacion}★ en ${r.producto}`, cuerpo: `${r.nombre}${r.comentario ? `: ${corto(r.comentario)}` : ''}` });
        }
        // Pedidos nuevos de la tienda en línea
        for (const p of await nuevas('pedidos', 'pedidos', `
            SELECT p.id AS _id, p.id, p.numero_orden, p.total, p.origen, p.metodo_tipo, c.nombre
            FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id WHERE p.id > $1 ORDER BY p.id LIMIT 200`)) {
            if (p.origen === 'erp') continue;
            ev.push({ categoria: 'pedidos', urls: [['pedidos', `/admin/pedidos.html?open=${p.id}`], ['ordenes-erp', `/admin/ordenes-erp.html?open=${p.id}`]],
                titulo: `Pedido nuevo ${p.numero_orden}`, cuerpo: `${p.nombre || 'Cliente'} · ${dinero(p.total)}${p.metodo_tipo ? ` · ${p.metodo_tipo}` : ''}` });
        }
        // Recargas del monedero por transferencia (esperan confirmación)
        for (const m of await nuevas('monedero', 'movimientos_monedero', `
            SELECT mm.id AS _id, mm.tipo, mm.estado, mm.monto, c.nombre
            FROM movimientos_monedero mm JOIN monederos mo ON mo.id = mm.monedero_id LEFT JOIN clientes c ON c.id = mo.cliente_id
            WHERE mm.id > $1 ORDER BY mm.id LIMIT 200`)) {
            if (m.tipo !== 'recarga' || m.estado !== 'pendiente') continue;
            ev.push({ categoria: 'monedero', url: '/admin/monedero.html',
                titulo: `Recarga por confirmar de ${dinero(m.monto)}`, cuerpo: `${m.nombre || 'Cliente'} avisó una transferencia al monedero` });
        }
        // Bajas de inventario que esperan aprobación (no se le avisa a quien la registró)
        for (const b of await nuevas('bajas', 'movimientos_inventario', `
            SELECT mi.id AS _id, mi.estado, mi.cantidad, mi.usuario_id, mi.motivo, p.nombre, u.nombre AS quien
            FROM movimientos_inventario mi JOIN productos p ON p.id = mi.producto_id LEFT JOIN usuarios u ON u.id = mi.usuario_id
            WHERE mi.id > $1 ORDER BY mi.id LIMIT 200`)) {
            if (b.estado !== 'pendiente') continue;
            ev.push({ categoria: 'bajas', url: '/admin/auditoria.html', excluir_usuario: b.usuario_id,
                titulo: `Baja por aprobar: ${b.cantidad} × ${b.nombre}`, cuerpo: `${b.quien || 'Alguien del equipo'} · ${corto(b.motivo, 90)}` });
        }
        // Alertas de seguridad altas (se juntan en un solo aviso por revisión)
        const alertas = (await nuevas('seguridad', 'eventos_seguridad', `
            SELECT id AS _id, tipo, severidad, ip, detalle FROM eventos_seguridad WHERE id > $1 ORDER BY id LIMIT 1000`))
            .filter((a) => a.severidad === 'alta');
        if (alertas.length === 1) {
            ev.push({ categoria: 'seguridad', url: '/admin/seguridad.html', titulo: `Alerta de seguridad: ${alertas[0].tipo.replace(/_/g, ' ')}`,
                cuerpo: corto(`${alertas[0].detalle || ''}${alertas[0].ip ? ` (IP ${alertas[0].ip})` : ''}`) });
        } else if (alertas.length > 1) {
            const tipos = [...new Set(alertas.map((a) => a.tipo.replace(/_/g, ' ')))].join(', ');
            ev.push({ categoria: 'seguridad', url: '/admin/seguridad.html', titulo: `${alertas.length} alertas de seguridad`, cuerpo: corto(tipos) });
        }
        // Stock crítico: avisa cuando un producto entra a su mínimo y cuando se agota
        const criticos = (await pool.query('SELECT id, nombre, stock, stock_minimo FROM productos WHERE activo AND stock <= stock_minimo')).rows;
        const primera = !(await pool.query("SELECT 1 FROM notif_cursor WHERE fuente = 'stock'")).rows.length;
        const ya = new Map((await pool.query('SELECT producto_id, agotado FROM notif_stock')).rows.map((x) => [Number(x.producto_id), x.agotado]));
        for (const p of criticos) {
            const agotado = Number(p.stock) <= 0;
            const antes = ya.get(Number(p.id));
            if (!primera && (antes === undefined || (agotado && !antes))) {
                ev.push({ categoria: 'inventario', url: '/admin/inventario.html',
                    titulo: agotado ? `Se agotó: ${p.nombre}` : `Stock crítico: ${p.nombre}`,
                    cuerpo: agotado ? 'Sin existencias en la tienda' : `Quedan ${p.stock} (mínimo ${p.stock_minimo})` });
            }
            await pool.query(`INSERT INTO notif_stock (producto_id, agotado) VALUES ($1,$2)
                              ON CONFLICT (producto_id) DO UPDATE SET agotado = EXCLUDED.agotado`, [p.id, agotado]);
        }
        await pool.query('DELETE FROM notif_stock WHERE NOT (producto_id = ANY($1::int[]))', [criticos.map((p) => p.id)]);
        if (primera) await pool.query("INSERT INTO notif_cursor (fuente, ultimo_id) VALUES ('stock', 0) ON CONFLICT DO NOTHING");

        // Un mismo ticket o reclamo va una sola vez por revisión (el primero:
        // "nuevo" gana a "respondió").
        const vistos = new Set();
        const unicos = ev.filter((e) => { if (!e.dedupe) return true; if (vistos.has(e.dedupe)) return false; vistos.add(e.dedupe); return true; });
        return crear(unicos);
    }

    // ---- Rutas del panel (las monta server.js en /api/admin/notificaciones) ----
    function rutas(app, asyncRoute) {
        app.get('/api/admin/notificaciones', asyncRoute(async (req, res) => {
            const limite = Math.min(50, Math.max(1, Number(req.query.limite) || 30));
            const [items, n] = await Promise.all([
                pool.query('SELECT id, categoria, titulo, cuerpo, url, leida, fecha FROM notificaciones WHERE usuario_id = $1 ORDER BY id DESC LIMIT $2', [req.usuario.id, limite]),
                pool.query('SELECT COUNT(*)::int AS n, MAX(id) AS ultimo FROM notificaciones WHERE usuario_id = $1 AND NOT leida', [req.usuario.id]),
            ]);
            res.set('Cache-Control', 'no-store');
            res.json({ no_leidas: n.rows[0].n, ultimo_id: Number(n.rows[0].ultimo) || 0, items: items.rows,
                categorias: Object.fromEntries(CATEGORIAS.map((c) => [c.clave, c.label])) });
        }));
        app.post('/api/admin/notificaciones/leer', asyncRoute(async (req, res) => {
            const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter((x) => x > 0).slice(0, 200) : [];
            if (req.body.todas) await pool.query('UPDATE notificaciones SET leida = TRUE WHERE usuario_id = $1 AND NOT leida', [req.usuario.id]);
            else if (ids.length) await pool.query('UPDATE notificaciones SET leida = TRUE WHERE usuario_id = $1 AND id = ANY($2::bigint[])', [req.usuario.id, ids]);
            res.json({ ok: true });
        }));
        app.get('/api/admin/notificaciones/preferencias', asyncRoute(async (req, res) => {
            const u = (await pool.query('SELECT email, rol, notif_prefs FROM usuarios WHERE id = $1', [req.usuario.id])).rows[0];
            const pr = prefsDe(u);
            res.json({
                correo: pr.correo, email: u.email,
                categorias: categoriasDe(u.rol).map((c) => ({ clave: c.clave, label: c.label, desc: c.desc, panel: !pr.panel_off.has(c.clave), correo: !pr.correo_off.has(c.clave) })),
            });
        }));
        app.put('/api/admin/notificaciones/preferencias', asyncRoute(async (req, res) => {
            const validas = new Set(CATEGORIAS.map((c) => c.clave));
            const lista = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter((x) => validas.has(x)))] : []);
            const prefs = { correo: req.body.correo !== false, panel_off: lista(req.body.panel_off), correo_off: lista(req.body.correo_off) };
            await pool.query('UPDATE usuarios SET notif_prefs = $1 WHERE id = $2', [JSON.stringify(prefs), req.usuario.id]);
            res.json({ message: 'Preferencias de notificaciones guardadas' });
        }));
    }

    return { CATEGORIAS, migrar, crear, revisar, rutas };
};
