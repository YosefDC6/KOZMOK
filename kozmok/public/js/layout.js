// public/js/layout.js
// Navbar + footer de la tienda. Se insertan en cualquier página que
// tenga <div id="navbar-placeholder"></div> y <div id="footer-placeholder"></div>.

async function renderNavbar() {
    const el = document.getElementById('navbar-placeholder');
    if (!el) return;
    const cliente = window.Sesion ? Sesion.cliente() : null;
    const nombreCorto = cliente ? cliente.nombre.split(' ')[0] : '';

    let categorias = [];
    try { categorias = await api('/categorias'); } catch { /* backend abajo: navbar sin categorías */ }

    const params = new URLSearchParams(location.search);
    const catActual = params.get('categoria') || '';

    const catLinks = categorias.map((c) =>
        `<a href="/index.html?categoria=${encodeURIComponent(c.nombre)}">${iconCategoria(c.nombre, 16)} ${c.nombre}</a>`
    ).join('');

    // Opciones del selector de alcance dentro de la barra de búsqueda
    const scopeOptions = `<option value="">Todo</option>` + categorias.map((c) =>
        `<option value="${c.nombre}" ${c.nombre === catActual ? 'selected' : ''}>${c.nombre}</option>`
    ).join('');

    // Menú desplegable "Categorías" (reemplaza la barra fija de categorías)
    const categoriasMenu = `
        <div class="menu-dropdown" id="cat-dd">
            <button class="cat-trigger" id="cat-trigger" aria-haspopup="true" aria-expanded="false">Categorías ${icon('chevron', 14)}</button>
            <div class="menu-panel cat-panel" role="menu">
                <a href="/index.html?ver=todo" role="menuitem">${icon('grid', 16)} Todo el catálogo</a>
                <a href="/armar-pc.html" role="menuitem">${icon('cpu', 16)} Arma tu PC</a>
                <a href="/index.html?promocion=1" role="menuitem">${icon('star', 16)} Promociones</a>
                <a href="/index.html?orden=novedades" role="menuitem">${icon('clock', 16)} Novedades</a>
                <div class="menu-sep"></div>
                ${catLinks}
            </div>
        </div>`;

    const M = (i, txt, href) => `<a href="${href}" role="menuitem">${icon(i)} ${txt}</a>`;
    const cuentaMenu = cliente ? `
        <div class="menu-dropdown" id="cuenta-dd">
            <button class="icon-btn menu-trigger" id="cuenta-trigger" aria-haspopup="true" aria-expanded="false">
                <span class="avatar">${(nombreCorto[0] || 'U').toUpperCase()}</span>
                <span class="hide-sm">${nombreCorto}</span> ${icon('chevron', 14)}
            </button>
            <div class="menu-panel" role="menu">
                <div class="menu-head">
                    <strong>${cliente.nombre}</strong>
                    <span>${cliente.correo}</span>
                </div>
                ${M('home', 'Resumen', '/perfil.html')}
                <a href="/pedidos.html" role="menuitem">${icon('package')} Mis pedidos <span class="menu-aviso" id="menu-en-camino" hidden></span></a>
                ${M('star', 'Club de puntos', '/recompensas.html')}
                ${M('wallet', 'Mi monedero', '/monedero.html')}
                ${M('heart', 'Favoritos', '/favoritos.html')}
                ${M('pin', 'Direcciones', '/direcciones.html')}
                ${M('card', 'Métodos de pago', '/pagos.html')}
                ${M('shield', 'Mis garantías', '/garantias.html')}
                ${M('help', 'Soporte', '/soporte.html')}
                ${M('settings', 'Preferencias', '/preferencias.html')}
                <div class="menu-sep"></div>
                <button class="menu-logout" id="btn-logout" role="menuitem">${icon('logout')} Cerrar sesión</button>
            </div>
        </div>
    ` : `
        <a href="/login.html" class="btn btn-outline btn-sm">Iniciar sesión</a>
        <a href="/registro.html" class="btn btn-primary btn-sm hide-sm">Crear cuenta</a>
    `;

    el.innerHTML = `
        <div class="topbar">Envío gratis en compras mayores a $10,000 · Garantía directa con la tienda</div>
        <nav class="navbar">
            <div class="navbar-inner">
                <button class="hamburger" id="hamburger" aria-label="Menú">${icon('menu', 22)}</button>
                <a href="/index.html" class="brand" aria-label="Kozmok, ir al inicio"><span class="brand-mark">${logoKZK(13)}</span> <span class="hide-sm">Kozmok</span></a>

                <form class="nav-search" id="nav-search" role="search" autocomplete="off">
                    <input type="search" id="nav-search-input" placeholder="Buscar productos, marcas…  ( / )" aria-label="Buscar"
                           role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="sug-nav-search-input" />
                    <select id="nav-scope" aria-label="Categoría a buscar">${scopeOptions}</select>
                    <button type="submit">${icon('search', 16)}<span class="hide-sm">Buscar</span></button>
                </form>

                <div class="nav-actions">
                    ${categoriasMenu}
                    <a href="/favoritos.html" class="icon-btn hide-sm" id="nav-fav" title="Favoritos" data-panel="favoritos">${icon('heart', 20)}<span class="badge-count" id="fav-badge" style="display:none">0</span></a>
                    <a href="/carrito.html" class="icon-btn" id="nav-cart" title="Carrito" data-panel="carrito">${icon('cart', 20)}<span class="badge-count" id="cart-badge" style="display:none">0</span></a>
                    ${cuentaMenu}
                </div>
            </div>
        </nav>

        <nav class="bottom-nav" id="bottom-nav">
            <a href="/index.html" data-match="/index.html,/"><span class="bn-ico">${icon('home', 20)}</span>Inicio</a>
            <a href="/index.html?ver=todo" data-match="__catalogo"><span class="bn-ico">${icon('grid', 20)}</span>Catálogo</a>
            <a href="/favoritos.html" data-match="/favoritos.html" data-panel="favoritos"><span class="bn-ico">${icon('heart', 20)}<span class="bn-badge" id="bn-fav-badge" hidden></span></span>Favoritos</a>
            <a href="/carrito.html" data-match="/carrito.html" data-panel="carrito"><span class="bn-ico">${icon('cart', 20)}<span class="bn-badge" id="bn-cart-badge" hidden></span></span>Carrito</a>
            <a href="${cliente ? '/perfil.html' : '/login.html'}" id="bn-cuenta" data-match="/perfil.html,/pedidos.html,/login.html,/registro.html"><span class="bn-ico">${icon('user', 20)}<span class="bn-punto" id="bn-punto" hidden></span></span>${cliente ? 'Cuenta' : 'Entrar'}</a>
        </nav>

        <div class="drawer-overlay" id="drawer-overlay"></div>
        <aside class="drawer" id="drawer">
            <div class="drawer-head">
                <strong>${cliente ? 'Hola, ' + nombreCorto : 'Menú'}</strong>
                <button class="modal-close" id="drawer-close" aria-label="Cerrar">${icon('x', 20)}</button>
            </div>
            <form class="drawer-search" id="drawer-search" autocomplete="off">
                <input type="search" id="drawer-search-input" placeholder="Buscar…" role="combobox" aria-autocomplete="list" aria-expanded="false" />
                <button type="submit">${icon('search', 16)}</button>
            </form>
            <div class="drawer-section">
                <span class="drawer-label">Categorías</span>
                <a href="/index.html?ver=todo">${icon('grid', 16)} Todo el catálogo</a>
                <a href="/armar-pc.html">${icon('cpu', 16)} Arma tu PC</a>
                <a href="/index.html?promocion=1">${icon('star', 16)} Promociones</a>
                <a href="/index.html?orden=novedades">${icon('clock', 16)} Novedades</a>
                ${catLinks}
            </div>
            <div class="drawer-section">
                <span class="drawer-label">${cliente ? 'Mi cuenta' : 'Cuenta'}</span>
                ${cliente ? `
                    <a href="/perfil.html">Resumen</a>
                    <a href="/pedidos.html">Mis pedidos</a>
                    <a href="/recompensas.html">Club de puntos</a>
                    <a href="/monedero.html">Mi monedero</a>
                    <a href="/favoritos.html">Favoritos</a>
                    <a href="/resenas.html">Mis reseñas</a>
                    <a href="/garantias.html">Mis garantías</a>
                    <a href="/direcciones.html">Direcciones</a>
                    <a href="/pagos.html">Métodos de pago</a>
                    <a href="/soporte.html">Soporte</a>
                    <a href="/datos.html">Mis datos</a>
                    <a href="/seguridad.html">Seguridad</a>
                    <a href="/preferencias.html">Preferencias</a>
                    <button class="menu-logout" id="btn-logout-drawer">Cerrar sesión</button>
                ` : `
                    <a href="/login.html">Iniciar sesión</a>
                    <a href="/registro.html">Crear cuenta</a>
                    <a href="/ayuda.html">Ayuda</a>
                `}
            </div>
        </aside>
    `;

    // ---- Búsqueda (input + alcance + botón, todo en uno) ----
    const inp = document.getElementById('nav-search-input');
    if (inp) inp.value = params.get('busqueda') || '';
    const hacerBusqueda = (valor, scope) => {
        const q = (valor || '').trim();
        if (q) Buscador.guardarReciente(q);
        const qs = new URLSearchParams();
        if (q) qs.set('busqueda', q);
        if (scope) qs.set('categoria', scope);
        if (!q && !scope) qs.set('ver', 'todo');
        location.href = '/index.html?' + qs.toString();
    };
    document.getElementById('nav-search').addEventListener('submit', (e) => {
        e.preventDefault();
        hacerBusqueda(inp.value, document.getElementById('nav-scope').value);
    });
    document.getElementById('drawer-search').addEventListener('submit', (e) => {
        e.preventDefault(); hacerBusqueda(document.getElementById('drawer-search-input').value, '');
    });
    Buscador.montar(inp, () => document.getElementById('nav-scope').value, hacerBusqueda, categorias);
    Buscador.montar(document.getElementById('drawer-search-input'), () => '', hacerBusqueda, categorias);

    // ---- Menú de categorías: al abrirlo por primera vez se arma con las
    //      marcas principales de cada categoría y su acceso a promociones ----
    const catDD = document.getElementById('cat-dd');
    if (catDD) catDD.querySelector('[aria-haspopup]').addEventListener('click', () => armarMenuCategorias(catDD, categorias), { once: true });

    // ---- Dropdowns (cuenta + categorías): un solo manejador ----
    const dropdowns = ['cuenta-dd', 'cat-dd'].map((id) => document.getElementById(id)).filter(Boolean);
    dropdowns.forEach((dd) => {
        const trigger = dd.querySelector('[aria-haspopup]');
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const abrir = !dd.classList.contains('open');
            dropdowns.forEach((o) => o.classList.remove('open'));
            dd.classList.toggle('open', abrir);
            trigger.setAttribute('aria-expanded', abrir ? 'true' : 'false');
        });
    });
    document.addEventListener('click', () => dropdowns.forEach((dd) => dd.classList.remove('open')));
    document.querySelectorAll('#btn-logout, #btn-logout-drawer').forEach((b) =>
        b.addEventListener('click', () => {
            api('/auth/logout', { method: 'POST' }).catch(() => {});
            Sesion.cerrarSesionCliente();
            if (window.toast) toast('Sesión cerrada', 'ok');
            setTimeout(() => location.href = '/index.html', 400);
        })
    );

    // ---- Drawer móvil ----
    const drawer = document.getElementById('drawer');
    const overlay = document.getElementById('drawer-overlay');
    const abrirDrawer = () => { drawer.classList.add('open'); overlay.classList.add('open'); };
    const cerrarDrawer = () => { drawer.classList.remove('open'); overlay.classList.remove('open'); };
    document.getElementById('hamburger').addEventListener('click', abrirDrawer);
    document.getElementById('drawer-close').addEventListener('click', cerrarDrawer);
    overlay.addEventListener('click', cerrarDrawer);

    // ---- Marcar categoría activa (en el drawer y el menú de categorías) ----
    if (catActual) {
        document.querySelectorAll('.cat-panel a, .drawer-section a').forEach((a) => {
            if (a.getAttribute('href') === '/index.html?categoria=' + encodeURIComponent(catActual)) a.classList.add('active');
        });
    }

    // ---- Barra inferior (móvil): marcar activo + logout ----
    const aquí = location.pathname;
    const enPortada = (aquí === '/' || aquí === '/index.html') && !location.search;
    const enCatalogo = (aquí === '/' || aquí === '/index.html') && !!location.search;
    document.querySelectorAll('#bottom-nav a[data-match]').forEach((a) => {
        const claves = a.dataset.match.split(',');
        const activo = claves.some((k) =>
            k === '__catalogo' ? enCatalogo : (k === '/index.html' || k === '/') ? enPortada : k === aquí
        );
        if (activo) a.classList.add('active');
    });

    actualizarBadgeCarrito();
    actualizarBadgeFavoritos();
    MiniPanel.montar();
    renderBotonRegresar();
    montarVolverArriba();
    if (cliente) avisarPedidosEnCamino(cliente);
    // los contadores de la barra inferior copian a los de arriba
    ['cart-badge', 'fav-badge'].forEach((id) => {
        const src = document.getElementById(id);
        const dst = document.getElementById(id === 'cart-badge' ? 'bn-cart-badge' : 'bn-fav-badge');
        if (!src || !dst) return;
        const copiar = () => { dst.textContent = src.textContent; dst.hidden = src.style.display === 'none' || !Number(src.textContent); };
        copiar();
        new MutationObserver(copiar).observe(src, { attributes: true, childList: true, characterData: true, subtree: true });
    });
}

