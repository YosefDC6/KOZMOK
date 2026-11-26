// public/js/api.js
// Helper compartido para llamadas a la API y manejo de sesión.

const API_BASE = '/api';

// Dirección del panel (la pone el servidor en cada pantalla del panel;
// en la tienda no existe).
const RUTA_PANEL = (document.querySelector('meta[name="kz-panel"]') || {}).content || '';
async function api(path, options = {}) {
    // Etapa 5: la sesión viaja sola en una cookie HttpOnly (kz_sesion en la
    // tienda, kz_admin en el panel) que el JavaScript no puede leer, así
    // que un script inyectado tampoco puede robarla. Las pantallas del panel
    // avisan con "X-Kz-Panel" para que, si el navegador tiene las dos
    // sesiones abiertas, las rutas compartidas usen la del equipo.
    const esPanel = !!RUTA_PANEL;
    const res = await fetch(API_BASE + path, {
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
            ...(esPanel ? { 'X-Kz-Panel': '1' } : {}),
        },
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // Sesión interna vencida/ inválida -> de vuelta al login del panel
        if (res.status === 401 && RUTA_PANEL && !location.pathname.endsWith('login.html')) {
            localStorage.removeItem('kz_usuario');
            location.href = RUTA_PANEL + 'login.html';
        }
        const err = new Error(data.message || data.error || 'Error en la solicitud');
        err.status = res.status;
        err.datos = data;   // p. ej. { codigo: 'correo_no_verificado' } o { sugerencia }
        throw err;
    }
    return data;
}

// ---- Imagen de producto ----
// Si el producto no tiene imagen propia se usa una ilustración según su
// tipo (laptop, monitor, procesador...), con fondo transparente para que
// se integre con cualquier tema.
const ILUSTRACIONES = [
    [/aud[ií]fono|headset|diadema/, 'headphones'], [/webcam|c[aá]mara/, 'webcam'],
    [/mouse|rat[oó]n/, 'mouse'], [/teclado|keyboard/, 'keyboard'],
    [/fuente de poder|psu/, 'psu'], [/gabinete|case\b/, 'case'],
    [/memoria|ram\b|ddr/, 'ram'], [/ssd|nvme|disco|almacenamiento/, 'ssd'],
    [/^pc\b|escritorio|mini torre|workstation|servidor/, 'desktop'],
    [/placa base|motherboard|tarjeta madre/, 'board'], [/procesador|ryzen|intel core|cpu/, 'cpu'],
    [/tarjeta gr[aá]fica|rtx|gtx|radeon|gpu/, 'gpu'], [/monitor/, 'monitor'],
    [/laptop|macbook|notebook|port[aá]til/, 'laptop'],
    [/\bhub\b|adaptador|dock/, 'hub'],
    [/perif[eé]rico/, 'mouse'], [/accesorio/, 'headphones'], [/componente/, 'cpu'],
];
function ilustracionProducto(p) {
    const t = `${(p && p.nombre) || ''} ${(p && (p.categoria_nombre || p.categoria)) || ''}`.toLowerCase();
    const r = ILUSTRACIONES.find(([re]) => re.test(t));
    return `/img/productos/${r ? r[1] : 'generico'}.svg`;
}
function imagenProducto(p) { return (p && p.imagen_url) || ilustracionProducto(p); }

