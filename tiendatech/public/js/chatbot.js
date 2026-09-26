// public/js/chatbot.js
// Widget de chatbot flotante, disponible en todas las páginas de la tienda.
// Flujo: pregunta el uso -> equipo ya armado (categoría + presupuesto) o
// armar por piezas (presupuesto + componentes compatibles, uno por uno) ->
// llama /api/chatbot/recomendar o filtra componentes -> tarjetas con
// "+ Carrito" que también sirven de seguimiento en el propio chat.

(function () {
    const USOS = [
        { valor: 'gaming', etiqueta: 'Gaming' },
        { valor: 'oficina', etiqueta: 'Oficina' },
        { valor: 'diseno', etiqueta: 'Diseño' },
        { valor: 'programacion', etiqueta: 'Programación' },
        { valor: 'estudiante', etiqueta: 'Estudiante' },
        { valor: 'streaming', etiqueta: 'Streaming' },
    ];
    const PRESUPUESTOS = [8000, 15000, 25000, 40000];

    // Piezas de un armado por componentes, en el orden en que se preguntan
    // (así cada una ya puede filtrarse por lo que se eligió antes).
    const SLOTS_ARMADO = [
        { tipo: 'placa_base', label: 'la placa base', requerido: true },
        { tipo: 'cpu', label: 'el procesador', requerido: true },
        { tipo: 'ram', label: 'la memoria RAM', requerido: true },
        { tipo: 'gpu', label: 'la tarjeta gráfica', requerido: false },
        { tipo: 'almacenamiento', label: 'el almacenamiento', requerido: true },
        { tipo: 'fuente', label: 'la fuente de poder', requerido: true },
        { tipo: 'gabinete', label: 'el gabinete', requerido: true },
    ];

    let estado = { uso: null, presupuesto: null, categoria: null };
    let CATEGORIAS = [];

    let modoArmado = false;
    let COMPONENTES_ARMADO = null;
    let ELEGIDO_ARMADO = {};
    let PRESUPUESTO_RESTANTE = null;

    function formatoRankArmado(f) { return f === 'ATX' ? 2 : f === 'MicroATX' ? 1 : 0; }
    function coincideUsoArmado(p, uso) { return !!(uso && p.uso_recomendado && p.uso_recomendado.includes(uso)); }

    // Candidatos de un tipo de componente que son compatibles con lo ya
    // elegido en pasos anteriores (socket, tipo de RAM, formato, potencia).
    function candidatosArmado(tipo) {
        let lista = (COMPONENTES_ARMADO[tipo] || []).filter((p) => p.stock > 0);
        const placa = ELEGIDO_ARMADO.placa_base;
        const cpu = ELEGIDO_ARMADO.cpu;
        const gpu = ELEGIDO_ARMADO.gpu;
        if (tipo === 'cpu' && placa) lista = lista.filter((c) => c.socket === placa.socket);
        if (tipo === 'ram' && placa) lista = lista.filter((r) => r.ram_tipo === placa.ram_tipo);
        if (tipo === 'gabinete' && placa) lista = lista.filter((g) => formatoRankArmado(g.formato) >= formatoRankArmado(placa.formato));
        if (tipo === 'fuente') {
            const consumo = (cpu ? cpu.consumo_w || 0 : 0) + (gpu ? gpu.consumo_w || 0 : 0) + 120;
            lista = lista.filter((f) => f.potencia_w >= consumo);
        }
        return lista;
    }

    function crearWidget() {
        const toggle = document.createElement('button');
        toggle.id = 'chatbot-toggle';
        toggle.innerHTML = window.icon ? icon('chat', 24) : '';
        toggle.title = 'Asistente de compra';
        toggle.setAttribute('aria-label', 'Abrir asistente de compra');

        const panel = document.createElement('div');
        panel.id = 'chatbot-panel';
        panel.innerHTML = `
            <div class="chatbot-header">
                <strong>Asistente TiendaTech</strong>
                <button class="modal-close" id="chatbot-close" aria-label="Cerrar">${window.icon ? icon('x', 18) : ''}</button>
            </div>
            <div class="chatbot-body" id="chatbot-body"></div>
            <div class="chatbot-quick" id="chatbot-quick"></div>
            <div class="chatbot-input">
                <input type="text" id="chatbot-text" placeholder="Escribe presupuesto o lo que buscas..." />
                <button id="chatbot-send">Enviar</button>
            </div>
        `;

        document.body.appendChild(toggle);
        document.body.appendChild(panel);

        toggle.addEventListener('click', () => {
            panel.classList.toggle('open');
            quitarNudge();
            if (panel.classList.contains('open') && !panel.dataset.iniciado) {
                panel.dataset.iniciado = '1';
                iniciarConversacion();
            }
        });
        panel.querySelector('#chatbot-close').addEventListener('click', () => panel.classList.remove('open'));

        // Aviso de primera visita: "hay un asesor por si no sabes qué elegir"
        let visto = false;
        try { visto = localStorage.getItem('tt_asesor_visto') === '1'; } catch (e) {}
        if (!visto) {
            const nudge = document.createElement('div');
            nudge.className = 'chatbot-nudge';
            nudge.innerHTML = `<button aria-label="Cerrar">${window.icon ? icon('x', 14) : '×'}</button>
                ¿No sabes qué comprar? Pregúntame según tu presupuesto y te digo qué hay disponible.`;
            document.body.appendChild(nudge);
            setTimeout(() => nudge.classList.add('show'), 1200);
            nudge.querySelector('button').addEventListener('click', quitarNudge);
            setTimeout(quitarNudge, 12000);
        }
        function quitarNudge() {
            const n = document.querySelector('.chatbot-nudge');
            if (n) { n.classList.remove('show'); setTimeout(() => n.remove(), 300); }
            try { localStorage.setItem('tt_asesor_visto', '1'); } catch (e) {}
        }
        panel.querySelector('#chatbot-send').addEventListener('click', enviarTexto);
        panel.querySelector('#chatbot-text').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') enviarTexto();
        });
    }

    function agregarMensaje(texto, tipo = 'bot') {
        const body = document.getElementById('chatbot-body');
        const div = document.createElement('div');
        div.className = `chat-msg ${tipo}`;
        div.textContent = texto;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
    }

    function mostrarChips(opciones, onClick) {
        const quick = document.getElementById('chatbot-quick');
        quick.innerHTML = '';
        opciones.forEach((op) => {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.textContent = op.etiqueta || op;
            chip.addEventListener('click', () => onClick(op.valor !== undefined ? op.valor : op));
            quick.appendChild(chip);
        });
    }

    async function cargarCategorias() {
        if (CATEGORIAS.length) return;
        try { CATEGORIAS = await api('/categorias'); } catch { CATEGORIAS = []; }
    }

    function iniciarConversacion() {
        estado = { uso: null, presupuesto: null, categoria: null };
        modoArmado = false;
        ELEGIDO_ARMADO = {};
        PRESUPUESTO_RESTANTE = null;
        agregarMensaje('¡Hola! Puedo ayudarte a encontrar el equipo ideal. Escríbeme con tus palabras lo que buscas (por ejemplo "una laptop para diseño con 20 mil pesos" o "quiero armar mi propia PC") o elige una opción:');
        mostrarChips(USOS, (uso) => {
            estado.uso = uso;
            agregarMensaje(USOS.find((u) => u.valor === uso).etiqueta, 'user');
            preguntarModo();
        });
    }

    function preguntarModo() {
        agregarMensaje('¿Buscas un equipo ya armado o prefieres elegir tú mismo los componentes? Si es por piezas, te voy recomendando una por una y reviso que sean compatibles entre sí.');
        mostrarChips([
            { valor: 'armado', etiqueta: 'Equipo ya armado' },
            { valor: 'piezas', etiqueta: 'Armar mi propia PC' },
        ], (modo) => {
            agregarMensaje(modo === 'piezas' ? 'Armar mi propia PC' : 'Equipo ya armado', 'user');
            if (modo === 'piezas') iniciarArmado();
            else preguntarCategoria();
        });
    }

    async function preguntarCategoria() {
        await cargarCategorias();
        if (!CATEGORIAS.length) return preguntarPresupuesto();
        agregarMensaje('¿Buscas algo en particular?');
        const opciones = [{ valor: '', etiqueta: 'Cualquier tipo' }]
            .concat(CATEGORIAS.map((c) => ({ valor: c.nombre, etiqueta: c.nombre })));
        mostrarChips(opciones, (categoria) => {
            estado.categoria = categoria || null;
            agregarMensaje(categoria || 'Cualquier tipo', 'user');
            preguntarPresupuesto();
        });
    }

    function preguntarPresupuesto() {
        agregarMensaje('Perfecto. ¿Cuál es tu presupuesto aproximado?');
        mostrarChips(PRESUPUESTOS.map((p) => ({ valor: p, etiqueta: `Hasta $${p.toLocaleString('es-MX')}` })), (presupuesto) => {
            estado.presupuesto = presupuesto;
            agregarMensaje(`Hasta $${Number(presupuesto).toLocaleString('es-MX')}`, 'user');
            buscarRecomendaciones();
        });
    }

    async function buscarRecomendaciones(mensajeLibre) {
        document.getElementById('chatbot-quick').innerHTML = '';
        agregarMensaje('Buscando en inventario disponible...', 'bot');
        try {
            const cliente = window.Sesion ? Sesion.cliente() : null;
            const data = await api('/chatbot/recomendar', {
                method: 'POST',
                body: {
                    uso: estado.uso,
                    presupuesto: estado.presupuesto,
                    categoria: estado.categoria,
                    mensaje: mensajeLibre || null,
                    cliente_id: cliente ? cliente.id : null,
                },
            });
            agregarMensaje(data.respuesta, 'bot');
            const body = document.getElementById('chatbot-body');
            data.sugerencias.forEach((p) => {
                const card = document.createElement('div');
                card.className = 'chat-suggestion';
                card.innerHTML = `
                    <img src="${p.imagen_url || '/img/producto.svg'}" referrerpolicy="no-referrer" alt="${p.nombre}" onerror="this.onerror=null;this.src='/img/producto.svg'" />
                    <div style="flex:1">
                        <div class="name">${p.nombre}</div>
                        <div class="price">${formatoMoneda(p.precio)} · stock: ${p.stock}</div>
                        <div class="chat-sug-actions">
                            <button class="chip" data-ver>Ver ficha</button>
                            <button class="chip" data-add ${p.stock === 0 ? 'disabled' : ''}>+ Carrito</button>
                        </div>
                    </div>
                `;
                card.querySelector('[data-ver]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.location.href = `/index.html#producto-${p.id}`;
                });
                card.querySelector('[data-add]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const cli = window.Sesion ? Sesion.cliente() : null;
                    if (!cli) { window.irALogin ? irALogin() : (location.href = '/login.html'); return; }
                    try {
                        await api('/carrito', { method: 'POST', body: { cliente_id: cli.id, producto_id: p.id, cantidad: 1 } });
                        if (window.actualizarBadgeCarrito) actualizarBadgeCarrito();
                        window.toast ? toast('Agregado al carrito', 'ok') : agregarMensaje('Agregado al carrito', 'bot');
                    } catch (err) {
                        window.toast ? toast(err.message, 'error') : agregarMensaje(err.message, 'bot');
                    }
                });
                card.querySelector('img').addEventListener('click', () => { window.location.href = `/index.html#producto-${p.id}`; });
                body.appendChild(card);
            });
            body.scrollTop = body.scrollHeight;
            mostrarChips([{ etiqueta: 'Buscar otra vez' }], () => {
                iniciarConversacion();
            });
        } catch (err) {
            agregarMensaje('Tuve un problema buscando recomendaciones. Intenta de nuevo en un momento.');
        }
    }

    // ---------------------------------------------------------------
    // Armar por piezas: misma idea que /armar-pc.html, pero conversacional
    // — una pieza a la vez, con seguimiento en el propio chat y "+ Carrito"
    // en cada sugerencia. El uso ya elegido y el presupuesto restante
    // ordenan las opciones; la compatibilidad con lo ya elegido las filtra.
    // ---------------------------------------------------------------
    function iniciarArmado() {
        modoArmado = true;
        ELEGIDO_ARMADO = {};
        document.getElementById('chatbot-quick').innerHTML = '';
        if (!estado.uso) {
            agregarMensaje('Vamos a armarla pieza por pieza. Primero, ¿para qué la vas a usar?');
            mostrarChips(USOS, (uso) => {
                estado.uso = uso;
                agregarMensaje(USOS.find((u) => u.valor === uso).etiqueta, 'user');
                preguntarPresupuestoArmado();
            });
        } else {
            agregarMensaje('Vamos a armarla pieza por pieza.');
            preguntarPresupuestoArmado();
        }
    }

    function preguntarPresupuestoArmado() {
        agregarMensaje('¿Cuál es tu presupuesto total aproximado para todo el equipo?');
        const opciones = PRESUPUESTOS.map((p) => ({ valor: p, etiqueta: `Hasta $${p.toLocaleString('es-MX')}` }))
            .concat([{ valor: 0, etiqueta: 'Sin límite definido' }]);
        mostrarChips(opciones, async (presupuesto) => {
            estado.presupuesto = presupuesto || null;
            PRESUPUESTO_RESTANTE = presupuesto || null;
            agregarMensaje(presupuesto ? `Hasta $${Number(presupuesto).toLocaleString('es-MX')}` : 'Sin límite definido', 'user');
            agregarMensaje('Buscando piezas compatibles en inventario…');
            await cargarComponentesArmado();
            avanzarSlotArmado();
        });
    }

    async function cargarComponentesArmado() {
        if (COMPONENTES_ARMADO) return;
        try {
            const productos = await api('/productos?categoria=Componentes');
            COMPONENTES_ARMADO = {};
            productos.forEach((p) => {
                if (!p.tipo_componente) return;
                (COMPONENTES_ARMADO[p.tipo_componente] = COMPONENTES_ARMADO[p.tipo_componente] || []).push(p);
            });
        } catch {
            COMPONENTES_ARMADO = {};
        }
    }

    function avanzarSlotArmado() {
        const slot = SLOTS_ARMADO.find((s) => !(s.tipo in ELEGIDO_ARMADO));
        if (!slot) return finalizarArmado();
        mostrarSugerenciasSlot(slot);
    }

    function mostrarSugerenciasSlot(slot) {
        document.getElementById('chatbot-quick').innerHTML = '';
        const candidatos = candidatosArmado(slot.tipo);

        if (!candidatos.length) {
            agregarMensaje(`No tengo ${slot.label} compatible con lo que llevas, disponible en stock ahora mismo.`);
            mostrarChips([{ etiqueta: slot.requerido ? 'Continuar sin esta pieza' : 'Omitir (gráficos integrados)' }], () => {
                ELEGIDO_ARMADO[slot.tipo] = null;
                avanzarSlotArmado();
            });
            return;
        }

        // Compatible primero por área de uso, luego por precio (más barato
        // primero entre igual de relevantes) — así se respeta el presupuesto.
        const orden = [...candidatos].sort((a, b) =>
            (coincideUsoArmado(b, estado.uso) - coincideUsoArmado(a, estado.uso)) || (a.precio - b.precio)
        );
        const top = orden.slice(0, 3);

        const restanteTxt = PRESUPUESTO_RESTANTE ? ` (te quedan ${formatoMoneda(PRESUPUESTO_RESTANTE)} de presupuesto)` : '';
        agregarMensaje(`Elige ${slot.label}${restanteTxt}:`);

        const body = document.getElementById('chatbot-body');
        top.forEach((p) => {
            const detalle = [p.socket, p.ram_tipo, p.formato, p.consumo_w ? `${p.consumo_w}W` : null, p.potencia_w ? `${p.potencia_w}W` : null]
                .filter(Boolean).join(' · ');
            const sobrePresupuesto = PRESUPUESTO_RESTANTE && Number(p.precio) > PRESUPUESTO_RESTANTE;
            const card = document.createElement('div');
            card.className = 'chat-suggestion';
            card.innerHTML = `
                <img src="${p.imagen_url || '/img/producto.svg'}" referrerpolicy="no-referrer" alt="${p.nombre}" onerror="this.onerror=null;this.src='/img/producto.svg'" />
                <div style="flex:1">
                    <div class="name">${p.nombre}</div>
                    ${detalle ? `<div style="font-size:.72rem;color:var(--text-muted)">${detalle}</div>` : ''}
                    <div class="price">${formatoMoneda(p.precio)}${sobrePresupuesto ? ' · sobre tu presupuesto' : ''}</div>
                    <div class="chat-sug-actions">
                        <button class="chip" data-elegir>Elegir y agregar</button>
                    </div>
                </div>
            `;
            card.querySelector('[data-elegir]').addEventListener('click', () => elegirComponenteArmado(slot, p));
            body.appendChild(card);
        });

        if (!slot.requerido) {
            mostrarChips([{ etiqueta: 'Omitir (gráficos integrados)' }], () => {
                ELEGIDO_ARMADO[slot.tipo] = null;
                avanzarSlotArmado();
            });
        }
        body.scrollTop = body.scrollHeight;
    }

    async function elegirComponenteArmado(slot, producto) {
        const cli = window.Sesion ? Sesion.cliente() : null;
        if (!cli) { window.irALogin ? irALogin() : (location.href = '/login.html'); return; }
        try {
            await api('/carrito', { method: 'POST', body: { producto_id: producto.id, cantidad: 1 } });
            if (window.actualizarBadgeCarrito) actualizarBadgeCarrito();
            ELEGIDO_ARMADO[slot.tipo] = producto;
            if (PRESUPUESTO_RESTANTE) PRESUPUESTO_RESTANTE = Math.max(0, PRESUPUESTO_RESTANTE - Number(producto.precio));
            agregarMensaje(`${producto.nombre} — agregado al carrito`, 'user');
            avanzarSlotArmado();
        } catch (err) {
            window.toast ? toast(err.message, 'error') : agregarMensaje(err.message, 'bot');
        }
    }

    function finalizarArmado() {
        const piezas = Object.values(ELEGIDO_ARMADO).filter(Boolean);
        const total = piezas.reduce((s, p) => s + Number(p.precio), 0);
        agregarMensaje(
            piezas.length
                ? `Tu PC quedó armada y ya está en el carrito: ${piezas.length} piezas por ${formatoMoneda(total)} en total, todas compatibles entre sí.`
                : 'No se agregó ninguna pieza al carrito.',
            'bot'
        );
        document.getElementById('chatbot-quick').innerHTML = '';
        mostrarChips([
            { valor: 'carrito', etiqueta: 'Ir al carrito' },
            { valor: 'reiniciar', etiqueta: 'Empezar de nuevo' },
        ], (accion) => {
            if (accion === 'carrito') location.href = '/carrito.html';
            else iniciarConversacion();
        });
        modoArmado = false;
    }

    function pareceIntencionDeArmado(texto) {
        const t = texto.toLowerCase();
        return ['armar', 'ensamblar', 'mis propios componentes', 'elegir mis componentes', 'pieza por pieza', 'compatibles entre'].some((k) => t.includes(k));
    }

    function enviarTexto() {
        const input = document.getElementById('chatbot-text');
        const texto = input.value.trim();
        if (!texto) return;
        agregarMensaje(texto, 'user');
        input.value = '';

        if (modoArmado) {
            agregarMensaje('Usa las tarjetas o botones de arriba para elegir esta pieza y seguir con la siguiente.');
            return;
        }
        if (pareceIntencionDeArmado(texto)) {
            iniciarArmado();
            return;
        }
        // El servidor interpreta uso, presupuesto, categoría y palabras clave
        // directamente del texto libre, así que se manda tal cual.
        buscarRecomendaciones(texto);
    }

    document.addEventListener('DOMContentLoaded', crearWidget);
})();