async function armarMenuCategorias(dd, categorias) {
    let prods = [];
    try { prods = await api('/catalogo'); } catch { return; }   // sin datos se queda el menú simple
    const porCat = categorias.map((c) => {
        const lista = prods.filter((p) => p.categoria_nombre === c.nombre);
        const marcas = {};
        lista.forEach((p) => { if (p.marca) marcas[p.marca] = (marcas[p.marca] || 0) + 1; });
        return { ...c, n: lista.length, promo: lista.filter((p) => p.promocion).length,
                 marcas: Object.entries(marcas).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([m]) => m) };
    }).filter((c) => c.n > 0);
    const panel = dd.querySelector('.cat-panel');
    const u = (q) => '/index.html?' + new URLSearchParams(q).toString();
    panel.classList.add('mega');
    panel.innerHTML = `
        <div class="mega-rapidos">
            <a href="/index.html?ver=todo" role="menuitem">${icon('grid', 15)} Todo el catálogo</a>
            <a href="/armar-pc.html" role="menuitem">${icon('cpu', 15)} Arma tu PC</a>
            <a href="/index.html?promocion=1" role="menuitem">${icon('star', 15)} Promociones</a>
            <a href="/index.html?orden=novedades" role="menuitem">${icon('clock', 15)} Novedades</a>
        </div>
        <div class="mega-grid">
            ${porCat.map((c) => `
                <div class="mega-col">
                    <a class="mega-cat" role="menuitem" href="${u({ categoria: c.nombre })}">${iconCategoria(c.nombre, 17)} ${c.nombre} <span>${c.n}</span></a>
                    ${c.marcas.map((m) => `<a class="mega-marca" role="menuitem" href="${u({ categoria: c.nombre, marca: m })}">${m}</a>`).join('')}
                    ${c.promo ? `<a class="mega-promo" role="menuitem" href="${u({ categoria: c.nombre, promocion: '1' })}">${icon('star', 12)} ${c.promo} en promoción</a>` : ''}
                </div>`).join('')}
        </div>`;
    const actual = new URLSearchParams(location.search).get('categoria');
    if (actual) panel.querySelectorAll('.mega-cat').forEach((a) => { if (a.getAttribute('href') === u({ categoria: actual })) a.classList.add('active'); });
}