// En el navegador solo se guardan los datos para pintar la pantalla
// (nombre, correo...). La sesión real es la cookie HttpOnly del servidor.
const Sesion = {
    guardarCliente(cliente) {
        localStorage.setItem('kz_cliente', JSON.stringify(cliente));
    },
    cliente() {
        try { return JSON.parse(localStorage.getItem('kz_cliente')); } catch { return null; }
    },
    guardarUsuario(usuario) {
        localStorage.setItem('kz_usuario', JSON.stringify(usuario));
    },
    usuario() {
        try { return JSON.parse(localStorage.getItem('kz_usuario')); } catch { return null; }
    },
    // Cierra la sesión también en el servidor (la cookie copiada deja de servir).
    cerrarSesionCliente() {
        localStorage.removeItem('kz_cliente');
        if (window.Club) Club.olvidar();
        return Sesion._salir('cliente');
    },
    cerrarSesionUsuario() {
        localStorage.removeItem('kz_usuario');
        if (window.PestanaPanel) PestanaPanel.olvidar();
        return Sesion._salir('usuario');
    },
    _salir(tipo) {
        return fetch(API_BASE + '/auth/logout', {
            method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo }),
        }).catch(() => {});
    },
};
// ---- Sesión del panel por pestaña ----
// La sesión del panel dura lo que dure la pestaña: si la cierras y vuelves
// a abrir el panel, se cierra la sesión y pide entrar otra vez. Las pestañas
// que abres desde el panel mientras sigue abierto sí comparten la sesión
// (se preguntan entre ellas con BroadcastChannel).
const PestanaPanel = {
    CLAVE: 'kz_panel_pestana',
    _canal: (() => { try { return 'BroadcastChannel' in window ? new BroadcastChannel('kz-panel') : null; } catch { return null; } })(),
    tiene() { try { return sessionStorage.getItem(this.CLAVE) === '1'; } catch { return false; } },
    marcar() { try { sessionStorage.setItem(this.CLAVE, '1'); } catch { /* nada */ } this.escuchar(); },
    olvidar() { try { sessionStorage.removeItem(this.CLAVE); } catch { /* nada */ } },
    escuchar() {
        if (!this._canal || this._escuchando) return;
        this._escuchando = true;
        this._canal.addEventListener('message', (e) => { if (e.data === 'kz-panel?' && this.tiene()) this._canal.postMessage('kz-panel!'); });
    },
    otraAbierta(ms = 400) {
        return new Promise((resolver) => {
            if (!this._canal) { resolver(false); return; }
            const alResponder = (e) => { if (e.data === 'kz-panel!') { fin(true); } };
            const fin = (v) => { this._canal.removeEventListener('message', alResponder); clearTimeout(reloj); resolver(v); };
            const reloj = setTimeout(() => fin(false), ms);
            this._canal.addEventListener('message', alResponder);
            this._canal.postMessage('kz-panel?');
        });
    },
    // true si esta pestaña puede seguir con la sesión del panel.
    async verificar() {
        if (this.tiene()) { this.escuchar(); return true; }
        if (await this.otraAbierta()) { this.marcar(); return true; }
        return false;
    },
};
window.PestanaPanel = PestanaPanel;

