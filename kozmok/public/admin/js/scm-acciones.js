// public/admin/js/scm-acciones.js
// Formularios del SCM que se abren en una ventana DENTRO de la pantalla
// donde estés (Inventario, Dashboard SCM, Pedidos, Movimientos o Nueva
// orden del ERP), para no tener que navegar a otra sección:
//   ScmAcciones.pedidoReposicion({ productoId, pedido, onListo })  generar / editar pedido al proveedor
//   ScmAcciones.nuevoMovimiento({ productoId, tipo, onListo })      entrada o salida manual
//   ScmAcciones.abasto({ productoId, onListo })                     stock mínimo, proveedor, costo y push/pull

(function () {
    let PRODUCTOS = [];
    let PROVEEDORES = [];
    let onListo = null;

    const ic = (n, s) => (window.icon ? window.icon(n, s) : '');
    const masDias = (dias) => { const d = new Date(); d.setDate(d.getDate() + Number(dias || 0)); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
    const hoyISO = () => masDias(0);
    const ahoraLocal = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
    const $ = (id) => document.getElementById(id);

    function overlay() {
        let el = $('modal-scm-accion');
        if (!el) {
            el = document.createElement('div');
            el.className = 'modal-overlay';
            el.id = 'modal-scm-accion';
            el.innerHTML = '<div class="modal" style="max-width:540px" id="msa-body"></div>';
            el.addEventListener('click', (e) => { if (e.target === el) cerrar(); });
            document.body.appendChild(el);
        }
        return el;
    }
    function abrirModal(html) {
        overlay();
        $('msa-body').innerHTML = `<button class="modal-close" onclick="ScmAcciones.cerrar()">${ic('x', 18)}</button>${html}`;
        overlay().classList.add('open');
    }
    function cerrar() { overlay().classList.remove('open'); }
    function listo(msg) {
        cerrar();
        toast(msg, 'ok');
        if (onListo) onListo();
    }

    // Siempre datos frescos: el stock cambia con cada venta.
    async function catalogos() {
        [PRODUCTOS, PROVEEDORES] = await Promise.all([api('/admin/productos'), api('/proveedores')]);
    }
    const producto = (id) => PRODUCTOS.find((x) => x.id === Number(id));
    const sugerirCantidad = (p) => (p ? Math.max((p.stock_minimo * 2) - p.stock, p.stock_minimo, 1) : 1);

    // ------------------------------------------------------------
    // Pedido de reposición (orden de compra al proveedor)
    // ------------------------------------------------------------
    async function pedidoReposicion({ productoId = null, pedido = null, onListo: cb = null } = {}) {
        onListo = cb;
        try { await catalogos(); } catch (e) { toast(e.message, 'error'); return; }
        const pid = pedido ? pedido.producto_id : productoId;
        const p = producto(pid);
        const provSel = pedido ? pedido.proveedor_id : (p && p.proveedor_id);
        const prov = PROVEEDORES.find((x) => x.id === provSel);
        const fecha = pedido ? String(pedido.fecha_estimada || '').slice(0, 10) : masDias(prov ? prov.tiempo_entrega_dias : 7);
        abrirModal(`
            <h3>${pedido ? 'Editar pedido ' + pedido.folio : 'Nuevo pedido de reposición'}</h3>
            <div class="field"><label>Producto</label>
                <select id="msa-producto" onchange="ScmAcciones._alCambiarProducto()" ${pedido ? 'disabled' : ''}>
                    <option value="">Selecciona un producto</option>
                    ${PRODUCTOS.filter((x) => x.activo).map((x) => `<option value="${x.id}" ${Number(pid) === x.id ? 'selected' : ''}>${x.nombre} (stock ${x.stock}/${x.stock_minimo})</option>`).join('')}
                </select>
            </div>
            <div class="field-row">
                <div class="field"><label>Cantidad</label><input type="number" min="1" id="msa-cantidad" value="${pedido ? pedido.cantidad : sugerirCantidad(p)}" oninput="ScmAcciones._costo()" /></div>
                <div class="field"><label>Tipo</label><select disabled><option>Reposición</option></select></div>
            </div>
            <div class="field"><label>Proveedor</label>
                <select id="msa-proveedor" onchange="ScmAcciones._alCambiarProveedor()">
                    <option value="">Selecciona un proveedor</option>
                    ${PROVEEDORES.map((pv) => `<option value="${pv.id}" ${provSel === pv.id ? 'selected' : ''}>${pv.nombre} · ${pv.tiempo_entrega_dias} días</option>`).join('')}
                </select>
            </div>
            <div class="field"><label>Fecha estimada de entrega</label><input type="date" id="msa-fecha" min="${hoyISO()}" value="${fecha}" /></div>
            <div class="field"><label>Notas</label><textarea id="msa-notas" rows="2" placeholder="Notas…">${pedido && pedido.notas ? pedido.notas : ''}</textarea></div>
            <p id="msa-costo" style="font-size:.84rem;color:var(--text-muted);margin:0 0 4px"></p>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
                <button class="btn btn-outline" onclick="ScmAcciones.cerrar()">Cancelar</button>
                <button class="btn btn-primary" onclick="ScmAcciones._guardarPedido(${pedido ? pedido.id : ''})">${pedido ? 'Guardar cambios' : 'Generar pedido'}</button>
            </div>`);
        costo();
    }
    function alCambiarProducto() {
        const p = producto($('msa-producto').value);
        $('msa-cantidad').value = sugerirCantidad(p);
        if (p && p.proveedor_id) $('msa-proveedor').value = p.proveedor_id;
        alCambiarProveedor();
    }
    function alCambiarProveedor() {
        const pv = PROVEEDORES.find((x) => x.id === Number($('msa-proveedor').value));
        if (pv) $('msa-fecha').value = masDias(pv.tiempo_entrega_dias);
        costo();
    }
    function costo() {
        const p = producto($('msa-producto').value);
        const cant = Number($('msa-cantidad').value) || 0;
        $('msa-costo').innerHTML = p && p.costo_unitario
            ? `Costo estimado: <strong>${formatoMoneda(p.costo_unitario * cant)}</strong> (${formatoMoneda(p.costo_unitario)} c/u)` : '';
    }
    async function guardarPedido(id) {
        const body = {
            producto_id: Number($('msa-producto').value) || null,
            proveedor_id: Number($('msa-proveedor').value) || null,
            cantidad: Number($('msa-cantidad').value),
            fecha_estimada: $('msa-fecha').value || null,
            notas: $('msa-notas').value,
        };
        if (!body.producto_id) return toast('Selecciona un producto', 'warn');
        if (!body.cantidad || body.cantidad < 1) return toast('La cantidad debe ser mayor a 0', 'warn');
        try {
            const r = id ? await api(`/admin/ordenes-compra/${id}`, { method: 'PUT', body })
                : await api('/admin/ordenes-compra', { method: 'POST', body });
            listo(id ? 'Pedido actualizado' : `Pedido ${r.folio} generado al proveedor`);
        } catch (e) { toast(e.message, 'error'); }
    }

    // ------------------------------------------------------------
    // Movimiento manual de inventario
    // ------------------------------------------------------------
    const MOTIVOS = {
        entrada: ['Compra a proveedor', 'Devolución de cliente', 'Ajuste de inventario', 'Conteo físico'],
        salida: ['Merma / daño', 'Ajuste de inventario', 'Conteo físico', 'Muestra o uso interno'],
    };
    async function nuevoMovimiento({ productoId = null, tipo = 'entrada', onListo: cb = null } = {}) {
        onListo = cb;
        try { await catalogos(); } catch (e) { toast(e.message, 'error'); return; }
        const radio = (t, txt) => `<label style="display:flex;align-items:center;gap:6px;width:auto;margin:0"><input type="radio" name="msa-tipo" value="${t}" ${t === tipo ? 'checked' : ''} style="width:auto" onchange="ScmAcciones._motivos()" /> ${txt}</label>`;
        abrirModal(`
            <h3>Nuevo movimiento</h3>
            <div class="field"><label>Producto</label>
                <select id="msa-producto">${PRODUCTOS.map((p) => `<option value="${p.id}" ${Number(productoId) === p.id ? 'selected' : ''}>${p.nombre} (stock ${p.stock})</option>`).join('')}</select>
            </div>
            <div class="field"><label>Tipo</label><div style="display:flex;gap:18px;align-items:center;padding:6px 0">${radio('entrada', 'Entrada')}${radio('salida', 'Salida')}</div></div>
            <div class="field-row">
                <div class="field"><label>Cantidad</label><input type="number" min="1" id="msa-cantidad" value="1" /></div>
                <div class="field"><label>Motivo</label><select id="msa-motivo" onchange="document.getElementById('msa-otro-wrap').hidden = this.value !== 'otro'"></select></div>
            </div>
            <div class="field" id="msa-otro-wrap" hidden><label>Describe el motivo</label><input id="msa-otro" placeholder="Ej. traspaso entre sucursales" /></div>
            <div class="field-row">
                <div class="field"><label>Fecha</label><input type="datetime-local" id="msa-fecha" value="${ahoraLocal()}" max="${ahoraLocal()}" /></div>
                <div class="field"><label>Usuario</label><input value="${(Sesion.usuario() || {}).nombre || ''}" disabled /></div>
            </div>
            <p style="font-size:.76rem;color:var(--text-muted);margin:0">Una salida cuenta como demanda: si deja el producto en stock crítico se genera solo su pedido de reposición.</p>
            <button class="btn btn-primary" style="width:100%;margin-top:12px" onclick="ScmAcciones._guardarMovimiento()">Registrar movimiento</button>`);
        motivos();
    }
    function motivos() {
        const t = document.querySelector('input[name="msa-tipo"]:checked').value;
        $('msa-motivo').innerHTML = MOTIVOS[t].map((m) => `<option>${m}</option>`).join('') + '<option value="otro">Otro…</option>';
        $('msa-otro-wrap').hidden = true;
    }
    async function guardarMovimiento() {
        const body = {
            producto_id: Number($('msa-producto').value),
            tipo: document.querySelector('input[name="msa-tipo"]:checked').value,
            cantidad: Number($('msa-cantidad').value),
            motivo: $('msa-motivo').value === 'otro' ? $('msa-otro').value.trim() : $('msa-motivo').value,
            fecha: $('msa-fecha').value || null,
        };
        if (!body.motivo) return toast('Escribe el motivo', 'warn');
        if (!body.cantidad || body.cantidad < 1) return toast('La cantidad debe ser mayor a 0', 'warn');
        try {
            await api('/admin/movimientos-inventario', { method: 'POST', body });
            listo(`Movimiento registrado (${body.tipo === 'entrada' ? '+' : '−'}${body.cantidad})`);
        } catch (e) { toast(e.message, 'error'); }
    }

    // ------------------------------------------------------------
    // Parámetros de abastecimiento de un producto
    // ------------------------------------------------------------
    async function abasto({ productoId, onListo: cb = null } = {}) {
        onListo = cb;
        try { await catalogos(); } catch (e) { toast(e.message, 'error'); return; }
        const p = producto(productoId);
        if (!p) return toast('Producto no encontrado', 'error');
        const tarjeta = (v, titulo, txt) => `
            <label style="display:block;cursor:pointer;padding:10px 12px;border:1px solid var(--line);border-radius:10px;flex:1">
                <input type="radio" name="msa-restock" value="${v}" ${p.restock === v ? 'checked' : ''} style="width:auto;margin-right:6px" />
                <strong>${titulo}</strong><span style="display:block;font-size:.76rem;color:var(--text-muted);margin-top:2px">${txt}</span>
            </label>`;
        abrirModal(`
            <h3 style="margin-bottom:2px">Abastecimiento</h3>
            <p style="margin:0 0 14px;color:var(--text-muted);font-size:.85rem">${p.nombre} · stock actual ${p.stock}</p>
            <div class="field-row">
                <div class="field"><label>Stock mínimo</label><input type="number" min="0" id="msa-minimo" value="${p.stock_minimo}" /></div>
                <div class="field"><label>Costo unitario (proveedor)</label><input type="number" min="0" step="0.01" id="msa-costo-u" value="${p.costo_unitario ?? ''}" /></div>
            </div>
            <div class="field"><label>Proveedor</label>
                <select id="msa-proveedor">${p.proveedor_id ? '' : '<option value="">Sin asignar</option>'}
                    ${PROVEEDORES.map((pv) => `<option value="${pv.id}" ${p.proveedor_id === pv.id ? 'selected' : ''}>${pv.nombre} · ${pv.tiempo_entrega_dias} días</option>`).join('')}
                </select>
            </div>
            <div class="field"><label>Estrategia de reabastecimiento</label>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    ${tarjeta('push', 'Push', 'Se pide en cuanto el stock toca el mínimo.')}
                    ${tarjeta('pull', 'Pull', 'Se pide solo cuando una venta o salida lo deja en el mínimo.')}
                </div>
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
                <button class="btn btn-outline" onclick="ScmAcciones.cerrar()">Cancelar</button>
                <button class="btn btn-primary" onclick="ScmAcciones._guardarAbasto(${p.id})">Guardar</button>
            </div>`);
    }
    async function guardarAbasto(id) {
        const minimo = Number($('msa-minimo').value);
        if (!Number.isInteger(minimo) || minimo < 0) return toast('El stock mínimo debe ser un número entero', 'warn');
        const costoU = $('msa-costo-u').value;
        const body = {
            stock_minimo: minimo,
            restock: document.querySelector('input[name="msa-restock"]:checked').value,
            costo_unitario: costoU === '' ? undefined : Number(costoU),
        };
        const prov = Number($('msa-proveedor').value) || null;
        if (prov) body.proveedor_id = prov;
        try {
            await api(`/admin/productos/${id}`, { method: 'PUT', body });
            listo('Abastecimiento actualizado');
        } catch (e) { toast(e.message, 'error'); }
    }

    window.ScmAcciones = {
        pedidoReposicion, nuevoMovimiento, abasto, cerrar,
        _alCambiarProducto: alCambiarProducto, _alCambiarProveedor: alCambiarProveedor, _costo: costo,
        _guardarPedido: guardarPedido, _motivos: motivos, _guardarMovimiento: guardarMovimiento, _guardarAbasto: guardarAbasto,
    };
})();