// Pedidos en camino: punto en "Cuenta" (barra inferior) y aviso en "Mis pedidos"
async function avisarPedidosEnCamino(cliente) {
    try {
        const peds = await api(`/pedidos/cliente/${cliente.id}`);
        const n = peds.filter((p) => ['confirmado', 'procesando', 'enviado'].includes(p.estado)).length;
        const enviados = peds.filter((p) => p.estado === 'enviado').length;
        const punto = document.getElementById('bn-punto');
        const aviso = document.getElementById('menu-en-camino');
        if (punto) { punto.hidden = !n; if (n) document.getElementById('bn-cuenta').href = '/pedidos.html'; }
        if (aviso) { aviso.hidden = !n; aviso.textContent = enviados ? `${enviados} en camino` : `${n} en proceso`; }
    } catch { /* sin conexión: sin aviso */ }
}

// Botón "volver arriba": aparece al bajar en páginas largas
function montarVolverArriba() {
    if (document.getElementById('kz-arriba')) return;
    const b = document.createElement('button');
    b.id = 'kz-arriba'; b.type = 'button'; b.className = 'kz-arriba'; b.setAttribute('aria-label', 'Volver arriba');
    b.innerHTML = icon('chevron', 20);
    b.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    document.body.appendChild(b);
    let pend = false;
    window.addEventListener('scroll', () => {
        if (pend) return; pend = true;
        requestAnimationFrame(() => { b.classList.toggle('show', scrollY > 900); pend = false; });
    }, { passive: true });
}