// ---- Cuentas recordadas ----
// Al entrar con "Mantener sesión iniciada" el navegador recuerda el correo
// y el nombre (nunca la contraseña). Después de cerrar sesión, el login
// las muestra para volver a entrar con un clic. tipo: 'cliente' | 'usuario'.
const CuentasRecordadas = {
    _clave: (tipo) => (tipo === 'usuario' ? 'kz_cuentas_equipo' : 'kz_cuentas'),
    lista(tipo = 'cliente') {
        try { const l = JSON.parse(localStorage.getItem(this._clave(tipo)) || '[]'); return Array.isArray(l) ? l : []; }
        catch { return []; }
    },
    guardar(tipo, { correo, nombre }) {
        if (!correo) return;
        const c = String(correo).trim().toLowerCase();
        const l = this.lista(tipo).filter((x) => x.correo !== c);
        l.unshift({ correo: c, nombre: String(nombre || '').split(' ')[0] || c });
        try { localStorage.setItem(this._clave(tipo), JSON.stringify(l.slice(0, 3))); } catch { /* sin almacenamiento */ }
    },
    olvidar(tipo, correo) {
        const l = this.lista(tipo).filter((x) => x.correo !== String(correo).toLowerCase());
        try { localStorage.setItem(this._clave(tipo), JSON.stringify(l)); } catch { /* sin almacenamiento */ }
    },
    // Tarjetas "Continuar como…" dentro de `cont`. alElegir(cuenta) rellena el correo.
    pintar(cont, tipo, alElegir) {
        if (!cont) return;
        const l = this.lista(tipo);
        cont.hidden = !l.length;
        if (!l.length) { cont.innerHTML = ''; return; }
        const inicial = (n) => escHTML((n || '?').trim().charAt(0).toUpperCase());
        cont.innerHTML = `<p class="cr-titulo">${l.length > 1 ? 'Elige una cuenta' : 'Continuar con tu cuenta'}</p>
            ${l.map((c, i) => `<div class="cr-item">
                <button type="button" class="cr-elegir" data-i="${i}">
                    <span class="cr-avatar">${inicial(c.nombre)}</span>
                    <span class="cr-datos"><strong>${escHTML(c.nombre)}</strong><small>${escHTML(c.correo)}</small></span>
                </button>
                <button type="button" class="cr-quitar" data-i="${i}" aria-label="Quitar ${escHTML(c.correo)} de este dispositivo" title="Quitar de este dispositivo">&times;</button>
            </div>`).join('')}`;
        cont.querySelectorAll('.cr-elegir').forEach((b) => b.addEventListener('click', () => alElegir(l[Number(b.dataset.i)])));
        cont.querySelectorAll('.cr-quitar').forEach((b) => b.addEventListener('click', () => {
            CuentasRecordadas.olvidar(tipo, l[Number(b.dataset.i)].correo);
            CuentasRecordadas.pintar(cont, tipo, alElegir);
        }));
    },
};
window.CuentasRecordadas = CuentasRecordadas;

// Le pide al navegador (Chrome, Edge) que guarde el correo y la contraseña
// en su gestor de contraseñas, como cuando entras a una cuenta de Google.
// El navegador pregunta "¿Guardar contraseña?" y la próxima vez la autollena.
// La contraseña la guarda el navegador, nunca la tienda. Firefox y Safari no
// tienen esta función, pero igual ofrecen guardarla al enviar el formulario.
async function guardarCredencial(correo, password, nombre) {
    try {
        if (!correo || !password || !window.PasswordCredential || !navigator.credentials) return;
        await navigator.credentials.store(new PasswordCredential({ id: correo, password, name: nombre || correo }));
    } catch { /* el navegador no lo permite o la persona dijo que no */ }
}
window.guardarCredencial = guardarCredencial;

// Copia texto al portapapeles. navigator.clipboard solo existe en https o
// localhost; si la tienda se abre por la IP de la red (http://192.168…) o
// desde el celular, se usa el método clásico con un textarea temporal, que
// sí funciona en http. Devuelve true si se copió.
async function copiarTexto(texto) {
    texto = String(texto ?? '');
    try {
        if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(texto); return true; }
    } catch { /* se intenta el método clásico */ }
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';   // 16px: iPhone no hace zoom
    const activo = document.activeElement;
    (document.querySelector('.confirm-overlay.open') || document.body).appendChild(ta);   // dentro del modal para no perder el foco
    ta.focus(); ta.select(); ta.setSelectionRange(0, texto.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (activo && activo.focus) activo.focus({ preventScroll: true });
    return ok;
}
window.copiarTexto = copiarTexto;

