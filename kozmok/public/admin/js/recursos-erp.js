// public/admin/js/recursos-erp.js
// Recursos de la empresa DENTRO del ERP (ventana desde el Dashboard ERP,
// solo administrador), sin pantalla aparte en el menú:
//   - Humanos     -> equipo interno por rol (Cuentas y equipo)
//   - Materiales  -> inventario del SCM
//   - Financieros -> cobrado, por cobrar, reposición comprometida y presupuestos
//   - Registrados -> equipo, vehículos, instalaciones y presupuestos
//                    (alta, edición y baja; tabla recursos_erp)
// Uso:  RecursosERP.abrir()

(function () {
    const ic = (n, s) => (window.icon ? window.icon(n, s) : '');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const TIPO = { equipo: 'Equipo', vehiculo: 'Vehículo', instalacion: 'Instalación', presupuesto: 'Presupuesto' };
    const AREA = { administracion: 'Administración', ventas: 'Ventas', logistica: 'Logística' };
    const ESTADO = { disponible: 'Disponible', en_uso: 'En uso', mantenimiento: 'Mantenimiento', baja: 'Baja' };
    const COLOR = { disponible: 'var(--success)', en_uso: 'var(--info, var(--accent))', mantenimiento: 'var(--warning)', baja: 'var(--text-muted)' };
    const linea = (k, v, ultima) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;${ultima ? '' : 'border-bottom:1px solid var(--border);'}font-size:.86rem"><span>${k}</span><strong class="mono">${v}</strong></div>`;

    let DATA = null;
    let USUARIOS = [];
    let filtroTipo = '';
    let filtroArea = '';

    function overlay() {
        let el = document.getElementById('modal-recursos-erp');
        if (!el) {
            el = document.createElement('div');
            el.className = 'modal-overlay';
            el.id = 'modal-recursos-erp';
            el.innerHTML = '<div class="modal" style="max-width:900px" id="mre-body"></div>';
            el.addEventListener('click', (e) => { if (e.target === el) cerrar(); });
            document.body.appendChild(el);
        }
        return el;
    }
    function cerrar() { overlay().classList.remove('open'); }
    const cuerpo = () => document.getElementById('mre-body');
    const btnCerrar = () => `<button class="modal-close" onclick="RecursosERP.cerrar()" aria-label="Cerrar">${ic('x', 20)}</button>`;

    async function abrir() {
        overlay().classList.add('open');
        cuerpo().innerHTML = `${btnCerrar()}<p>Cargando…</p>`;
        try {
            [DATA, USUARIOS] = await Promise.all([api('/admin/erp/recursos'), api('/admin/usuarios').catch(() => [])]);
        } catch (e) { toast(e.message, 'error'); cerrar(); return; }
        pintar();
    }

    function pintar() {
        const h = DATA.humanos, m = DATA.materiales, f = DATA.financieros;
        const card = (titulo, sub, html) => `<div class="card" style="margin:0;padding:12px 14px">
            <h4 style="margin:0">${titulo}</h4><p style="margin:2px 0 8px;font-size:.78rem;color:var(--text-muted)">${sub}</p>${html}</div>`;
        cuerpo().innerHTML = `${btnCerrar()}
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
                <div>
                    <h3 style="margin:0">Recursos de la empresa</h3>
                    <p style="font-size:.85rem;color:var(--text-muted);margin:4px 0 0">Humanos, materiales y financieros se leen de CRM, SCM y ERP sin duplicarlos.</p>
                </div>
                <button class="btn btn-primary btn-sm" onclick="RecursosERP.formulario()">${ic('plus', 14)} Nuevo recurso</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin:14px 0">
                ${card('Humanos', 'Equipo interno por rol', h.map((x) => linea(x.nombre, `${x.activos}${x.total !== x.activos ? ` <span style="color:var(--text-muted);font-weight:400">/ ${x.total}</span>` : ''}`)).join('') + linea('Total activos', h.reduce((a, x) => a + x.activos, 0), true))}
                ${card('Materiales', 'Inventario del SCM',
                    linea('Productos activos', m.productos) + linea('Unidades en stock', m.unidades) +
                    linea('Valor a costo', formatoMoneda(m.valor_costo)) + linea('Valor a precio de venta', formatoMoneda(m.valor_venta)) +
                    linea('En stock crítico', `<span style="color:${m.criticos ? 'var(--danger)' : 'inherit'}">${m.criticos}</span>`, true))}
                ${card('Financieros', 'Ventas, cobranza y compromisos',
                    linea('Ingresos cobrados', formatoMoneda(f.ingresos)) +
                    linea('Por cobrar', `<span style="color:var(--warning)">${formatoMoneda(f.por_cobrar)}</span>`) +
                    linea('Reposición comprometida', formatoMoneda(f.reposicion_comprometida)) +
                    linea('Presupuestos asignados', formatoMoneda(f.presupuesto_asignado), true))}
            </div>
            <h4 style="margin:0">Equipo, vehículos, instalaciones y presupuestos</h4>
            <p style="font-size:.8rem;color:var(--text-muted);margin:2px 0 8px">Lo que no vive en otro módulo se registra aquí, con su área y responsable.</p>
            <div class="filters-bar" style="margin:0 0 10px">
                <select id="mre-tipo"><option value="">Todos los tipos</option>${Object.entries(TIPO).map(([k, v]) => `<option value="${k}" ${k === filtroTipo ? 'selected' : ''}>${v}</option>`).join('')}</select>
                <select id="mre-area"><option value="">Todas las áreas</option>${Object.entries(AREA).map(([k, v]) => `<option value="${k}" ${k === filtroArea ? 'selected' : ''}>${v}</option>`).join('')}</select>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Recurso</th><th>Tipo</th><th>Área</th><th>Cant.</th><th>Valor</th><th>Responsable</th><th>Estado</th><th></th></tr></thead>
                    <tbody id="mre-tabla"></tbody>
                </table>
            </div>`;
        document.getElementById('mre-tipo').addEventListener('change', (e) => { filtroTipo = e.target.value; tabla(); });
        document.getElementById('mre-area').addEventListener('change', (e) => { filtroArea = e.target.value; tabla(); });
        tabla();
    }

    function tabla() {
        const lista = DATA.registrados.filter((r) => (!filtroTipo || r.tipo === filtroTipo) && (!filtroArea || r.area === filtroArea));
        document.getElementById('mre-tabla').innerHTML = lista.length ? lista.map((r) => `
            <tr>
                <td><strong>${esc(r.nombre)}</strong>${r.descripcion ? `<div style="font-size:.76rem;color:var(--text-muted)">${esc(r.descripcion)}</div>` : ''}</td>
                <td>${TIPO[r.tipo]}</td>
                <td>${AREA[r.area]}</td>
                <td class="mono">${r.cantidad}</td>
                <td class="mono">${formatoMoneda(r.valor * r.cantidad)}</td>
                <td>${r.responsable_nombre ? esc(r.responsable_nombre) : '—'}</td>
                <td><span class="tag" style="color:${COLOR[r.estado]};border-color:${COLOR[r.estado]}">${ESTADO[r.estado]}</span></td>
                <td style="white-space:nowrap">
                    <button class="btn btn-ghost btn-sm" onclick="RecursosERP.formulario(${r.id})">Editar</button>
                    <button class="btn btn-ghost btn-sm" onclick="RecursosERP.eliminar(${r.id})">Eliminar</button>
                </td>
            </tr>`).join('') : '<tr><td colspan="8" style="color:var(--text-muted)">No hay recursos con ese filtro.</td></tr>';
    }

    function formulario(id) {
        const r = id ? DATA.registrados.find((x) => x.id === id) : { tipo: 'equipo', area: 'administracion', estado: 'disponible', cantidad: 1, valor: 0 };
        const sel = (nombre, mapa, valor) => `<select id="mre-f-${nombre}">${Object.entries(mapa).map(([k, v]) => `<option value="${k}" ${k === valor ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
        const rolLabel = window.ROL_LABEL || {};
        cuerpo().innerHTML = `${btnCerrar()}
            <button class="btn btn-ghost btn-sm" style="padding-left:0" onclick="RecursosERP.volver()">${ic('undo', 14)} Volver a recursos</button>
            <h3 style="margin:6px 0 12px">${id ? 'Editar recurso' : 'Nuevo recurso'}</h3>
            <div style="max-width:560px">
                <div class="field"><label>Nombre</label><input id="mre-f-nombre" value="${esc(r.nombre || '')}" maxlength="120" /></div>
                <div class="field-row">
                    <div class="field"><label>Tipo</label>${sel('tipo', TIPO, r.tipo)}</div>
                    <div class="field"><label>Área</label>${sel('area', AREA, r.area)}</div>
                </div>
                <div class="field"><label>Descripción</label><input id="mre-f-descripcion" value="${esc(r.descripcion || '')}" maxlength="300" /></div>
                <div class="field-row">
                    <div class="field"><label>Cantidad</label><input type="number" min="0" step="1" id="mre-f-cantidad" value="${r.cantidad}" /></div>
                    <div class="field"><label>Valor unitario / monto</label><input type="number" min="0" step="0.01" id="mre-f-valor" value="${r.valor}" /></div>
                </div>
                <div class="field-row">
                    <div class="field"><label>Estado</label>${sel('estado', ESTADO, r.estado)}</div>
                    <div class="field"><label>Responsable</label>
                        <select id="mre-f-responsable"><option value="">Sin responsable</option>${USUARIOS.filter((u) => u.activo || u.id === r.responsable_id).map((u) =>
                            `<option value="${u.id}" ${u.id === r.responsable_id ? 'selected' : ''}>${esc(u.nombre)} · ${rolLabel[u.rol] || u.rol}</option>`).join('')}</select>
                    </div>
                </div>
                <div id="mre-f-error" style="color:var(--danger);font-size:.85rem;margin:4px 0 10px;display:none"></div>
                <button class="btn btn-primary" style="width:100%" onclick="RecursosERP.guardar(${id || 0})">${id ? 'Guardar cambios' : 'Registrar recurso'}</button>
            </div>`;
    }

    async function guardar(id) {
        const v = (k) => document.getElementById('mre-f-' + k).value;
        const body = {
            nombre: v('nombre').trim(), tipo: v('tipo'), area: v('area'), descripcion: v('descripcion').trim(),
            cantidad: v('cantidad'), valor: v('valor'), estado: v('estado'), responsable_id: v('responsable') || null,
        };
        const err = document.getElementById('mre-f-error');
        if (!body.nombre) { err.textContent = 'El nombre es obligatorio.'; err.style.display = 'block'; return; }
        try {
            const r = await api('/admin/erp/recursos' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body });
            toast(r.message, 'ok');
            await abrir();
        } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
    }

    async function eliminar(id) {
        const r = DATA.registrados.find((x) => x.id === id);
        if (!(await confirmar(`¿Eliminar "${esc(r.nombre)}"? Si solo dejó de usarse, mejor cámbialo a estado "Baja".`, { okText: 'Eliminar', peligro: true }))) return;
        try {
            const res = await api('/admin/erp/recursos/' + id, { method: 'DELETE' });
            toast(res.message, 'ok');
            await abrir();
        } catch (e) { toast(e.message, 'error'); }
    }

    window.RecursosERP = { abrir, cerrar, formulario, guardar, eliminar, volver: pintar };
})();