// =========================================================
// BUSCADOR CON SUGERENCIAS EN VIVO
//   Mientras se escribe (2+ letras) muestra hasta 5 productos con foto y
//   precio (con promoción), las categorías que coinciden y "ver todos".
//   Sin texto muestra las búsquedas recientes (se guardan en el navegador).
//   Teclado: flechas para moverse, Enter para abrir, Esc para cerrar.
// =========================================================
const Buscador = {
    CLAVE: 'kz_busquedas',
    recientes() { try { return JSON.parse(localStorage.getItem(this.CLAVE)) || []; } catch { return []; } },
    guardarReciente(q) {
        const l = [q, ...this.recientes().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
        try { localStorage.setItem(this.CLAVE, JSON.stringify(l)); } catch { /* sin storage */ }
    },
    quitarReciente(q) {
        try { localStorage.setItem(this.CLAVE, JSON.stringify(this.recientes().filter((x) => x !== q))); } catch { /* */ }
    },

    montar(input, scope, buscar, categorias) {
        if (!input) return;
        const form = input.closest('form');
        const caja = document.createElement('div');
        caja.className = 'sug-caja';
        caja.id = 'sug-' + input.id;
        caja.setAttribute('role', 'listbox');
        caja.hidden = true;
        form.style.position = 'relative';
        form.appendChild(caja);
        let timer = null, pedido = 0, activo = -1;

        const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const resaltar = (texto, q) => {
            const i = texto.toLowerCase().indexOf(q.toLowerCase());
            return i < 0 ? esc(texto) : esc(texto.slice(0, i)) + '<mark>' + esc(texto.slice(i, i + q.length)) + '</mark>' + esc(texto.slice(i + q.length));
        };
        const opciones = () => [...caja.querySelectorAll('[data-sug]')];
        const marcar = (i) => {
            const ops = opciones();
            activo = Math.max(-1, Math.min(i, ops.length - 1));
            ops.forEach((o, k) => o.classList.toggle('on', k === activo));
            if (ops[activo]) ops[activo].scrollIntoView({ block: 'nearest' });
        };
        const abrir = (html) => { caja.innerHTML = html; caja.hidden = !html; input.setAttribute('aria-expanded', html ? 'true' : 'false'); activo = -1; };
        const cerrar = () => abrir('');

        const pintarRecientes = () => {
            const rec = this.recientes();
            const cats = categorias.slice(0, 6);
            abrir((rec.length ? `<div class="sug-tit">Búsquedas recientes</div>` + rec.map((r) => `
                <div class="sug-op sug-rec" data-sug="q" data-q="${esc(r)}" role="option">${icon('clock', 15)} <span>${esc(r)}</span>
                    <button type="button" class="sug-x" data-quitar="${esc(r)}" aria-label="Quitar ${esc(r)}">${icon('x', 13)}</button></div>`).join('') : '')
                + (cats.length ? `<div class="sug-tit">Explorar</div><div class="sug-chips">${cats.map((c) => `<a class="sug-chip" data-sug="url" href="/index.html?categoria=${encodeURIComponent(c.nombre)}">${iconCategoria(c.nombre, 14)} ${esc(c.nombre)}</a>`).join('')}
                    <a class="sug-chip" data-sug="url" href="/index.html?promocion=1">${icon('star', 14)} Promociones</a></div>` : ''));
        };

        const sugerir = async (q) => {
            const n = ++pedido;
            const qs = new URLSearchParams({ buscar: q });
            if (scope()) qs.set('categoria', scope());
            let prods = [];
            try { prods = await api('/catalogo?' + qs.toString()); } catch { return; }
            if (n !== pedido || input.value.trim() !== q) return;   // llegó tarde
            const cats = categorias.filter((c) => c.nombre.toLowerCase().includes(q.toLowerCase())).slice(0, 3);
            const top = prods.slice(0, 5);
            if (!top.length && !cats.length) {
                abrir(`<div class="sug-vacio">${icon('search', 16)} Sin resultados para "<strong>${esc(q)}</strong>". Prueba con otra palabra o <a href="/index.html?ver=todo">ve todo el catálogo</a>.</div>`);
                return;
            }
            abrir(
                (cats.length ? cats.map((c) => `<a class="sug-op" data-sug="url" role="option" href="/index.html?categoria=${encodeURIComponent(c.nombre)}">${iconCategoria(c.nombre, 16)} <span>${resaltar(c.nombre, q)} <em>categoría</em></span></a>`).join('') : '')
                + top.map((p) => `
                    <a class="sug-op sug-prod" data-sug="prod" data-id="${p.id}" role="option" href="/index.html?busqueda=${encodeURIComponent(q)}#producto-${p.id}">
                        <img src="${imagenProducto(p)}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/img/producto.svg'">
                        <span class="sug-info"><span class="sug-nom">${resaltar(p.nombre, q)}</span><span class="sug-meta">${esc(p.marca || '')} · ${esc(p.categoria_nombre || '')}${Number(p.stock) <= 0 ? ' · <b class="agot">Agotado</b>' : ''}</span></span>
                        <span class="sug-precio">${precioHTML(p)}</span>
                    </a>`).join('')
                + `<a class="sug-todos" data-sug="todos" href="#">${icon('search', 14)} Ver los ${prods.length} resultados de "${esc(q)}" ${icon('arrow', 14)}</a>`);
        };

        input.addEventListener('input', () => {
            clearTimeout(timer);
            const q = input.value.trim();
            if (q.length < 2) { if (!q) pintarRecientes(); else cerrar(); return; }
            timer = setTimeout(() => sugerir(q), 160);
        });
        input.addEventListener('focus', () => { if (!input.value.trim()) pintarRecientes(); else if (input.value.trim().length >= 2) sugerir(input.value.trim()); });
        input.addEventListener('keydown', (e) => {
            if (caja.hidden) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); marcar(activo + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); marcar(activo - 1); }
            else if (e.key === 'Escape') { cerrar(); }
            else if (e.key === 'Enter' && activo >= 0) { e.preventDefault(); opciones()[activo].click(); }
        });
        // clic en una sugerencia
        caja.addEventListener('mousedown', (e) => e.preventDefault());   // no perder el foco antes del clic
        caja.addEventListener('click', (e) => {
            const x = e.target.closest('[data-quitar]');
            if (x) { e.preventDefault(); e.stopPropagation(); this.quitarReciente(x.dataset.quitar); pintarRecientes(); return; }
            const op = e.target.closest('[data-sug]');
            if (!op) return;
            const tipo = op.dataset.sug;
            if (tipo === 'q') { e.preventDefault(); input.value = op.dataset.q; buscar(op.dataset.q, scope()); }
            else if (tipo === 'todos') { e.preventDefault(); buscar(input.value, scope()); }
            else if (tipo === 'prod') {
                this.guardarReciente(input.value.trim());
                // en la tienda (index) se abre la ficha ahí mismo, sin recargar
                if (window.verProducto && (location.pathname === '/' || location.pathname === '/index.html')) {
                    e.preventDefault(); cerrar(); input.blur(); verProducto(Number(op.dataset.id));
                }
            }
        });
        document.addEventListener('click', (e) => { if (!form.contains(e.target)) cerrar(); });
    },
};
window.Buscador = Buscador;