// Campos numéricos: en lugar de las flechitas del navegador (un cuadro
// blanco que no combina con el tema y solo sale al pasar el mouse), cada
// <input type="number"> lleva botones − y + dentro del campo. Respetan
// min, max y step, se pueden mantener presionados y avisan con los mismos
// eventos input/change que si se escribiera el número. Se aplica solo,
// también a los campos de ventanas que se abren después.
(function () {
    const SVG = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">${d}</svg>`;
    const MENOS = SVG('<line x1="5" y1="12" x2="19" y2="12"/>');
    const MAS = SVG('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>');
    const OMITIR = '.qty, .qty-stepper, .mp-qty, [data-sin-stepper]';

    const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
    function paso(input) {
        const st = num(input.getAttribute('step'));
        return st && st >= 1 ? st : 1;           // con step 0.01 (precios) los botones avanzan de 1 en 1
    }
    function decimales(input) {
        const st = input.getAttribute('step') || '';
        return st.includes('.') ? st.split('.')[1].length : 0;
    }
    function mover(input, dir) {
        if (input.disabled || input.readOnly) return false;
        const min = num(input.min), max = num(input.max), d = paso(input);
        let v = num(input.value);
        // Vacío: "+" empieza en el mínimo permitido (o en 1), nunca en 0.
        if (v === null) v = dir > 0 ? (min !== null && min > 0 ? min : 1) : (max ?? min ?? 0);
        else v += dir * d;
        if (min !== null && v < min) v = min;
        if (max !== null && v > max) v = max;
        const dec = decimales(input);
        const txt = dec ? v.toFixed(dec) : String(Number(v.toFixed(2)));
        if (txt === input.value) return false;
        input.value = txt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }
    function refrescar(input, menos, mas) {
        const v = num(input.value), min = num(input.min), max = num(input.max);
        const bloqueado = input.disabled || input.readOnly;
        menos.disabled = bloqueado || (v !== null && min !== null && v <= min);
        mas.disabled = bloqueado || (v !== null && max !== null && v >= max);
    }
    function mejorar(input) {
        if (input.dataset.stepper || input.type !== 'number' || input.closest(OMITIR)) return;
        input.dataset.stepper = '1';
        const caja = document.createElement('span');
        caja.className = 'num-ctrl';
        // El margen del campo pasa a la caja, para que los botones queden centrados en el campo.
        ['marginTop', 'marginBottom'].forEach((m) => { if (input.style[m]) { caja.style[m] = input.style[m]; input.style[m] = '0'; } });
        input.parentNode.insertBefore(caja, input);
        caja.appendChild(input);
        const btns = document.createElement('span');
        btns.className = 'num-btns';
        btns.innerHTML = `<button type="button" tabindex="-1" aria-label="Disminuir">${MENOS}</button><button type="button" tabindex="-1" aria-label="Aumentar">${MAS}</button>`;
        caja.appendChild(btns);
        const [menos, mas] = btns.querySelectorAll('button');
        const act = () => refrescar(input, menos, mas);
        let espera = null, repite = null, cambio = false;
        const parar = () => {
            clearTimeout(espera); clearInterval(repite); espera = repite = null;
            if (cambio) { input.dispatchEvent(new Event('change', { bubbles: true })); cambio = false; }
            act();
        };
        [[menos, -1], [mas, 1]].forEach(([b, dir]) => {
            b.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || b.disabled) return;
                e.preventDefault();                       // no quita el foco del campo
                cambio = mover(input, dir) || cambio; act();
                espera = setTimeout(() => { repite = setInterval(() => { cambio = mover(input, dir) || cambio; act(); if (b.disabled) parar(); }, 70); }, 420);
            });
            ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, parar));
            b.addEventListener('click', (e) => e.preventDefault());
        });
        input.addEventListener('input', act);
        input.addEventListener('change', act);
        new MutationObserver(act).observe(input, { attributes: true, attributeFilter: ['disabled', 'readonly', 'min', 'max', 'value'] });
        act();
    }
    function revisar(raiz) {
        if (raiz.nodeType !== 1) return;
        if (raiz.matches && raiz.matches('input[type="number"]')) mejorar(raiz);
        raiz.querySelectorAll && raiz.querySelectorAll('input[type="number"]').forEach(mejorar);
    }
    function iniciar() {
        revisar(document.body);
        new MutationObserver((cambios) => cambios.forEach((c) => c.addedNodes.forEach(revisar)))
            .observe(document.body, { childList: true, subtree: true });
    }
    if (document.body) iniciar(); else document.addEventListener('DOMContentLoaded', iniciar);
})();

// Tokens de la versión anterior (Base64 en localStorage): ya no sirven.
try { localStorage.removeItem('kz_token'); localStorage.removeItem('kz_admin_token'); } catch { /* sin almacenamiento */ }

