// public/admin/js/gestion-pedido.js
// Gestor de un pedido de cliente que se abre DENTRO del panel donde
// estés (CRM › Pedidos, ERP › Órdenes de clientes, ERP › Dashboard o
// SCM › Pedidos), para no tener que saltar de módulo:
//   - estado del envío (pipeline) y cancelación,
//   - registro del pago,
//   - datos e historial del cliente (CRM),
//   - partidas con su stock actual y los movimientos de inventario (SCM),
//   - procesos internos de la orden (bitácora del ERP).
// Uso:  GestionPedido.abrir(id, { onCambio: () => recargarListado() })

(function () {
    const FLUJO = ['pendiente', 'confirmado', 'procesando', 'enviado', 'entregado'];
    const ETIQUETA = ['Pendiente', 'Confirmado', 'Procesando', 'Enviado', 'Entregado'];
    const CANCELABLES = ['pendiente', 'confirmado', 'procesando'];
    let onCambio = null;
    let actual = null;

    const ic = (n, s) => (window.icon ? window.icon(n, s) : '');
    const fila = (k, v, estilo = '') => `<div style="display:flex;justify-content:space-between;gap:10px;${estilo}"><span>${k}</span><span class="mono">${v}</span></div>`;
    const pillOrigen = (o) => (o === 'erp' ? '<span class="origen-pill o-erp">ERP</span>' : '<span class="origen-pill">En línea</span>');

    function puedeGestionar() {
        const rol = (Sesion.usuario() || {}).rol;
        return ['pedidos', 'ordenes-erp', 'ordenes-compra'].some((k) => window.puedeVer && puedeVer(rol, k));
    }

    function overlay() {
        let el = document.getElementById('modal-gestion-pedido');
        if (!el) {
            el = document.createElement('div');
            el.className = 'modal-overlay';
            el.id = 'modal-gestion-pedido';
            el.innerHTML = '<div class="modal" style="max-width:680px" id="mgp-body"></div>';
            el.addEventListener('click', (e) => { if (e.target === el) cerrar(); });
            document.body.appendChild(el);
        }
        return el;
    }

    function cerrar() { overlay().classList.remove('open'); }

    async function abrir(id, opciones = {}) {
        if (opciones.onCambio) onCambio = opciones.onCambio;
        try {
            actual = await api(`/admin/pedidos/${id}`);
        } catch (e) { toast(e.message, 'error'); return; }
        const el = overlay();
        pintar();
        el.classList.add('open');
    }

    function pipeline(d, editable) {
        if (d.estado === 'cancelado') {
            return `<div class="pago-box" style="border-color:var(--danger);background:color-mix(in srgb,var(--danger) 8%,transparent)">
                <h4>${ic('x', 15)} Pedido cancelado</h4>
                <div class="pb-sub" style="margin:0">El stock, las garantías y los puntos de este pedido ya se regresaron. La cancelación es definitiva.</div>
            </div>`;
        }
        const iAct = FLUJO.indexOf(d.estado);
        const completo = d.estado === 'entregado';
        return `
            <div class="pipe">
                ${FLUJO.map((e, i) => {
                    const done = completo || i < iAct;
                    const act = !done && i === iAct;
                    return `<div class="pipe-step ${done ? 'done' : ''} ${act ? 'actual' : ''}" ${editable ? `onclick="GestionPedido.mover('${e}')"` : 'style="cursor:default"'} title="${ETIQUETA[i]}">
                        <div class="pd">${done ? ic('check', 13) : i + 1}</div><div class="pl">${ETIQUETA[i]}</div>
                    </div>`;
                }).join('')}
            </div>
            ${editable && CANCELABLES.includes(d.estado) ? `<div style="text-align:right;margin-top:-8px">
                <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="GestionPedido.cancelar()">Cancelar pedido</button>
            </div>` : ''}`;
    }

    function bloquePago(d, editable) {
        if (d.estado === 'cancelado') return '';
        if (d.pago_estado === 'pendiente') {
            return `<div class="pago-box pendiente">
                <h4>${ic('clock', 15)} Pago pendiente · ${d.metodo_pago || ''}</h4>
                <div class="pb-ref">${d.pago_referencia || '—'}</div>
                <div class="pb-sub">${d.pago_reportado ? 'El cliente reportó que ya pagó. Verifica y registra el pago.' : 'Aún no se registra el pago. El envío avanza cuando se cobre.'}</div>
                ${editable ? `<button class="btn btn-primary btn-cobro" onclick="GestionPedido.registrarPago()">${ic('check', 15)} Marcar pago recibido</button>` : ''}
            </div>`;
        }
        return `<div class="pago-box pagado">
            <h4>${ic('check', 15)} Pago confirmado</h4>
            <div class="pb-sub" style="margin:0">${d.metodo_pago || '—'} · ${formatoFecha(d.fecha_confirmacion || d.fecha_pedido)}</div>
        </div>`;
    }

    function bloqueCliente(d) {
        return `<div class="card" style="padding:12px 14px;margin:0 0 14px;background:var(--bg-panel-2)">
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
                <div>
                    <div style="font-size:.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">Cliente (CRM)</div>
                    <strong>${d.cliente_nombre}</strong>
                    <div style="font-size:.8rem;color:var(--text-muted)">${[d.cliente_empresa, d.cliente_correo, d.cliente_telefono].filter(Boolean).join(' · ')}</div>
                </div>
                <div style="text-align:right;font-size:.8rem">
                    <span class="origen-pill">${d.cliente_etapa}</span>
                    <div style="color:var(--text-muted);margin-top:4px">${d.cliente_compras} compra${d.cliente_compras === 1 ? '' : 's'} · ${formatoMoneda(d.cliente_valor)} · ${d.cliente_puntos} pts</div>
                </div>
            </div>
            <button class="btn btn-ghost btn-sm" style="padding-left:0;margin-top:6px" onclick="GestionPedido.historial()">${ic('clock', 14)} Ver historial de compras</button>
            <div id="mgp-historial"></div>
        </div>`;
    }

    function bloqueMovimientos(d) {
        if (!d.movimientos || d.movimientos.length === 0) return '';
        return `<details style="margin-top:14px">
            <summary style="cursor:pointer;font-size:.86rem">${ic('package', 14)} Movimientos de inventario que generó (${d.movimientos.length})</summary>
            <div class="table-wrap" style="margin-top:8px"><table><tbody>${d.movimientos.map((m) => `
                <tr>
                    <td style="font-size:.78rem">${formatoFecha(m.fecha)}</td>
                    <td>${m.producto_nombre}</td>
                    <td class="mono" style="color:${m.tipo === 'entrada' ? 'var(--success)' : 'var(--danger)'}">${m.tipo === 'entrada' ? '+' : '−'}${m.cantidad}</td>
                    <td style="font-size:.78rem;color:var(--text-muted)">${m.motivo}${m.usuario_nombre ? ' · ' + m.usuario_nombre : ''}</td>
                </tr>`).join('')}</tbody></table></div>
        </details>`;
    }

    // Procesos internos (ERP): cada paso que vivió la orden, automático o
    // hecho por alguien del equipo (tabla procesos_erp).
    function bloqueProcesos(d) {
        if (!d.procesos || d.procesos.length === 0) return '';
        return `<details style="margin-top:14px" ${d.origen === 'erp' ? 'open' : ''}>
            <summary style="cursor:pointer;font-size:.86rem">${ic('layers', 14)} Procesos internos de la orden (${d.procesos.length})</summary>
            <ol style="list-style:none;margin:8px 0 0;padding:0">${d.procesos.map((p) => `
                <li style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:.82rem">
                    <span style="color:${p.automatico ? 'var(--success)' : 'var(--accent)'}" title="${p.automatico ? 'Automático' : 'Manual'}">${ic(p.automatico ? 'check' : 'user', 14)}</span>
                    <span style="flex:1">${p.descripcion}
                        <span style="display:block;font-size:.74rem;color:var(--text-muted)">${formatoFecha(p.fecha)} · ${p.automatico ? 'automático' : 'manual'}${p.usuario_nombre ? ' · ' + p.usuario_nombre : ''}</span>
                    </span>
                </li>`).join('')}</ol>
        </details>`;
    }

    function pintar() {
        const d = actual;
        const editable = puedeGestionar();
        document.getElementById('mgp-body').innerHTML = `
            <button class="modal-close" onclick="GestionPedido.cerrar()">${ic('x', 18)}</button>
            <h3 style="margin-bottom:2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${d.numero_orden} ${pillOrigen(d.origen)}</h3>
            <p style="margin:0 0 12px;color:var(--text-muted);font-size:.84rem">
                ${formatoFecha(d.fecha_pedido)}${d.registrado_por ? ' · capturó ' + d.registrado_por : ''} · ${d.direccion_envio || 'Sin dirección de envío'}
            </p>
            ${bloqueCliente(d)}
            <label class="sim-lbl">Estado del pedido</label>
            ${pipeline(d, editable)}
            ${bloquePago(d, editable)}
            <div class="table-wrap" style="margin-bottom:12px">
                <table>
                    <thead><tr><th>Producto</th><th>Cant.</th><th>P. unit.</th><th>Subtotal</th><th title="Stock actual en el inventario (SCM)">Stock</th></tr></thead>
                    <tbody>${d.items.map((i) => `
                        <tr>
                            <td>${i.nombre}${i.garantia_plan ? `<div style="font-size:.74rem;color:var(--text-muted)">${i.garantia_plan}</div>` : ''}</td>
                            <td class="mono">${i.cantidad}</td>
                            <td class="mono">${formatoMoneda(i.precio_unitario)}</td>
                            <td class="mono">${formatoMoneda(i.subtotal)}</td>
                            <td class="mono ${i.stock === 0 ? 'stock-out' : i.stock <= i.stock_minimo ? 'stock-low' : 'stock-ok'}">${i.stock}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            ${fila('Subtotal', formatoMoneda(d.subtotal))}
            ${fila('IVA', formatoMoneda(d.impuestos), 'color:var(--text-muted)')}
            ${fila('Envío', Number(d.envio) === 0 ? 'Gratis' : formatoMoneda(d.envio), 'color:var(--text-muted)')}
            ${Number(d.descuento) > 0 ? fila('Descuento Club de puntos', '-' + formatoMoneda(d.descuento), 'color:var(--success)') : ''}
            ${fila('Total', formatoMoneda(d.total), 'font-weight:700;font-size:1.05rem')}
            ${d.notas ? `<p style="margin:10px 0 0;font-size:.84rem;color:var(--text-muted)">Notas: ${d.notas}</p>` : ''}
            ${d.garantias && d.garantias.length ? `<p style="margin:10px 0 0;font-size:.8rem;color:var(--text-muted)">Garantías: ${d.garantias.map((g) => `${g.folio} (${g.estado})`).join(', ')}</p>` : ''}
            ${bloqueProcesos(d)}
            ${bloqueMovimientos(d)}
            <a class="btn btn-outline btn-sm" style="width:100%;margin-top:14px" href="/admin/recibo.html?id=${d.id}" target="_blank" rel="noopener">Ver comprobante</a>
        `;
    }

    async function refrescar(mensaje) {
        if (mensaje) toast(mensaje, 'ok');
        await abrir(actual.id);
        if (onCambio) onCambio();
    }

    async function mover(destino) {
        const d = actual;
        if (destino === d.estado) return;
        if (destino === 'pendiente') { toast('Un pedido confirmado no regresa a "pendiente"', 'warn'); return; }
        if (d.pago_estado !== 'pagado') {
            if (await confirmar('Este pedido todavía no está pagado. ¿Registrar el pago ahora para poder avanzarlo?', { okText: 'Registrar pago' })) registrarPago(true);
            return;
        }
        if (FLUJO.indexOf(destino) < FLUJO.indexOf(d.estado) &&
            !(await confirmar(`¿Regresar el pedido a "${destino}"?`, { okText: 'Regresar' }))) return;
        try {
            await api(`/admin/pedidos/${d.id}/estado`, { method: 'PUT', body: { estado: destino } });
            refrescar(`Estado actualizado a "${destino}"`);
        } catch (e) { toast(e.message, 'error'); }
    }

    async function cancelar() {
        const d = actual;
        if (!(await confirmar(`¿Cancelar ${d.numero_orden}? Se regresa el stock al inventario (con su movimiento), se cancelan sus garantías y se ajustan los puntos del cliente.`, { okText: 'Cancelar pedido', peligro: true }))) return;
        try {
            const r = await api(`/admin/pedidos/${d.id}/estado`, { method: 'PUT', body: { estado: 'cancelado' } });
            refrescar(r.message);
        } catch (e) { toast(e.message, 'error'); }
    }

    async function registrarPago(yaConfirmado) {
        const d = actual;
        if (!yaConfirmado && !(await confirmar('Confirmas que se recibió el pago. El pedido pasa a "Confirmado" y el cliente recibe sus puntos.', { okText: 'Sí, registrar pago' }))) return;
        try {
            const r = await api(`/admin/pedidos/${d.id}/registrar-pago`, { method: 'POST' });
            refrescar(r.message + (r.puntos_ganados ? ` (+${r.puntos_ganados} puntos)` : ''));
        } catch (e) { toast(e.message, 'error'); }
    }

    async function historial() {
        const el = document.getElementById('mgp-historial');
        if (el.innerHTML) { el.innerHTML = ''; return; }
        el.innerHTML = '<p style="font-size:.8rem;color:var(--text-muted)">Cargando…</p>';
        try {
            const lista = await api(`/admin/clientes/${actual.cliente_id}/pedidos`);
            el.innerHTML = `<div class="table-wrap" style="margin-top:6px"><table><tbody>${lista.map((p) => `
                <tr style="cursor:pointer;${p.id === actual.id ? 'font-weight:700' : ''}" onclick="GestionPedido.abrir(${p.id})">
                    <td class="mono" style="font-size:.8rem">${p.numero_orden}</td>
                    <td style="font-size:.78rem">${formatoFecha(p.fecha_pedido)}</td>
                    <td class="mono">${formatoMoneda(p.total)}</td>
                    <td><span class="estado-pill e-${p.estado}">${p.estado}</span></td>
                </tr>`).join('')}</tbody></table></div>`;
        } catch (e) { el.innerHTML = `<p style="font-size:.8rem;color:var(--danger)">${e.message}</p>`; }
    }

    window.GestionPedido = { abrir, cerrar, mover, cancelar, registrarPago: () => registrarPago(false), historial };
})();