// Atajo de teclado: "/" lleva al buscador (si no se está escribiendo en otro campo)
document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const inp = document.getElementById('nav-search-input');
    if (inp && inp.offsetParent !== null) { e.preventDefault(); inp.focus(); inp.select(); }
});

// =========================================================
// PANEL LATERAL DE CARRITO Y FAVORITOS
// Al dar clic en el corazón o en el carrito se abre un panel a la derecha
// con dos pestañas, para revisar y modificar sin cambiar de pantalla.
// Solo se sale de la página para ver el carrito completo / pagar.
// =========================================================
const MiniPanel = {
    pestana: 'carrito',

    montar() {
        if (document.getElementById('mp-panel')) return;
        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <div class="mp-overlay" id="mp-overlay"></div>
            <aside class="mp-panel" id="mp-panel" role="dialog" aria-modal="true" aria-label="Carrito y favoritos" aria-hidden="true">
                <div class="mp-head">
                    <div class="mp-tabs" role="tablist">
                        <button class="mp-tab" role="tab" data-tab="carrito">${icon('cart', 16)} Carrito <span class="mp-tab-n" id="mp-n-carrito"></span></button>
                        <button class="mp-tab" role="tab" data-tab="favoritos">${icon('heart', 16)} Favoritos <span class="mp-tab-n" id="mp-n-favoritos"></span></button>
                    </div>
                    <button class="modal-close" id="mp-close" aria-label="Cerrar">${icon('x', 20)}</button>
                </div>
                <div class="mp-body" id="mp-body"><div class="mp-vacio">Cargando…</div></div>
                <div class="mp-foot" id="mp-foot"></div>
            </aside>`;
        document.body.append(...wrap.children);

        document.getElementById('mp-overlay').addEventListener('click', () => this.cerrar());
        document.getElementById('mp-close').addEventListener('click', () => this.cerrar());
        document.querySelectorAll('.mp-tab').forEach((b) =>
            b.addEventListener('click', () => this.mostrar(b.dataset.tab)));
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.cerrar(); });

        // Iconos de la barra (y la barra inferior en móvil) abren el panel en vez de navegar
        document.querySelectorAll('[data-panel]').forEach((a) => a.addEventListener('click', (e) => {
            const tab = a.dataset.panel;
            // En la propia página completa no tiene caso abrir el panel de lo mismo
            if ((tab === 'carrito' && location.pathname === '/carrito.html') ||
                (tab === 'favoritos' && location.pathname === '/favoritos.html')) return;
            e.preventDefault();
            this.abrir(tab);
        }));
    },

    abrir(tab) {
        document.getElementById('mp-panel').classList.add('open');
        document.getElementById('mp-panel').setAttribute('aria-hidden', 'false');
        document.getElementById('mp-overlay').classList.add('open');
        document.body.classList.add('mp-lock');
        this.mostrar(tab || this.pestana);
    },

    cerrar() {
        const p = document.getElementById('mp-panel');
        clearTimeout(this._autoCierre);
        this._recien = null;
        if (!p || !p.classList.contains('open')) return;
        p.classList.remove('open');
        p.setAttribute('aria-hidden', 'true');
        document.getElementById('mp-overlay').classList.remove('open');
        document.body.classList.remove('mp-lock');
    },

    mostrar(tab) {
        this.pestana = tab;
        document.querySelectorAll('.mp-tab').forEach((b) => {
            const on = b.dataset.tab === tab;
            b.classList.toggle('on', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        return tab === 'favoritos' ? this.pintarFavoritos() : this.pintarCarrito();
    },

    // Confirmación al agregar: abre el panel en Carrito con un aviso arriba y
    // el producto resaltado. Se cierra solo a los 5 s si no se toca.
    async confirmarAgregado(productoId, cantidad = 1) {
        if (location.pathname === '/carrito.html') {   // ya se está viendo el carrito
            if (window.toast) toast('Agregado al carrito', 'ok');
            this.sincronizar('carrito');
            return;
        }
        this._recien = Number(productoId);
        this.abrir('carrito');
        clearTimeout(this._autoCierre);
        const panel = document.getElementById('mp-panel');
        const programar = () => { clearTimeout(this._autoCierre); this._autoCierre = setTimeout(() => { if (!panel.matches(':hover')) this.cerrar(); }, 5000); };
        programar();
        if (!panel._kzHover) {
            panel._kzHover = true;
            panel.addEventListener('mouseleave', () => { if (panel.classList.contains('open') && this._recien) programar(); });
            panel.addEventListener('mouseenter', () => clearTimeout(this._autoCierre));
            panel.addEventListener('click', () => { clearTimeout(this._autoCierre); this._recien = null; });
        }
    },

    // Avisa a la página actual (carrito.html, catálogo...) que algo cambió
    sincronizar(tipo, detalle) {
        actualizarBadgeCarrito();
        actualizarBadgeFavoritos();
        if (tipo === 'carrito' && location.pathname === '/carrito.html') {
            if (Sesion.cliente() && window.cargarCarrito) window.cargarCarrito();
            else if (window.cargarCarritoInvitado) window.cargarCarritoInvitado();
        }
        if (tipo === 'favoritos' && detalle && detalle.productoId) {
            if (window.Favoritos) Favoritos._set.delete(Number(detalle.productoId));
            document.querySelectorAll(`#producto-${detalle.productoId} .fav-btn`).forEach((b) => b.classList.remove('on'));
        }
        document.dispatchEvent(new CustomEvent('kz:' + tipo + '-cambio', { detail: detalle || {} }));
    },

    // ---------- Carrito ----------
    async itemsCarrito() {
        if (Sesion.cliente()) {
            const c = Sesion.cliente();
            const rows = await api(`/carrito/${c.id}`);
            return rows.map((r) => ({
                id: r.id, producto_id: r.producto_id, nombre: r.nombre, precio: Number(r.precio),
                precio_final: Number(r.precio_final ?? r.precio), promocion: r.promocion,
                imagen_url: r.imagen_url, stock: Number(r.stock), cantidad: r.cantidad,
                garantia: r.garantia_plan, garantia_costo: Number(r.garantia_costo || 0),
            }));
        }
        const lista = CarritoInvitado.leer();
        const prods = await Promise.all(lista.map((it) => api(`/productos/${it.producto_id}`).catch(() => null)));
        return lista.map((it, i) => prods[i] && ({
            id: it.producto_id, producto_id: it.producto_id, nombre: prods[i].nombre, precio: Number(prods[i].precio),
            precio_final: Number(prods[i].precio_final ?? prods[i].precio), promocion: prods[i].promocion,
            imagen_url: prods[i].imagen_url, categoria_nombre: prods[i].categoria_nombre,
            stock: Number(prods[i].stock), cantidad: it.cantidad, garantia: null, garantia_costo: 0,
        })).filter(Boolean);
    },

    async pintarCarrito() {
        const body = document.getElementById('mp-body');
        const foot = document.getElementById('mp-foot');
        let items = [];
        try { items = await this.itemsCarrito(); }
        catch (e) { body.innerHTML = `<div class="mp-vacio">${e.message}</div>`; foot.innerHTML = ''; return; }
        if (this.pestana !== 'carrito') return;   // el usuario cambió de pestaña mientras cargaba
        const n = items.reduce((a, i) => a + i.cantidad, 0);
        document.getElementById('mp-n-carrito').textContent = n ? n : '';

        if (!items.length) {
            body.innerHTML = `<div class="mp-vacio">${icon('cart', 34)}<p>Tu carrito está vacío.</p>
                <a href="/index.html?ver=todo" class="btn btn-outline btn-sm">Ver catálogo</a></div>`;
            foot.innerHTML = '';
            return;
        }
        const recien = this._recien ? items.find((i) => Number(i.producto_id) === this._recien) : null;
        body.innerHTML = (recien ? `<div class="mp-agregado" role="status">${icon('check', 16)} <span><strong>Agregado al carrito</strong>${Sesion.cliente() ? '' : '<br><small>Se guarda aunque no hayas iniciado sesión.</small>'}</span></div>` : '')
          + items.map((it) => `
            <div class="mp-item ${recien && it === recien ? 'mp-nuevo' : ''}">
                <img src="${imagenProducto(it)}" alt="" onerror="this.src='/img/producto.svg'">
                <div class="mp-info">
                    <div class="mp-nombre">${it.nombre}</div>
                    <div class="mp-precio">${precioHTML(it)}${it.garantia ? ` <span class="mp-gar">+ ${it.garantia}</span>` : ''}</div>
                    <div class="mp-acciones">
                        <div class="mp-qty">
                            <button data-act="menos" data-id="${it.id}" ${it.cantidad <= 1 ? 'disabled' : ''} aria-label="Menos">${icon('minus', 14)}</button>
                            <span>${it.cantidad}</span>
                            <button data-act="mas" data-id="${it.id}" ${it.cantidad >= it.stock ? 'disabled' : ''} aria-label="Más">${icon('plus', 14)}</button>
                        </div>
                        <button class="mp-quitar" data-act="quitar" data-id="${it.id}">Quitar</button>
                    </div>
                </div>
                <div class="mp-sub">${formatoMoneda(it.precio_final * it.cantidad + it.garantia_costo)}</div>
            </div>`).join('');

        const subtotal = items.reduce((a, i) => a + i.precio_final * i.cantidad + i.garantia_costo, 0);
        const ahorro = items.reduce((a, i) => a + (i.precio - i.precio_final) * i.cantidad, 0);
        const faltaEnvio = Math.max(0, 10000 - subtotal);
        foot.innerHTML = `
            <div class="mp-total"><span>Subtotal (${n} ${n === 1 ? 'pieza' : 'piezas'})</span><strong>${formatoMoneda(subtotal)}</strong></div>
            ${ahorro > 0 ? `<div class="mp-nota mp-ahorro">${icon('star', 13)} Ahorras ${formatoMoneda(ahorro)} con promociones</div>` : ''}
            <div class="mp-nota">${faltaEnvio > 0 ? `Te faltan ${formatoMoneda(faltaEnvio)} para el envío gratis.` : 'Tu pedido ya tiene envío gratis.'} IVA y envío se calculan al pagar.</div>
            <a href="/carrito.html" class="btn btn-primary btn-block">${Sesion.cliente() ? 'Ir a pagar' : 'Ver carrito y pagar'} ${icon('arrow', 16)}</a>
            <button class="btn btn-ghost btn-block" id="mp-seguir">Seguir comprando</button>`;
        document.getElementById('mp-seguir').addEventListener('click', () => this.cerrar());

        body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () =>
            this.accionCarrito(b.dataset.act, Number(b.dataset.id), items.find((i) => i.id === Number(b.dataset.id)))));
    },

    async accionCarrito(act, id, it) {
        if (!it) return;
        try {
            if (Sesion.cliente()) {
                if (act === 'quitar') await api(`/carrito/${id}`, { method: 'DELETE' });
                else await api(`/carrito/${id}`, { method: 'PUT', body: { cantidad: it.cantidad + (act === 'mas' ? 1 : -1) } });
            } else {
                if (act === 'quitar') CarritoInvitado.quitar(id);
                else CarritoInvitado.cambiar(id, { cantidad: Math.min(it.stock, Math.max(1, it.cantidad + (act === 'mas' ? 1 : -1))) });
            }
            if (act === 'quitar' && window.toast) toast('Producto quitado del carrito', 'ok');
        } catch (e) { if (window.toast) toast(e.message, 'error'); }
        this.sincronizar('carrito');
        this.pintarCarrito();
    },

    // ---------- Favoritos ----------
    async pintarFavoritos() {
        const body = document.getElementById('mp-body');
        const foot = document.getElementById('mp-foot');
        const cliente = Sesion.cliente();
        if (!cliente) {
            body.innerHTML = `<div class="mp-vacio">${icon('heart', 34)}<p>Inicia sesión para guardar y ver tus favoritos.</p>
                <button class="btn btn-primary btn-sm" id="mp-login">Iniciar sesión</button></div>`;
            foot.innerHTML = '';
            document.getElementById('mp-login').addEventListener('click', () => irALogin());
            return;
        }
        let favs = [];
        try {
            // los favoritos no traen la promoción: se toma del catálogo
            const [lista, cat] = await Promise.all([api(`/clientes/${cliente.id}/favoritos`), api('/catalogo?promocion=1').catch(() => [])]);
            this._promos = new Map(cat.map((p) => [p.id, p]));
            favs = lista;
        }
        catch (e) { body.innerHTML = `<div class="mp-vacio">${e.message}</div>`; foot.innerHTML = ''; return; }
        if (this.pestana !== 'favoritos') return;
        document.getElementById('mp-n-favoritos').textContent = favs.length || '';

        if (!favs.length) {
            body.innerHTML = `<div class="mp-vacio">${icon('heart', 34)}<p>Aún no tienes favoritos. Toca el corazón de un producto para guardarlo.</p></div>`;
            foot.innerHTML = '';
            return;
        }
        body.innerHTML = favs.map((p) => `
            <div class="mp-item">
                <img src="${imagenProducto(p)}" alt="" onerror="this.src='/img/producto.svg'">
                <div class="mp-info">
                    <div class="mp-nombre">${p.nombre}</div>
                    <div class="mp-precio">${precioHTML(decorarProductoFav(p))}
                        <span class="mp-stock ${Number(p.stock) > 0 ? '' : 'agotado'}">${Number(p.stock) > 0 ? 'En stock' : 'Agotado'}</span></div>
                    <div class="mp-acciones">
                        <button class="btn btn-primary btn-sm" data-fav="carrito" data-id="${p.id}" ${Number(p.stock) > 0 ? '' : 'disabled'}>${icon('cart', 14)} Agregar</button>
                        <button class="mp-quitar" data-fav="quitar" data-id="${p.id}">Quitar</button>
                    </div>
                </div>
            </div>`).join('');
        foot.innerHTML = `<a href="/favoritos.html" class="btn btn-outline btn-block">Ver todos mis favoritos</a>`;

        body.querySelectorAll('[data-fav]').forEach((b) => b.addEventListener('click', async () => {
            const id = Number(b.dataset.id);
            try {
                if (b.dataset.fav === 'carrito') {
                    b.disabled = true;
                    await agregarProducto(id, 1, 'none', { confirmar: false });
                    if (window.toast) toast('Agregado al carrito', 'ok');
                    this.sincronizar('carrito');
                    b.disabled = false;
                    return;
                }
                await api(`/clientes/${cliente.id}/favoritos/${id}`, { method: 'DELETE' });
                this.sincronizar('favoritos', { productoId: id });
                this.pintarFavoritos();
            } catch (e) { b.disabled = false; if (window.toast) toast(e.message, 'error'); }
        }));
    },
};
window.MiniPanel = MiniPanel;
function decorarProductoFav(p) {
    const c = MiniPanel._promos && MiniPanel._promos.get(p.id);
    return c ? { ...p, precio_final: c.precio_final, promocion: c.promocion } : p;
}