// ---- Política de contraseñas (las mismas reglas que valida el servidor
// en seguridad.js → validarPassword) ----
const ReglasPass = {
    reglas: [
        { k: 'len', t: '8 caracteres o más',              ok: (pw) => pw.length >= 8 },
        { k: 'may', t: 'Mayúsculas y minúsculas',         ok: (pw) => /[a-z]/.test(pw) && /[A-Z]/.test(pw) },
        { k: 'num', t: 'Al menos un número',              ok: (pw) => /\d/.test(pw) },
        { k: 'sim', t: 'Al menos un símbolo (# ! $ % …)', ok: (pw) => /[^A-Za-z0-9]/.test(pw) },
    ],
    html(id) {
        return `<ul class="pass-reglas" id="${id}" aria-live="polite">${ReglasPass.reglas.map((r) => `<li data-r="${r.k}">${r.t}</li>`).join('')}</ul>`;
    },
    // Marca en verde las reglas que ya se cumplen mientras se escribe.
    enlazar(input, lista) {
        const pintar = () => lista.querySelectorAll('li').forEach((li) => {
            const r = ReglasPass.reglas.find((x) => x.k === li.dataset.r);
            li.classList.toggle('ok', r.ok(input.value));
        });
        input.addEventListener('input', pintar);
        pintar();
    },
    faltante(pw) {
        const r = ReglasPass.reglas.find((x) => !x.ok(pw || ''));
        return r ? `La contraseña necesita: ${r.t.toLowerCase()}.` : null;
    },
};

// Páginas que necesitan sesión (cuenta del cliente, pagar, panel). Si el
// navegador las muestra desde su memoria al presionar "atrás" después de
// cerrar sesión, se revisa la sesión y se manda al inicio de sesión.
window.addEventListener('pageshow', (ev) => {
    if (!ev.persisted) return;   // carga normal: cada página revisa su sesión
    const p = location.pathname;
    if (RUTA_PANEL && !/\/(login|activar|recuperar|restablecer)\.html$/.test(p)) {
        if (!Sesion.usuario()) { location.replace(RUTA_PANEL + 'login.html'); return; }
        api('/admin/whoami').catch(() => {});   // si la sesión ya no existe, api() manda al login
        return;
    }
    if (window.KZ_PAGINA_PRIVADA) {
        if (!Sesion.cliente()) { location.replace('/login.html?next=' + encodeURIComponent(p + location.search)); return; }
        api('/auth/estado').then(({ cliente }) => { if (!cliente) { localStorage.removeItem('kz_cliente'); location.replace('/login.html'); } }).catch(() => {});
    }
});

// Manda al login guardando a dónde volver después
function irALogin(mensaje) {
    if (mensaje && window.toast) toast(mensaje, 'info');
    const next = encodeURIComponent(location.pathname + location.search + location.hash);
    const irYa = () => { location.href = `/login.html?next=${next}`; };
    if (mensaje) setTimeout(irYa, 800); else irYa();
}

// ---- Favoritos: cache local del set de ids para pintar corazones ----
const Favoritos = {
    _set: new Set(),
    async cargar() {
        const cliente = Sesion.cliente();
        if (!cliente) { this._set = new Set(); return this._set; }
        try {
            const favs = await api(`/clientes/${cliente.id}/favoritos`);
            this._set = new Set(favs.map((f) => f.id));
        } catch { this._set = new Set(); }
        return this._set;
    },
    tiene(productoId) { return this._set.has(Number(productoId)); },
    async alternar(productoId) {
        const cliente = Sesion.cliente();
        if (!cliente) { irALogin('Inicia sesión para guardar favoritos'); return null; }
        productoId = Number(productoId);
        if (this._set.has(productoId)) {
            await api(`/clientes/${cliente.id}/favoritos/${productoId}`, { method: 'DELETE' });
            this._set.delete(productoId);
            return false;
        }
        await api(`/clientes/${cliente.id}/favoritos`, { method: 'POST', body: { producto_id: productoId } });
        this._set.add(productoId);
        return true;
    }
};

