// public/admin/js/clientes-erp.js
// Consulta de clientes DENTRO del ERP (Dashboard ERP y Órdenes de
// clientes), sin ir al CRM: listado con lo que cada cliente le ha
// comprado a la empresa y su ficha con datos, métricas y órdenes.
// Una orden de la ficha se abre en el gestor de pedidos (gestion-pedido.js).
// Uso:  ClientesERP.abrir()   o   ClientesERP.ficha(id)

(function () {
    const ic = (n, s) => (window.icon ? window.icon(n, s) : '');
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const pillOrigen = (o) => (o === 'erp' ? '<span class="origen-pill o-erp">ERP</span>' : '<span class="origen-pill">En línea</span>');
    let LISTA = [];
    let timer = null;

    function overlay() {
        let el = document.getElementById('modal-clientes-erp');
        if (!el) {
            el = document.createElement('div');
            el.className = 'modal-overlay';
            el.id = 'modal-clientes-erp';
            el.innerHTML = '<div class="modal" style="max-width:860px" id="mce-body"></div>';
            el.addEventListener('click', (e) => { if (e.target === el) cerrar(); });
            document.body.appendChild(el);
        }
        return el;
    }
    function cerrar() { overlay().classList.remove('open'); }
    const cuerpo = () => document.getElementById('mce-body');
    const btnCerrar = () => `<button class="modal-close" onclick="ClientesERP.cerrar()" aria-label="Cerrar">${ic('x', 20)}</button>`;

    async function abrir() {
        overlay().classList.add('open');
        cuerpo().innerHTML = `${btnCerrar()}
            <h3 style="margin-top:0">Clientes</h3>
            <p style="font-size:.85rem;color:var(--text-muted);margin-top:-6px">Clientes del CRM con lo que han comprado por los dos canales (tienda en línea y ERP). Abre uno para ver su ficha y sus órdenes.</p>
            <div class="filters-bar">
                <input type="search" id="mce-busqueda" placeholder="Buscar nombre, correo o empresa…" style="min-width:220px" />
                <select id="mce-etapa">
                    <option value="">Todas las etapas</option>
                    <option>Prospecto</option><option>Activo</option><option>Frecuente</option><option>Inactivo</option>
                </select>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Cliente</th><th>Etapa</th><th>Órdenes</th><th>Cobrado</th><th>Por cobrar</th><th>Última orden</th></tr></thead>
                    <tbody id="mce-tabla"><tr><td colspan="6">Cargando…</td></tr></tbody>
                </table>
            </div>`;
        document.getElementById('mce-busqueda').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(cargar, 250); });
        document.getElementById('mce-etapa').addEventListener('change', cargar);
        await cargar();
    }

    async function cargar() {
        const params = new URLSearchParams();
        const b = document.getElementById('mce-busqueda').value.trim();
        const e = document.getElementById('mce-etapa').value;
        if (b) params.set('busqueda', b);
        if (e) params.set('etapa', e);
        try {
            LISTA = await api('/admin/erp/clientes-consulta?' + params.toString());
        } catch (err) { toast(err.message, 'error'); return; }
        const tb = document.getElementById('mce-tabla');
        if (!tb) return;
        tb.innerHTML = LISTA.length ? LISTA.map((c) => `
            <tr style="cursor:pointer" onclick="ClientesERP.ficha(${c.id})">
                <td><strong>${esc(c.nombre)}</strong>
                    <div style="color:var(--text-muted);font-size:.78rem">${esc(c.empresa || c.correo)}${c.estado_cliente === 'inactivo' ? ' · inactivo' : ''}</div></td>
                <td><span class="tag tag-etapa-${c.etapa_crm}">${c.etapa_crm}</span></td>
                <td class="mono">${c.ordenes}${c.ordenes_erp ? `<div style="color:var(--text-muted);font-size:.75rem">${c.ordenes_erp} ERP</div>` : ''}</td>
                <td class="mono">${formatoMoneda(c.total_cobrado)}</td>
                <td class="mono" style="${c.por_cobrar > 0 ? 'color:var(--warning, #c78a00)' : 'color:var(--text-muted)'}">${formatoMoneda(c.por_cobrar)}</td>
                <td style="font-size:.8rem">${c.ultima_orden ? formatoFecha(c.ultima_orden) : '—'}</td>
            </tr>`).join('') : '<tr><td colspan="6" style="color:var(--text-muted)">No hay clientes con ese filtro.</td></tr>';
    }

    async function ficha(id) {
        overlay().classList.add('open');
        cuerpo().innerHTML = `${btnCerrar()}<p>Cargando…</p>`;
        let c;
        try { c = await api('/admin/erp/clientes-consulta/' + id); } catch (e) { toast(e.message, 'error'); return; }
        const rol = (Sesion.usuario() || {}).rol;
        const puedeCapturar = window.puedeVer && puedeVer(rol, 'orden-nueva') && c.estado_cliente === 'activo';
        const dato = (k, v) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text-muted)">${k}</span><span>${v || '—'}</span></div>`;
        cuerpo().innerHTML = `${btnCerrar()}
            <button class="btn btn-ghost btn-sm" style="padding-left:0" onclick="ClientesERP.abrir()">${ic('undo', 14)} Volver a clientes</button>
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin:6px 0 14px">
                <div>
                    <h3 style="margin:0">${esc(c.nombre)}</h3>
                    <div style="font-size:.85rem;color:var(--text-muted)">${[c.empresa, c.correo, c.telefono].filter(Boolean).map(esc).join(' · ')}</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <span class="tag tag-etapa-${c.etapa_crm}">${c.etapa_crm}</span>
                    <button class="btn btn-outline btn-sm" onclick="ClientesERP.verOrdenes(${c.id})">${ic('clipboard', 14)} Ver sus órdenes</button>
                    ${puedeCapturar ? `<a class="btn btn-primary btn-sm" href="/admin/orden-nueva.html?cliente=${c.id}">${ic('plus', 14)} Nueva orden</a>` : ''}
                </div>
            </div>
            <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px">
                <div class="stat-card"><div class="stat-label">Compras</div><div class="stat-value">${c.total_compras}</div><div class="stat-sub">${c.ordenes.filter((o) => o.origen === 'erp').length} órdenes ERP</div></div>
                <div class="stat-card"><div class="stat-label">Valor total</div><div class="stat-value" style="font-size:1.3rem">${formatoMoneda(c.valor_total)}</div><div class="stat-sub">ticket ${formatoMoneda(c.ticket_promedio)}</div></div>
                <div class="stat-card"><div class="stat-label">Club</div><div class="stat-value">${c.puntos}</div><div class="stat-sub">puntos</div></div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:14px">
                <div style="font-size:.86rem">
                    <h4 style="margin:0 0 6px">Datos (CRM)</h4>
                    ${dato('Estado', c.estado_cliente)}
                    ${dato('Ciudad', esc([c.ciudad, c.estado].filter(Boolean).join(', ')))}
                    ${dato('Dirección', esc(c.direccion))}
                    ${dato('Cliente desde', c.fecha_registro ? formatoFecha(c.fecha_registro) : '')}
                    ${dato('Última interacción', c.ultima_interaccion ? formatoFecha(c.ultima_interaccion) : 'Sin registrar')}
                </div>
                <div style="font-size:.86rem">
                    <h4 style="margin:0 0 6px">Lo que más compra</h4>
                    ${c.mas_comprados.length ? c.mas_comprados.map((p) => dato(esc(p.nombre), `${p.unidades} u.`)).join('') : '<p style="color:var(--text-muted)">Todavía no tiene compras.</p>'}
                </div>
            </div>
            <h4 style="margin:0 0 6px">Órdenes (${c.ordenes.length})</h4>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Folio</th><th>Fecha</th><th>Canal</th><th>Piezas</th><th>Total</th><th>Estado</th><th>Pago</th></tr></thead>
                    <tbody>${c.ordenes.length ? c.ordenes.map((o) => `
                        <tr style="cursor:pointer" onclick="ClientesERP.orden(${o.id}, ${c.id})">
                            <td class="mono">${o.numero_orden}</td>
                            <td style="font-size:.8rem">${formatoFecha(o.fecha_pedido)}</td>
                            <td>${pillOrigen(o.origen)}</td>
                            <td class="mono">${o.piezas}</td>
                            <td class="mono">${formatoMoneda(o.total)}</td>
                            <td><span class="estado-pill e-${o.estado}">${o.estado}</span></td>
                            <td style="font-size:.8rem">${o.pago_estado}</td>
                        </tr>`).join('') : '<tr><td colspan="7" style="color:var(--text-muted)">Sin órdenes.</td></tr>'}</tbody>
                </table>
            </div>`;
    }

    // Abre la orden en el gestor; al cerrarlo o cambiarla, la ficha se actualiza.
    async function orden(pedidoId, clienteId) {
        if (!window.GestionPedido) return;
        cerrar();
        await GestionPedido.abrir(pedidoId, { onCambio: () => { if (window.onCambioClientesERP) window.onCambioClientesERP(); } });
        const gp = document.getElementById('modal-gestion-pedido');
        if (gp) {
            const volver = () => {
                if (!gp.classList.contains('open')) { obs.disconnect(); ficha(clienteId); }
            };
            const obs = new MutationObserver(volver);
            obs.observe(gp, { attributes: true, attributeFilter: ['class'] });
        }
    }

    // Filtra Órdenes de clientes por este cliente (ahí mismo si ya estamos
    // en esa pantalla; si no, la abre ya filtrada).
    function verOrdenes(id) {
        cerrar();
        if (window.filtrarOrdenes) window.filtrarOrdenes({ cliente: id });
        else location.href = '/admin/ordenes-erp.html?cliente=' + id;
    }

    window.ClientesERP = { abrir, cerrar, ficha, orden, verOrdenes };
})();