// =========================================================
// BOTÓN "REGRESAR"
// En las páginas que no son la portada aparece una flecha para volver a
// donde estaba el cliente (o a la tienda si llegó directo por enlace).
// =========================================================
// Migas de pan de cada página (el catálogo tiene las suyas)
const CUENTA_MIGA = ['Mi cuenta', '/perfil.html'];
const MIGAS = {
    '/carrito.html': [['Carrito']],
    '/comparar.html': [['Catálogo', '/index.html?ver=todo'], ['Comparar productos']],
    '/armar-pc.html': [['Catálogo', '/index.html?ver=todo'], ['Arma tu PC']],
    '/ayuda.html': [['Centro de ayuda']],
    '/login.html': [['Iniciar sesión']],
    '/registro.html': [['Crear cuenta']],
    '/perfil.html': [['Mi cuenta']],
    '/pedidos.html': [CUENTA_MIGA, ['Mis pedidos']],
    '/recibo.html': [CUENTA_MIGA, ['Mis pedidos', '/pedidos.html'], ['Comprobante']],
    '/recompensas.html': [CUENTA_MIGA, ['Club de puntos']],
    '/monedero.html': [CUENTA_MIGA, ['Mi monedero']],
    '/favoritos.html': [CUENTA_MIGA, ['Favoritos']],
    '/resenas.html': [CUENTA_MIGA, ['Mis reseñas']],
    '/garantias.html': [CUENTA_MIGA, ['Mis garantías']],
    '/direcciones.html': [CUENTA_MIGA, ['Direcciones']],
    '/pagos.html': [CUENTA_MIGA, ['Métodos de pago']],
    '/soporte.html': [CUENTA_MIGA, ['Soporte']],
    '/datos.html': [CUENTA_MIGA, ['Mis datos']],
    '/seguridad.html': [CUENTA_MIGA, ['Seguridad']],
    '/preferencias.html': [CUENTA_MIGA, ['Preferencias']],
};

