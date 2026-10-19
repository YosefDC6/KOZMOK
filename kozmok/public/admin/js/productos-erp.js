// public/admin/js/productos-erp.js
// Consulta de productos DENTRO del ERP (Dashboard ERP y Órdenes de
// clientes), sin ir al SCM: inventario con lo vendido de cada producto
// y su ficha con stock, reposición en curso, órdenes de clientes que lo
// incluyen y últimos movimientos de inventario.
// Uso:  ProductosERP.abrir()   o   ProductosERP.ficha(id)

(function () {
    const ic = (n, s) => (window.icon ? window.icon(n, s) : '');
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const pillOrigen = (o) => (o === 'erp' ? '<span class="origen-pill o-erp">ERP</span>' : '<span class="origen-pill">En línea</span>');
    const ESTADO = {
        normal: '<span class="stock-ok">Normal</span>',
        bajo: '<span class="stock-low">Stock bajo</span>',
        agotado: '<span class="stock-out">Agotado</span>',
    };
    let LISTA = [];
    let CATEGORIAS = null;
    let timer = null;

    function overlay() {
        let el = document.getElementById('modal-productos-erp');
        if (!el) {
            el = document.createElement('div');
            el.className = 'modal-overlay';
            el.id = 'modal-productos-erp';
            el.innerHTML = '<div class="modal" style="max-width:880px" id="mpe-body"></div>';
            el.addEventListener('click', (e) => { if (e.target === el) cerrar(); });
            document.body.appendChild(el);
        }
        return el;
    }
    function cerrar() { overlay().classList.remove('open'); }
    const cuerpo = () => document.getElementById('mpe-body');
    const btnCerrar = () => `<button class="modal-close" onclick="ProductosERP.cerrar()" aria-label="Cerrar">${ic('x', 20)}</button>`;

    async function abrir() {
        overlay().classList.add('open');
        cuerpo().innerHTML = `${btnCerrar()}
            <h3 style="margin-top:0">Productos</h3>
            <p style="font-size:.85rem;color:var(--text-muted);margin-top:-6px">Inventario del SCM con lo que se ha vendido de cada producto. Abre uno para ver su ficha y las órdenes que lo incluyen.</p>
            <div class="filters-bar">
                <input type="search" id="mpe-busqueda" placeholder="Buscar nombre o marca…" style="min-width:200px" />
                <select id="mpe-categoria"><option value="">Todas las categorías</option></select>
                <select id="mpe-estado">
                    <option value="">Todo el stock</option><option value="normal">Normal</option>
                    <option value="bajo">Stock bajo</option><option value="agotado">Agotado</option>
                </select>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Producto</th><th>Precio</th><th>Stock</th><th>Estado</th><th>Vendidos</th><th>Órdenes</th></tr></thead>
                    <tbody id="mpe-tabla"><tr><td colspan="6">Cargando…</td></tr></tbody>
                </table>
            </div>`;
        document.getElementById('mpe-busqueda').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(cargar, 250); });
        document.getElementById('mpe-categoria').addEventListener('change', cargar);
        document.getElementById('mpe-estado').addEventListener('change', pintar);
        await cargar();
    }

    async function cargar() {
        const params = new URLSearchParams();
        const b = document.getElementById('mpe-busqueda').value.trim();
        const cat = document.getElementById('mpe-categoria').value;
        if (b) params.set('busqueda', b);
        if (cat) params.set('categoria_id', cat);
        try {
            LISTA = await api('/admin/erp/productos-consulta?' + params.toString());
        } catch (err) { toast(err.message, 'error'); return; }
        // Las categorías se toman de la primera carga (catálogo completo).
        if (!CATEGORIAS) {
            const m = new Map();
            LISTA.forEach((p) => { if (p.categoria_id) m.set(p.categoria_id, p.categoria); });
            CATEGORIAS = [...m].sort((a, b) => a[1].localeCompare(b[1]));
        }
        const sel = document.getElementById('mpe-categoria');
        if (sel && sel.options.length === 1) {
            sel.insertAdjacentHTML('beforeend', CATEGORIAS.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join(''));
        }
        pintar();
    }

    function pintar() {
        const tb = document.getElementById('mpe-tabla');
        if (!tb) return;
        const est = document.getElementById('mpe-estado').value;
        const lista = est ? LISTA.filter((p) => p.estado_stock === est) : LISTA;
        tb.innerHTML = lista.length ? lista.map((p) => `
            <tr style="cursor:pointer" onclick="ProductosERP.ficha(${p.id})">
                <td><strong>${esc(p.nombre)}</strong>
                    <div style="color:var(--text-muted);font-size:.78rem">${esc([p.categoria, p.marca].filter(Boolean).join(' · '))}</div></td>
                <td class="mono">${formatoMoneda(p.precio)}</td>
                <td class="mono">${p.stock}<div style="color:var(--text-muted);font-size:.72rem">mín. ${p.stock_minimo}</div></td>
                <td style="font-size:.82rem">${ESTADO[p.estado_stock]}${p.reposicion_en_curso ? `<div style="color:var(--text-muted);font-size:.72rem">${p.reposicion_en_curso} en curso</div>` : ''}</td>
                <td class="mono">${p.vendidos}</td>
                <td class="mono">${p.ordenes}</td>
            </tr>`).join('') : '<tr><td colspan="6" style="color:var(--text-muted)">No hay productos con ese filtro.</td></tr>';
    }

    async function ficha(id) {
        overlay().classList.add('open');
        cuerpo().innerHTML = `${btnCerrar()}<p>Cargando…</p>`;
        let p;
        try { p = await api('/admin/erp/productos-consulta/' + id); } catch (e) { toast(e.message, 'error'); return; }
        const dato = (k, v) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text-muted)">${k}</span><span style="text-align:right">${v || '—'}</span></div>`;
        const [ocFolio, ocFecha] = (p.reposicion_en_curso || '').split('|');
        const specs = [
            ['Procesador', p.procesador], ['RAM', p.ram_gb ? p.ram_gb + ' GB' : ''], ['Almacenamiento', p.almacenamiento],
            ['Gráfica', p.tarjeta_grafica], ['Pantalla', p.pantalla],
        ].filter(([, v]) => v);
        cuerpo().innerHTML = `${btnCerrar()}
            <button class="btn btn-ghost btn-sm" style="padding-left:0" onclick="ProductosERP.abrir()">${ic('undo', 14)} Volver a productos</button>
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin:6px 0 14px">
                <div>
                    <h3 style="margin:0">${esc(p.nombre)}</h3>
                    <div style="font-size:.85rem;color:var(--text-muted)">${esc([p.categoria, p.marca].filter(Boolean).join(' · '))}</div>
                </div>
                <button class="btn btn-outline btn-sm" onclick="ProductosERP.verOrdenes(${p.id})">${ic('clipboard', 14)} Ver sus órdenes</button>
            </div>
            <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px">
                <div class="stat-card"><div class="stat-label">Precio</div><div class="stat-value" style="font-size:1.3rem">${formatoMoneda(p.precio)}</div></div>
                <div class="stat-card"><div class="stat-label">Stock</div><div class="stat-value">${p.stock}</div><div class="stat-sub">${ESTADO[p.estado_stock]} · mín. ${p.stock_minimo}</div></div>
                <div class="stat-card"><div class="stat-label">Vendidos</div><div class="stat-value">${p.vendidos}</div><div class="stat-sub">${formatoMoneda(p.ingresos)}</div></div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:14px;font-size:.86rem">
                <div>
                    <h4 style="margin:0 0 6px">Abastecimiento (SCM)</h4>
                    ${dato('Proveedor', esc(p.proveedor))}
                    ${dato('Tiempo de entrega', p.tiempo_entrega_dias ? p.tiempo_entrega_dias + ' días' : '')}
                    ${dato('Estrategia', p.estrategia)}
                    ${dato('Reposición en curso', ocFolio ? `${ocFolio}${ocFecha ? ' · llega ' + formatoFecha(ocFecha) : ''}` : 'Ninguna')}
                </div>
                <div>
                    <h4 style="margin:0 0 6px">Especificaciones</h4>
                    ${specs.length ? specs.map(([k, v]) => dato(k, esc(v))).join('') : '<p style="color:var(--text-muted)">Sin especificaciones registradas.</p>'}
                </div>
            </div>
            <h4 style="margin:0 0 6px">Órdenes de clientes que lo incluyen (${p.ordenes.length})</h4>
            <div class="table-wrap" style="margin-bottom:14px">
                <table>
                    <thead><tr><th>Folio</th><th>Fecha</th><th>Cliente</th><th>Canal</th><th>Cant.</th><th>Estado</th></tr></thead>
                    <tbody>${p.ordenes.length ? p.ordenes.map((o) => `
                        <tr style="cursor:pointer" onclick="ProductosERP.orden(${o.id}, ${p.id})">
                            <td class="mono">${o.numero_orden}</td>
                            <td style="font-size:.8rem">${formatoFecha(o.fecha_pedido)}</td>
                            <td>${esc(o.cliente_nombre)}</td>
                            <td>${pillOrigen(o.origen)}</td>
                            <td class="mono">${o.cantidad}</td>
                            <td><span class="estado-pill e-${o.estado}">${o.estado}</span></td>
                        </tr>`).join('') : '<tr><td colspan="6" style="color:var(--text-muted)">Todavía no se ha vendido.</td></tr>'}</tbody>
                </table>
            </div>
            <h4 style="margin:0 0 6px">Últimos movimientos de inventario</h4>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Fecha</th><th>Tipo</th><th>Cantidad</th><th>Motivo</th></tr></thead>
                    <tbody>${p.movimientos.length ? p.movimientos.map((m) => `
                        <tr>
                            <td style="font-size:.8rem">${formatoFecha(m.fecha)}</td>
                            <td style="text-transform:capitalize">${m.tipo}</td>
                            <td class="mono">${m.tipo === 'salida' ? '−' : '+'}${m.cantidad}</td>
                            <td style="font-size:.8rem">${esc(m.motivo)}</td>
                        </tr>`).join('') : '<tr><td colspan="4" style="color:var(--text-muted)">Sin movimientos.</td></tr>'}</tbody>
                </table>
            </div>`;
    }

    // Filtra Órdenes de clientes por este producto (si estamos en esa
    // pantalla se aplica ahí mismo; si no, se abre ya filtrada).
    function verOrdenes(id) {
        cerrar();
        if (window.filtrarOrdenes) window.filtrarOrdenes({ producto: id });
        else location.href = '/admin/ordenes-erp.html?producto=' + id;
    }

    async function orden(pedidoId, productoId) {
        if (!window.GestionPedido) return;
        cerrar();
        await GestionPedido.abrir(pedidoId, { onCambio: () => { if (window.onCambioClientesERP) window.onCambioClientesERP(); } });
        const gp = document.getElementById('modal-gestion-pedido');
        if (gp) {
            const obs = new MutationObserver(() => {
                if (!gp.classList.contains('open')) { obs.disconnect(); ficha(productoId); }
            });
            obs.observe(gp, { attributes: true, attributeFilter: ['class'] });
        }
    }

    window.ProductosERP = { abrir, cerrar, ficha, orden, verOrdenes };
})();