function formatoMoneda(valor) {
    return Number(valor || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
}

// Existencia que ve el cliente: cuántas piezas hay de cada producto.
// Pocas piezas = en o por debajo del stock mínimo del producto (5 si no lo trae).
function existenciaDe(p) {
    const n = Math.max(0, Number(p && p.stock) || 0);
    const minimo = p && p.stock_minimo != null ? Number(p.stock_minimo) : 5;
    const piezas = n === 1 ? '1 pieza' : `${n.toLocaleString('es-MX')} piezas`;
    if (n === 0) return { n, clase: 'stock-out', texto: 'Agotado', corto: 'Agotado' };
    if (n <= minimo) return { n, clase: 'stock-low', texto: n === 1 ? 'Última pieza disponible' : `Últimas ${piezas} disponibles`, corto: `Quedan ${n}` };
    return { n, clase: 'stock-ok', texto: `${piezas} disponibles`, corto: `${n} disponibles` };
}
function existenciaHTML(p, { corto = false } = {}) {
    const e = existenciaDe(p);
    return `<span class="product-stock ${e.clase}">${corto ? e.corto : e.texto}</span>`;
}

// Desglose de impuestos de un pedido. Los pedidos nuevos guardan su detalle
// (impuestos_detalle); los anteriores a la Etapa 4 solo el total (IVA 16%).
function impuestosDe(d) {
    const det = Array.isArray(d.impuestos_detalle) ? d.impuestos_detalle : [];
    return det.length ? det : [{ nombre: 'IVA', porcentaje: 16, monto: Number(d.impuestos) || 0 }];
}
window.impuestosDe = impuestosDe;

// Precio con promoción: precio final + precio de lista tachado + etiqueta.
// p: producto del catálogo (trae precio, precio_final y promocion).
function precioHTML(p, { clase = '' } = {}) {
    const lista = Number(p.precio);
    const final = Number(p.precio_final ?? p.precio);
    if (!p.promocion || !(final < lista)) return `<span class="${clase}">${formatoMoneda(lista)}</span>`;
    const etiqueta = p.promocion.tipo_descuento === 'monto'
        ? `-${formatoMoneda(lista - final)}` : `-${Math.round((1 - final / lista) * 100)}%`;
    return `<span class="${clase} precio-promo">${formatoMoneda(final)}</span> <s class="precio-antes">${formatoMoneda(lista)}</s> <span class="tag-promo" title="${String(p.promocion.nombre || '').replace(/"/g, '')}">${etiqueta}</span>`;
}

// ---- Club Kozmok: puntos que se ganan ANTES de comprar ----
// Misma regla que el servidor: (precio pagado / 20) x multiplicador del
// nivel (Bronce x1 sin sesión). La regla se pide una vez por sesión de
// navegación y se guarda; mientras llega se usa la última conocida.
const Club = {
    _defecto: { pesos_por_punto: 20, valor_punto: 0.1, con_sesion: false, nivel: { clave: 'bronce', nombre: 'Bronce', multiplicador: 1 } },
    _quien() { const c = Sesion.cliente(); return c ? Number(c.id) : 0; },
    regla() {
        try {
            const r = JSON.parse(sessionStorage.getItem('kz_club'));
            return r && r.quien === this._quien() ? r : this._defecto;   // es de otra sesión
        } catch { return this._defecto; }
    },
    async cargar() {
        try {
            const r = { ...(await api('/club/regla')), quien: this._quien() };
            const antes = JSON.stringify(this.regla());
            sessionStorage.setItem('kz_club', JSON.stringify(r));
            if (antes !== JSON.stringify(r)) document.dispatchEvent(new CustomEvent('kz:club', { detail: r }));
            return r;
        } catch { return this.regla(); }
    },
    olvidar() { try { sessionStorage.removeItem('kz_club'); } catch { /* nada */ } },
    puntos(monto) {
        const r = this.regla();
        return Math.max(0, Math.floor((Number(monto) || 0) / r.pesos_por_punto * Number(r.nivel.multiplicador || 1)));
    },
    valor(puntos) { return Math.round(puntos * this.regla().valor_punto * 100) / 100; },
    // Etiqueta corta para tarjetas de producto: "+124 pts"
    etiqueta(monto) {
        const n = this.puntos(monto);
        if (!n) return '';
        return `<span class="pts-ganar" title="Ganas ${n.toLocaleString('es-MX')} puntos del Club Kozmok (valen ${formatoMoneda(this.valor(n))} en tu siguiente compra)">+${n.toLocaleString('es-MX')} pts</span>`;
    },
};
window.Club = Club;

function formatoFecha(fecha) {
    if (!fecha) return '—';
    // Una fecha sola (AAAA-MM-DD) es un día del calendario, no la medianoche UTC.
    if (typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha += 'T00:00:00';
    return new Date(fecha).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatoFechaHora(fecha) {
    if (!fecha) return '—';
    return new Date(fecha).toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// Escapa texto antes de meterlo en HTML (contra XSS al mostrar datos).
// Desactiva un botón mientras corre una acción (envíos con fotos tardan):
// así un doble clic no manda lo mismo dos o tres veces.
async function conBoton(btn, accion, textoEspera = 'Enviando…') {
    if (btn && btn.disabled) return;
    const antes = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = textoEspera; }
    try { return await accion(); }
    finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = antes; } }
}

// Pedido sin pagar -> sus productos regresan al carrito (para cambiar el
// método de pago, la dirección o lo que se lleva). Pide confirmación.
async function regresarPedidoAlCarrito(id, { numero = '', paso = 3 } = {}) {
    const ok = await confirmar(`El pedido ${numero} se cancela sin ningún cargo y sus productos regresan a tu carrito para que elijas otro método de pago o hagas cambios.`,
        { okText: 'Regresar al carrito' });
    if (!ok) return false;
    try {
        const r = await api(`/pedidos/${id}/al-carrito`, { method: 'POST' });
        try { if (r.cupon) sessionStorage.setItem('kz_cupon', r.cupon); } catch { /* nada */ }
        if (typeof actualizarBadgeCarrito === 'function') actualizarBadgeCarrito();
        toast(r.message, 'ok');
        if (location.pathname === '/carrito.html') return r;
        location.href = '/carrito.html' + (r.productos && paso > 1 ? '?paso=' + paso : '');
        return r;
    } catch (e) { toast(e.message, 'error'); return false; }
}

function escHTML(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Navegador legible a partir del User-Agent (para "sesiones abiertas").
function navegadorDe(ua) {
    ua = String(ua || '');
    const nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|node|python|axios|Postman/i.test(ua) ? 'Script / API' : 'Navegador';
    const so = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return so ? `${nav} en ${so}` : nav;
}

// ---- Carrito sin sesión ----
// Lo que agrega un visitante sin cuenta se guarda en el navegador y se pasa
// a su carrito real (servidor) en cuanto inicia sesión o crea su cuenta.
const CarritoInvitado = {
    CLAVE: 'kz_carrito_invitado',
    leer() { try { return JSON.parse(localStorage.getItem(this.CLAVE) || '[]'); } catch { return []; } },
    guardar(lista) { try { localStorage.setItem(this.CLAVE, JSON.stringify(lista)); } catch { /* sin almacenamiento */ } },
    total() { return this.leer().reduce((a, i) => a + i.cantidad, 0); },
    cantidadDe(id) { const it = this.leer().find((x) => x.producto_id === Number(id)); return it ? it.cantidad : 0; },
    agregar(id, cantidad = 1, garantia = 'none') {
        const lista = this.leer();
        const it = lista.find((x) => x.producto_id === Number(id));
        if (it) { it.cantidad += cantidad; if (garantia && garantia !== 'none') it.garantia = garantia; }
        else lista.push({ producto_id: Number(id), cantidad, garantia: garantia || 'none' });
        this.guardar(lista);
    },
    cambiar(id, cambios) {
        const lista = this.leer();
        const it = lista.find((x) => x.producto_id === Number(id));
        if (it) Object.assign(it, cambios);
        this.guardar(lista);
    },
    quitar(id) { this.guardar(this.leer().filter((x) => x.producto_id !== Number(id))); },
    vaciar() { try { localStorage.removeItem(this.CLAVE); } catch { /* nada */ } },
    // Pasa lo guardado al carrito de la cuenta. Lo que ya no tenga stock se avisa.
    async fusionar() {
        const lista = this.leer();
        const res = { pasados: 0, avisos: [] };
        for (const it of lista) {
            try {
                await api('/carrito', { method: 'POST', body: { producto_id: it.producto_id, cantidad: it.cantidad, garantia: it.garantia } });
                res.pasados += it.cantidad;
            } catch (e) { res.avisos.push(e.message); }
        }
        this.vaciar();
        return res;
    },
};
window.CarritoInvitado = CarritoInvitado;

// Agregar al carrito desde cualquier parte de la tienda (catálogo, ficha,
// Arma tu PC, asesor, comparador, favoritos). Con sesión va al servidor;
// sin sesión se guarda en el navegador sin pasarse del stock.
// confirmar: abre el panel lateral con el producto recién agregado (por
// defecto). El chatbot y Arma tu PC lo apagan porque agregan en serie.
async function agregarProducto(productoId, cantidad = 1, garantia = 'none', { confirmar = true } = {}) {
    if (Sesion.cliente()) {
        await api('/carrito', { method: 'POST', body: { producto_id: productoId, cantidad, garantia } });
    } else {
        const p = await api(`/productos/${productoId}`);
        const ya = CarritoInvitado.cantidadDe(productoId);
        if (Number(p.stock) <= 0) throw new Error(`"${p.nombre}" está agotado`);
        if (ya + cantidad > Number(p.stock)) throw new Error(ya ? `Solo hay ${p.stock} disponibles y ya tienes ${ya} en tu carrito` : `Solo hay ${p.stock} disponibles`);
        CarritoInvitado.agregar(productoId, cantidad, garantia);
    }
    actualizarBadgeCarrito();
    if (confirmar && window.MiniPanel) MiniPanel.confirmarAgregado(productoId, cantidad);
}
window.agregarProducto = agregarProducto;

function actualizarBadgeCarrito() {
    const cliente = Sesion.cliente();
    const el = document.getElementById('cart-badge');
    if (!el) return;
    if (!cliente) {
        const n = CarritoInvitado.total();
        el.style.display = n > 0 ? 'flex' : 'none';
        el.textContent = n;
        return;
    }
    api(`/carrito/${cliente.id}`).then((items) => {
        const total = items.reduce((acc, i) => acc + i.cantidad, 0);
        el.style.display = total > 0 ? 'flex' : 'none';
        el.textContent = total;
    }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', actualizarBadgeCarrito);

// Red de seguridad: si una promesa (normalmente una llamada a la API) falla
// sin que nadie la atrape, se avisa con un toast — nunca con texto crudo en
// la consola, que se ve fuera de contexto para el usuario final.
window.addEventListener('unhandledrejection', (e) => {
    const msg = (e && e.reason && e.reason.message) ? e.reason.message : '';
    if (window.toast) toast(msg || 'Hubo un problema de conexión. Intenta de nuevo.', 'error');
    e.preventDefault();
});

// Exponer en window: las declaraciones `const` NO se vuelven propiedades
// de window por sí solas, y layout.js / chatbot.js hacen `window.Sesion`.
window.api = api;
window.Sesion = Sesion;
window.Favoritos = Favoritos;
window.irALogin = irALogin;
window.formatoMoneda = formatoMoneda;
window.formatoFecha = formatoFecha;
window.precioHTML = precioHTML;
window.actualizarBadgeCarrito = actualizarBadgeCarrito;