function renderBotonRegresar() {
    const enPortada = (location.pathname === '/' || location.pathname === '/index.html') && !location.search;
    // Tras pagar no tiene sentido "regresar" al checkout
    if (location.pathname === '/gracias.html') return;
    const ph = document.getElementById('navbar-placeholder');
    if (enPortada || !ph || document.getElementById('kz-regresar')) return;

    let vieneDeLaTienda = false;
    try { vieneDeLaTienda = !!document.referrer && new URL(document.referrer).origin === location.origin && document.referrer !== location.href; }
    catch { /* referrer inválido */ }

    const bar = document.createElement('div');
    bar.className = 'container regresar-bar';
    const migas = MIGAS[location.pathname];
    bar.innerHTML = `<button class="btn-regresar" id="kz-regresar" type="button">
        <span class="br-ico">${icon('arrow', 16)}</span> ${vieneDeLaTienda ? 'Regresar' : 'Volver a la tienda'}</button>
        ${migas ? `<nav class="migas" aria-label="Estás en"><a href="/index.html">Inicio</a>${migas.map(([t, h], i) =>
            ` <span aria-hidden="true">/</span> ${i === migas.length - 1 ? `<span aria-current="page">${t}</span>` : `<a href="${h}">${t}</a>`}`).join('')}</nav>` : ''}`;
    ph.insertAdjacentElement('afterend', bar);
    document.getElementById('kz-regresar').addEventListener('click', () => {
        if (vieneDeLaTienda && history.length > 1) history.back();
        else location.href = '/index.html';
    });
}

