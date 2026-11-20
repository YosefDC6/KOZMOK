// public/admin/js/interaccion-sim.js
// "Nueva interacción" del CRM. Nada es simulado: cada tipo corresponde a
// algo que pasa de verdad y el servidor lo registra con su fecha.
//   llamada  -> se marca desde el teléfono (enlace tel:) y se registra el
//               resultado, la duración y las notas.
//   correo   -> se envía de verdad con el Gmail de la tienda.
//   reunion  -> se agenda y el cliente recibe la invitación por correo.
//   soporte  -> abre un ticket que el cliente ve en su cuenta.
//   (los chats se registran solos cuando el cliente usa el asesor en línea)
//
//   simuladorInteraccion({
//     cliente:  { id, nombre, correo, telefono },     // cliente fijo, o
//     clientes: [ {id,nombre,correo,telefono}, ... ], // lista para elegir
//     tipoInicial: 'llamada',
//     despues: () => { ... },                         // al registrar
//   })
(function () {
    const TIPOS = [
        { k: 'llamada', label: 'Llamada', ic: 'phone' },
        { k: 'correo',  label: 'Correo',  ic: 'mail' },
        { k: 'reunion', label: 'Reunión', ic: 'calendar' },
        { k: 'soporte', label: 'Ticket de soporte', ic: 'shield' },
    ];
    const ic = (n, s) => (window.icon ? window.icon(n, s) : '');
    const esc = (t) => (window.escHTML ? escHTML(t) : String(t ?? ''));

    let modal, cfg, cliente, tipo;

    function abrir(opts) {
        cfg = opts || {};
        cliente = cfg.cliente || (cfg.clientes && cfg.clientes[0]) || null;
        tipo = TIPOS.some((t) => t.k === cfg.tipoInicial) ? cfg.tipoInicial : 'llamada';
        if (!modal) {
            modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.id = 'sim-modal';
            modal.innerHTML = '<div class="modal sim-modal" id="sim-body"></div>';
            document.body.appendChild(modal);
        }
        modal.classList.add('open');
        render();
    }
    function cerrar() { modal.classList.remove('open'); }
    window.simuladorInteraccion = abrir;
    // Etiquetas para las listas de interacciones
    window.TIPO_INTERACCION = { llamada: 'Llamada', correo: 'Correo', reunion: 'Reunión', chat: 'Chat', soporte: 'Soporte' };
    window.quienRegistro = (i) => i.usuario_nombre || ({ chatbot: 'Asesor en línea (el cliente)', cliente: 'El cliente (Soporte)', sistema: 'Sistema' }[i.origen] || 'Sistema');

    function render() {
        const b = document.getElementById('sim-body');
        const selCliente = (cfg.clientes && !cfg.cliente)
            ? `<div class="field"><label>Cliente</label>
                 <select id="sim-cli" onchange="__simSetCliente(this.value)">
                   ${cfg.clientes.map((c) => `<option value="${c.id}" ${cliente && c.id === cliente.id ? 'selected' : ''}>${esc(c.nombre)} — ${esc(c.correo || '')}</option>`).join('')}
                 </select>
               </div>`
            : `<p class="sim-cli-fijo">${ic('user', 14)} ${esc(cliente ? cliente.nombre : '')}</p>`;

        b.innerHTML = `
            <button class="modal-close" onclick="__simCerrar()">${ic('x', 18)}</button>
            <h3>Nueva interacción</h3>
            ${selCliente}
            <div class="sim-tipos">
                ${TIPOS.map((t) => `<button class="sim-tipo ${t.k === tipo ? 'on' : ''}" onclick="__simTipo('${t.k}')">${ic(t.ic, 16)} ${t.label}</button>`).join('')}
            </div>
            <div class="sim-panel" id="sim-panel"></div>
            <p class="sim-nota">Los chats se registran solos cuando el cliente usa el asesor en línea de la tienda.</p>
        `;
        panel();
    }

    window.__simCerrar = cerrar;
    window.__simTipo = (t) => {
        if (!TIPOS.some((x) => x.k === t)) return;
        tipo = t;
        document.querySelectorAll('.sim-tipo').forEach((el, i) => el.classList.toggle('on', TIPOS[i].k === t));
        panel();
    };
    window.__simSetCliente = (id) => { cliente = cfg.clientes.find((c) => String(c.id) === String(id)); panel(); };

    // Manda la interacción al servidor (él arma la descripción y pone la fecha)
    async function registrar(datos, btn) {
        if (!cliente) { toast('Elige un cliente', 'warn'); return; }
        if (btn) { btn.disabled = true; btn.dataset.txt = btn.textContent; btn.textContent = 'Guardando…'; }
        try {
            const r = await api('/admin/interacciones', { method: 'POST', body: { cliente_id: cliente.id, tipo, ...datos } });
            toast(r.message || 'Interacción registrada', 'ok');
            cerrar();
            if (cfg.despues) cfg.despues();
        } catch (e) { toast(e.message || 'No se pudo registrar', 'error'); }
        finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.txt; } }
    }

    function panel() {
        const p = document.getElementById('sim-panel');
        if (!p) return;
        if (tipo === 'llamada') p.innerHTML = panelLlamada();
        else if (tipo === 'correo') p.innerHTML = panelCorreo();
        else if (tipo === 'reunion') p.innerHTML = panelReunion();
        else p.innerHTML = panelSoporte();
    }

    /* ---------- LLAMADA (se hace desde el teléfono) ---------- */
    function panelLlamada() {
        const tel = cliente && cliente.telefono;
        const telLimpio = tel ? String(tel).replace(/[^\d+]/g, '') : '';
        return `
            <div class="sim-call">
                <div class="sc-num">${ic('phone', 22)}<span>${esc(tel || 'Sin teléfono registrado')}</span></div>
                ${tel ? `<a class="btn btn-outline" style="width:100%" href="tel:${telLimpio}">${ic('phone', 16)} Llamar desde mi teléfono</a>
                    <p class="sim-ayuda">Abre la app de llamadas de tu computadora o celular. Al terminar, registra cómo te fue.</p>` : '<p class="sim-ayuda">Agrega el teléfono en los datos del cliente para poder llamarle.</p>'}
                <label class="sim-lbl">¿Cómo terminó?</label>
                <div class="sim-chips" id="sc-res">
                    ${[['contesto', 'Contestó'], ['no_contesto', 'No contestó'], ['buzon', 'Buzón de voz'], ['equivocado', 'Número equivocado']]
                        .map(([k, t], i) => `<button class="sim-chip ${i === 0 ? 'on' : ''}" data-v="${k}" onclick="__simPick(this,'sc-res');__simDur()">${t}</button>`).join('')}
                </div>
                <div class="field" id="sc-dur-f"><label>Duración (minutos)</label><input type="number" id="sc-dur" min="1" max="600" step="1" placeholder="Ej. 8" /></div>
                <div class="field"><label>Notas</label><textarea id="sc-notas" rows="3" placeholder="Qué se habló, acuerdos y siguiente paso…"></textarea></div>
                <button class="btn btn-primary" style="width:100%" onclick="__simCallSave(this)">Registrar llamada</button>
            </div>`;
    }
    window.__simDur = () => {
        const v = document.querySelector('#sc-res .sim-chip.on')?.dataset.v;
        document.getElementById('sc-dur-f').hidden = v !== 'contesto';
    };
    window.__simCallSave = (btn) => {
        const resultado = document.querySelector('#sc-res .sim-chip.on')?.dataset.v;
        const duracion_min = Number(document.getElementById('sc-dur').value || 0);
        const notas = document.getElementById('sc-notas').value.trim();
        if (resultado === 'contesto' && !(duracion_min >= 1)) return toast('Indica cuántos minutos duró', 'warn');
        if (resultado === 'contesto' && notas.length < 10) return toast('Anota de qué se habló (al menos 10 caracteres)', 'warn');
        registrar({ resultado, duracion_min, notas }, btn);
    };

    /* ---------- CORREO ---------- */
    const PLANTILLAS = {
        '': { asunto: '', cuerpo: '' },
        seguimiento: { asunto: 'Seguimiento a tu compra en Kozmok', cuerpo: 'Hola {nombre},\n\nQueremos saber si todo salió bien con tu pedido y si necesitas ayuda con la instalación o configuración.\n\nQuedamos atentos.\nEquipo Kozmok' },
        cotizacion: { asunto: 'Cotización solicitada', cuerpo: 'Hola {nombre},\n\nTe compartimos la cotización de los equipos que revisamos:\n\n- Producto: $0.00\n\nLos precios son válidos por 15 días y el envío es gratis en compras mayores a $10,000.\n\nSaludos,\nEquipo Kozmok' },
        bienvenida: { asunto: 'Bienvenido al Club Kozmok', cuerpo: 'Hola {nombre},\n\nTu cuenta ya está activa. Con cada compra acumulas puntos que valen dinero en la tienda y puedes seguir tus pedidos desde tu perfil.\n\n¡Gracias por elegirnos!' },
        recordatorio: { asunto: 'Recordatorio de pago pendiente', cuerpo: 'Hola {nombre},\n\nTu pedido está apartado y solo falta completar el pago con la referencia que te compartimos. Si ya lo realizaste, ignora este mensaje.\n\nGracias.' },
    };
    function panelCorreo() {
        return `
            <div class="sim-mail">
                <div class="field"><label>Para</label><input value="${esc((cliente && cliente.correo) || '')}" readonly /></div>
                <div class="field"><label>Plantilla</label>
                    <select id="sm-plantilla" onchange="__simPlantilla()">
                        <option value="">Escribir desde cero</option>
                        <option value="seguimiento">Seguimiento post-venta</option>
                        <option value="cotizacion">Envío de cotización</option>
                        <option value="bienvenida">Bienvenida / alta de cuenta</option>
                        <option value="recordatorio">Recordatorio de pago</option>
                    </select>
                </div>
                <div class="field"><label>Asunto</label><input id="sm-asunto" /></div>
                <div class="field"><label>Mensaje</label><textarea id="sm-cuerpo" rows="6"></textarea></div>
                <button class="btn btn-primary" style="width:100%" onclick="__simMailSend(this)">${ic('chat', 15)} Enviar correo</button>
            </div>`;
    }
    window.__simPlantilla = () => {
        const t = PLANTILLAS[document.getElementById('sm-plantilla').value] || PLANTILLAS[''];
        const nom = cliente ? cliente.nombre.split(' ')[0] : '';
        document.getElementById('sm-asunto').value = t.asunto;
        document.getElementById('sm-cuerpo').value = t.cuerpo.replace('{nombre}', nom);
    };
    // El correo se manda de verdad al cliente (Gmail de la tienda); el
    // servidor lo registra como interacción solo si salió.
    window.__simMailSend = async (btn) => {
        const asunto = document.getElementById('sm-asunto').value.trim();
        const cuerpo = document.getElementById('sm-cuerpo').value.trim();
        if (!cliente) { toast('Elige un cliente', 'warn'); return; }
        if (!asunto) { toast('Escribe el asunto', 'warn'); return; }
        if (!cuerpo) { toast('Escribe el mensaje', 'warn'); return; }
        if (btn) { btn.disabled = true; btn.dataset.txt = btn.textContent; btn.textContent = 'Enviando…'; }
        try {
            const r = await api(`/admin/clientes/${cliente.id}/correo`, { method: 'POST', body: { asunto, cuerpo } });
            toast(r.message, r.estado === 'enviado' || r.estado === 'pendiente' ? 'ok' : 'warn');
            if (r.estado === 'error') return;
            cerrar();
            if (cfg.despues) cfg.despues();
        } catch (e) {
            toast(e.message, 'error');
        } finally {
            if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.txt; }
        }
    };

    /* ---------- REUNIÓN (invitación real por correo) ---------- */
    function panelReunion() {
        const man = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        return `
            <div class="sim-meet">
                <div class="field-row">
                    <div class="field"><label>Fecha</label><input type="date" id="sr-fecha" min="${new Date().toISOString().slice(0, 10)}" value="${man}" /></div>
                    <div class="field"><label>Hora</label><input type="time" id="sr-hora" value="10:00" /></div>
                </div>
                <div class="field"><label>Modalidad</label>
                    <select id="sr-mod"><option>Videollamada</option><option>Presencial</option><option>Teléfono</option></select>
                </div>
                <div class="field"><label>Tema de la reunión</label><textarea id="sr-agenda" rows="3" placeholder="Equipos de interés, presupuesto, dudas a resolver…"></textarea></div>
                <p class="sim-ayuda">${ic('mail', 13)} Se le envía la invitación a ${esc((cliente && cliente.correo) || 'su correo')} con la fecha, la modalidad y tu nombre.</p>
                <button class="btn btn-primary" style="width:100%" onclick="__simMeetSave(this)">${ic('calendar', 15)} Agendar y enviar invitación</button>
            </div>`;
    }
    window.__simMeetSave = (btn) => {
        const fecha = document.getElementById('sr-fecha').value;
        const hora = document.getElementById('sr-hora').value;
        const modalidad = document.getElementById('sr-mod').value;
        const agenda = document.getElementById('sr-agenda').value.trim();
        if (!fecha || !hora) return toast('Elige fecha y hora', 'warn');
        if (new Date(fecha + 'T' + hora) < new Date()) return toast('La reunión debe ser en una fecha futura', 'warn');
        if (agenda.length < 10) return toast('Escribe el tema de la reunión (al menos 10 caracteres)', 'warn');
        registrar({ fecha, hora, modalidad, agenda }, btn);
    };

    /* ---------- SOPORTE (ticket real) ---------- */
    function panelSoporte() {
        return `
            <div class="sim-sop">
                <div class="field-row">
                    <div class="field" style="flex:2"><label>Asunto</label><input id="ss-asunto" maxlength="160" placeholder="Ej. Seguimiento a tu garantía" /></div>
                    <div class="field"><label>Prioridad</label>
                        <select id="ss-prio"><option value="media">Media</option><option value="alta">Alta</option><option value="baja">Baja</option></select></div>
                </div>
                <div class="field"><label>Mensaje para el cliente</label><textarea id="ss-msg" rows="4" placeholder="Lo que el cliente va a leer en su cuenta…"></textarea></div>
                <p class="sim-ayuda">Se abre un ticket con folio que el cliente ve y puede responder en Soporte; también le llega un aviso por correo. El seguimiento sigue en el <a href="/admin/soporte.html">gestor de tickets</a>.</p>
                <button class="btn btn-primary" style="width:100%" onclick="__simSopSave(this)">Abrir ticket</button>
            </div>`;
    }
    window.__simSopSave = (btn) => {
        const asunto = document.getElementById('ss-asunto').value.trim();
        const mensaje = document.getElementById('ss-msg').value.trim();
        if (asunto.length < 5) return toast('Escribe el asunto', 'warn');
        if (mensaje.length < 10) return toast('Escribe el mensaje (al menos 10 caracteres)', 'warn');
        registrar({ asunto, mensaje, prioridad: document.getElementById('ss-prio').value }, btn);
    };

    /* ---------- util chips ---------- */
    window.__simPick = (el, cont) => {
        document.querySelectorAll('#' + cont + ' .sim-chip').forEach((c) => c.classList.remove('on'));
        el.classList.add('on');
    };
})();