async function actualizarBadgeFavoritos() {
    const el = document.getElementById('fav-badge');
    const cliente = window.Sesion ? Sesion.cliente() : null;
    if (!el || !cliente) { if (el) el.style.display = 'none'; return; }
    try {
        const favs = await api(`/clientes/${cliente.id}/favoritos`);
        el.textContent = favs.length;
        el.style.display = favs.length > 0 ? 'flex' : 'none';
    } catch { el.style.display = 'none'; }
}

function renderFooter() {
    const el = document.getElementById('footer-placeholder');
    if (!el) return;
    const cliente = window.Sesion ? Sesion.cliente() : null;
    el.innerHTML = `
        <footer>
            <div class="container footer-grid">
                <div>
                    <div class="brand" style="margin-bottom:10px"><span class="brand-mark">${logoKZK(13)}</span> Kozmok</div>
                    <p style="font-size:.85rem">Cómputo y electrónica con stock real, comparador de especificaciones y asesor de compra.</p>
                </div>
                <div>
                    <h4>Comprar</h4>
                    <a href="/index.html">Catálogo completo</a>
                    <a href="/armar-pc.html">Arma tu PC</a>
                    <a href="/index.html?categoria=Laptops">Laptops</a>
                    <a href="/index.html?categoria=Componentes">Componentes</a>
                    <a href="/index.html?categoria=Perif%C3%A9ricos">Periféricos</a>
                </div>
                <div>
                    <h4>Ayuda</h4>
                    <a href="/ayuda.html#envios">Envíos y entregas</a>
                    <a href="/ayuda.html#devoluciones">Devoluciones</a>
                    <a href="/ayuda.html#garantia">Garantía</a>
                    <a href="/ayuda.html#contacto">Contacto</a>
                </div>
                <div>
                    <h4>Cuenta</h4>
                    ${cliente
                        ? `<a href="/perfil.html">Mi cuenta</a><a href="/pedidos.html">Mis pedidos</a><a href="/favoritos.html">Favoritos</a>`
                        : `<a href="/login.html">Iniciar sesión</a><a href="/registro.html">Crear cuenta</a>`}
                    <a href="/ayuda.html">Centro de ayuda</a>
                </div>
            </div>
            <div class="container footer-legal">
                <span>© ${new Date().getFullYear()} Kozmok · Cómputo y electrónica</span>
                <span class="footer-tema">
                    <label for="tema-quick">Tema</label>
                    <select id="tema-quick" aria-label="Cambiar tema de color">
                        ${(window.Tema ? Tema.lista : []).map((t) => `<option value="${t.clave}">${t.nombre}</option>`).join('')}
                    </select>
                    · <a href="/ayuda.html#cookies">Cookies</a>
                </span>
            </div>
        </footer>
    `;

    const sel = document.getElementById('tema-quick');
    if (sel && window.Tema) {
        sel.value = Tema.actual();
        sel.addEventListener('change', () => Tema.aplicar(sel.value));
    }
}

// ---- Cookies ----
function getCookie(nombre) {
    const par = document.cookie.split('; ').find((c) => c.startsWith(nombre + '='));
    return par ? decodeURIComponent(par.split('=').slice(1).join('=')) : null;
}
window.getCookie = getCookie;

function renderCookieConsent() {
    if (getCookie('kz_consent')) return;  // ya lo aceptó antes -> no volver a mostrar
    const el = document.createElement('div');
    el.className = 'cookie-bar';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Aviso de cookies');
    el.innerHTML = `
        <div class="cookie-inner">
            <p>Usamos cookies para mantener tu sesión, tu carrito y tus preferencias.
               Al continuar aceptas su uso. <a href="/ayuda.html#cookies">Más información</a>.</p>
            <div class="cookie-actions">
                <button class="btn btn-outline btn-sm" id="cookie-min">Solo esenciales</button>
                <button class="btn btn-primary btn-sm" id="cookie-ok">Aceptar</button>
            </div>
        </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));

    const guardar = (valor) => {
        // 1 año; solo desaparece de verdad si el usuario borra las cookies del navegador
        document.cookie = `kz_consent=${valor}; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`;
        el.classList.remove('show');
        setTimeout(() => el.remove(), 350);
    };
    document.getElementById('cookie-ok').addEventListener('click', () => guardar('all'));
    document.getElementById('cookie-min').addEventListener('click', () => guardar('essential'));
}

document.addEventListener('DOMContentLoaded', () => {
    renderNavbar();
    renderFooter();
    renderCookieConsent();
});
