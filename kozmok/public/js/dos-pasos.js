// =========================================================
// Verificación en dos pasos y "No soy un robot" (tienda y panel)
//   Captcha.montar(el)           casilla de Google reCAPTCHA (si está configurada)
//   DosPasos.pedir(respuesta)    ventana para escribir el código al entrar
//   DosPasos.montarConfig(el, base)  activar / cambiar / desactivar
// Necesita api.js e icons.js. El QR usa js/vendor/qrcode-generator.js (MIT).
// =========================================================
(function () {
    const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = (n, s = 16) => (window.icon ? icon(n, s) : '');
    const avisar = (m, t = 'info') => (window.toast ? toast(m, t) : alert(m));

    // ---------------------------------------------------------
    // Google reCAPTCHA v2 (casilla). Sin claves en el servidor no aparece.
    // ---------------------------------------------------------
    let cfgCaptcha = null, cargaScript = null;
    const configCaptcha = () => (cfgCaptcha = cfgCaptcha || api('/config/captcha').catch(() => ({ activo: false })));
    function cargarRecaptcha() {
        if (cargaScript) return cargaScript;
        cargaScript = new Promise((resolve, reject) => {
            window.__kzRecaptchaListo = () => resolve(window.grecaptcha);
            const s = document.createElement('script');
            s.src = 'https://www.google.com/recaptcha/api.js?onload=__kzRecaptchaListo&render=explicit&hl=es';
            s.async = true; s.defer = true;
            s.onerror = () => { cargaScript = null; reject(new Error('No se pudo cargar la casilla "No soy un robot". Revisa tu conexión a internet.')); };
            document.head.appendChild(s);
        });
        return cargaScript;
    }
    const Captcha = {
        // Devuelve { activo, token(), reiniciar() }. token() es null si no se marcó.
        async montar(el) {
            const nulo = { activo: false, token: () => null, reiniciar() {}, listo: true };
            if (!el) return nulo;
            const cfg = await configCaptcha();
            if (!cfg.activo || !cfg.site_key) { el.hidden = true; return nulo; }
            el.hidden = false;
            el.classList.add('captcha-caja');
            el.innerHTML = '<div class="captcha-cargando">Cargando verificación…</div>';
            try {
                const g = await cargarRecaptcha();
                el.innerHTML = '';
                const tema = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
                const id = g.render(el, { sitekey: cfg.site_key, theme: tema });
                return { activo: true, token: () => g.getResponse(id) || null, reiniciar: () => { try { g.reset(id); } catch { /* sin widget */ } } };
            } catch (e) {
                el.innerHTML = `<div class="captcha-error">${esc(e.message)}</div>`;
                return { activo: true, token: () => null, reiniciar() {} };
            }
        },
    };
    window.Captcha = Captcha;

    // ---------------------------------------------------------
    // Ventanas
    // ---------------------------------------------------------
    function ventana(html, { ancho = 440, alCerrar } = {}) {
        const ov = document.createElement('div');
        ov.className = 'confirm-overlay dp-overlay';
        ov.innerHTML = `<div class="confirm-box dp-box" role="dialog" aria-modal="true" style="max-width:${ancho}px">${html}</div>`;
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.classList.add('open'));
        const cerrar = (valor) => {
            if (ov.cerrada) return; ov.cerrada = true;
            ov.classList.remove('open'); document.removeEventListener('keydown', escKey);
            setTimeout(() => ov.remove(), 200);
            if (alCerrar) alCerrar(valor);
        };
        const escKey = (e) => { if (e.key === 'Escape') cerrar(null); };
        document.addEventListener('keydown', escKey);
        ov.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => cerrar(null)));
        return { ov, cerrar, $: (s) => ov.querySelector(s) };
    }
    // Pide la contraseña (sin recortar espacios, a diferencia de pedirDato).
    function pedirPassword(mensaje) {
        return new Promise((resolve) => {
            const v = ventana(`
                <div class="dp-cab">${ic('lock', 20)}<h3>Confirma que eres tú</h3></div>
                <p class="dp-texto">${esc(mensaje)}</p>
                <form class="dp-form" autocomplete="on">
                    <input type="password" class="dp-pass" autocomplete="current-password" placeholder="Tu contraseña" required />
                    <div class="dp-acciones"><button type="button" class="btn btn-outline btn-sm" data-x>Cancelar</button><button type="submit" class="btn btn-primary btn-sm">Continuar</button></div>
                </form>`, { ancho: 400, alCerrar: (val) => resolve(val) });
            const inp = v.$('.dp-pass');
            setTimeout(() => inp.focus(), 60);
            v.$('form').addEventListener('submit', (e) => { e.preventDefault(); if (inp.value) v.cerrar(inp.value); });
        });
    }
    const campoCodigo = () => `<input class="dp-codigo" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 ]*" placeholder="000000" aria-label="Código de 6 dígitos" />`;
    const leerCodigo = (inp) => inp.value.replace(/\D/g, '');

    // ---------------------------------------------------------
    // Segundo paso al entrar. resp = respuesta del login con requiere_2fa.
    // Resuelve con la respuesta final (sesión abierta) o null si se cancela.
    // ---------------------------------------------------------
    function pedir(resp) {
        return new Promise((resolve) => {
            let desafio = resp.desafio, metodo = resp.metodo, correoMandado = metodo === 'correo', espera = 0, reloj = null;
            const v = ventana(`
                <div class="dp-cab">${ic('lock', 20)}<h3>Verificación en dos pasos</h3><button type="button" class="dp-cerrar" data-x aria-label="Cancelar">${ic('x', 18)}</button></div>
                <p class="dp-texto dp-instruccion"></p>
                <form class="dp-form">
                    ${campoCodigo()}
                    <div class="dp-error" hidden></div>
                    <button type="submit" class="btn btn-primary dp-ancho">Verificar y entrar</button>
                </form>
                <div class="dp-alterno"><button type="button" class="dp-link dp-correo"></button></div>`, {
                ancho: 420, alCerrar: (val) => { clearInterval(reloj); resolve(val); },
            });
            const inp = v.$('.dp-codigo'), err = v.$('.dp-error'), btn = v.$('button[type=submit]'), bCorreo = v.$('.dp-correo');
            const pintar = () => {
                v.$('.dp-instruccion').innerHTML = metodo === 'app' && !correoMandado
                    ? `Abre tu <strong>app autenticadora</strong> (Google o Microsoft Authenticator) y escribe el código de 6 dígitos de <strong>Kozmok</strong>.`
                    : `Te mandamos un código de 6 dígitos a <strong>${esc(resp.correo)}</strong>. Si no lo ves, revisa la carpeta de spam.`
                      + (metodo === 'app' ? ' También puedes usar el código de tu app.' : '');
                if (!resp.puede_correo) { bCorreo.hidden = true; return; }
                bCorreo.hidden = false;
                bCorreo.disabled = espera > 0;
                bCorreo.textContent = espera > 0 ? `Reenviar código en ${espera} s`
                    : correoMandado ? 'Reenviar código a mi correo' : '¿No tienes tu app a la mano? Mandar código a mi correo';
            };
            const contar = (s) => {
                espera = s; clearInterval(reloj); pintar();
                reloj = setInterval(() => { espera--; pintar(); if (espera <= 0) clearInterval(reloj); }, 1000);
            };
            const mostrarError = (m) => { err.textContent = m; err.hidden = false; };
            const reiniciar = (m) => { avisar(m, 'warn'); v.cerrar(null); };
            pintar();
            if (correoMandado) contar(30);
            setTimeout(() => inp.focus(), 60);
            inp.addEventListener('input', () => { err.hidden = true; if (leerCodigo(inp).length === 6) v.$('form').requestSubmit(); });
            v.$('form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const codigo = leerCodigo(inp);
                if (codigo.length !== 6) return mostrarError('Escribe los 6 dígitos del código');
                btn.disabled = true; btn.textContent = 'Verificando…';
                try {
                    const r = await api('/auth/2fa/verificar', { method: 'POST', body: { desafio, codigo } });
                    v.cerrar(r);
                } catch (ex) {
                    if (ex.datos && ex.datos.reiniciar) return reiniciar(ex.message);
                    if (ex.status === 429 || ex.status === 423) return reiniciar(ex.message);
                    mostrarError(ex.message); inp.value = ''; inp.focus();
                    btn.disabled = false; btn.textContent = 'Verificar y entrar';
                }
            });
            bCorreo.addEventListener('click', async () => {
                bCorreo.disabled = true;
                try {
                    const r = await api('/auth/2fa/correo', { method: 'POST', body: { desafio } });
                    correoMandado = true; avisar(r.message, 'ok'); contar(r.espera || 30); inp.focus();
                } catch (ex) {
                    if (ex.datos && ex.datos.reiniciar) return reiniciar(ex.message);
                    if (ex.datos && ex.datos.espera) contar(ex.datos.espera); else { bCorreo.disabled = false; }
                    mostrarError(ex.message);
                }
            });
        });
    }

    // ---------------------------------------------------------
    // Configuración (Seguridad de la tienda / menú del panel)
    //   base: '/clientes/12/2fa' o '/admin/mi-2fa'
    // ---------------------------------------------------------
    function qrSVG(texto) {
        if (typeof window.qrcode !== 'function') return '';
        const q = window.qrcode(0, 'M');
        q.addData(texto); q.make();
        return q.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
    }
    async function asegurarQR() {
        if (typeof window.qrcode === 'function') return;
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = '/js/vendor/qrcode-generator.js';
            s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar el generador de QR'));
            document.head.appendChild(s);
        });
    }

    function altaApp(base, alListo) {
        return (async () => {
            const pass = await pedirPassword('Para configurar la app autenticadora escribe tu contraseña.');
            if (!pass) return;
            let r;
            try { await asegurarQR(); r = await api(base + '/app', { method: 'POST', body: { password: pass } }); }
            catch (e) { return avisar(e.message, 'error'); }
            const clave = r.secreto.match(/.{1,4}/g).join(' ');
            const v = ventana(`
                <div class="dp-cab">${ic('lock', 20)}<h3>Configurar app autenticadora</h3><button type="button" class="dp-cerrar" data-x aria-label="Cerrar">${ic('x', 18)}</button></div>
                <ol class="dp-pasos">
                    <li>Instala en tu celular <strong>Google Authenticator</strong> o <strong>Microsoft Authenticator</strong> (gratis).</li>
                    <li>En la app toca <strong>+</strong> y <strong>escanea este código</strong>:</li>
                </ol>
                <div class="dp-qr">${qrSVG(r.uri)}</div>
                <details class="dp-manual"><summary>¿No puedes escanear? Escribe la clave a mano</summary>
                    <div class="dp-clave"><code>${esc(clave)}</code><button type="button" class="td-copiar dp-copiar">${ic('clipboard', 14)}<span>Copiar</span></button></div>
                    <p class="dp-nota">Tipo: basada en tiempo · Cuenta: Kozmok</p>
                </details>
                <ol class="dp-pasos" start="3"><li>Escribe el código de 6 dígitos que muestra la app:</li></ol>
                <form class="dp-form">${campoCodigo()}<div class="dp-error" hidden></div>
                    <div class="dp-acciones"><button type="button" class="btn btn-outline btn-sm" data-x>Cancelar</button><button type="submit" class="btn btn-primary btn-sm">Activar</button></div>
                </form>`, { ancho: 460 });
            const inp = v.$('.dp-codigo'), err = v.$('.dp-error');
            v.$('.dp-copiar').addEventListener('click', async (e) => {
                const ok = window.copiarTexto ? await copiarTexto(r.secreto) : false;
                avisar(ok ? 'Clave copiada' : 'Selecciónala y cópiala a mano', ok ? 'ok' : 'warn');
                e.currentTarget.blur();
            });
            inp.addEventListener('input', () => { err.hidden = true; });
            v.$('form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const codigo = leerCodigo(inp);
                if (codigo.length !== 6) { err.textContent = 'Escribe los 6 dígitos que muestra la app'; err.hidden = false; return; }
                try {
                    const res = await api(base + '/app/confirmar', { method: 'POST', body: { codigo } });
                    v.cerrar(); avisar(res.message, 'ok'); alListo();
                } catch (ex) { err.textContent = ex.message; err.hidden = false; inp.value = ''; inp.focus(); }
            });
        })();
    }

    async function montarConfig(el, base) {
        if (!el) return;
        el.innerHTML = '<p class="dp-texto">Cargando…</p>';
        let st;
        try { st = await api(base); } catch (e) { el.innerHTML = `<p class="dp-error">${esc(e.message)}</p>`; return; }
        const recargar = () => montarConfig(el, base);
        const enUso = (m) => st.metodo === m;
        const estado = st.metodo
            ? `<span class="dp-estado on">${ic('check', 14)} Activada · ${st.metodo === 'app' ? 'app autenticadora' : 'código por correo'}</span>`
            : '<span class="dp-estado off">Desactivada</span>';
        el.innerHTML = `
            <div class="dp-resumen">${estado}${st.obligatoria ? '<span class="dp-estado nota">Obligatoria en el panel</span>' : ''}</div>
            <p class="dp-texto">${st.obligatoria
                ? 'Al entrar al panel, además de tu contraseña te pedimos un código. Elige de dónde quieres recibirlo.'
                : 'Además de tu contraseña, al entrar te pediremos un código. Así, aunque alguien conozca tu contraseña, no podrá entrar a tu cuenta.'}</p>
            <div class="dp-opciones">
                <div class="dp-opcion ${enUso('app') ? 'activa' : ''}">
                    <div class="dp-op-tit">${ic('lock', 16)} App autenticadora <span class="dp-reco">Recomendada</span>${enUso('app') ? '<span class="dp-uso">En uso</span>' : ''}</div>
                    <p>Google o Microsoft Authenticator te dan un código nuevo cada 30 segundos, aunque no tengas internet.</p>
                    <button type="button" class="btn ${enUso('app') ? 'btn-outline' : 'btn-primary'} btn-sm" data-accion="app">${enUso('app') ? 'Configurar en otro celular' : 'Usar app'}</button>
                </div>
                <div class="dp-opcion ${enUso('correo') ? 'activa' : ''}">
                    <div class="dp-op-tit">${ic('mail', 16)} Código por correo${enUso('correo') ? '<span class="dp-uso">En uso</span>' : ''}</div>
                    <p>Te mandamos un código a ${esc(st.correo)} cada vez que entres.</p>
                    ${enUso('correo') ? '' : `<button type="button" class="btn btn-outline btn-sm" data-accion="correo" ${st.puede_correo && st.correo_verificado ? '' : 'disabled'}>Usar correo</button>`}
                    ${!st.correo_verificado ? '<p class="dp-nota">Primero confirma tu correo para usar esta opción.</p>' : !st.puede_correo ? '<p class="dp-nota">Por ahora no disponible.</p>' : ''}
                </div>
            </div>
            ${st.metodo && !st.obligatoria ? '<button type="button" class="dp-link dp-peligro" data-accion="desactivar">Desactivar verificación en dos pasos</button>' : ''}`;
        el.querySelectorAll('[data-accion]').forEach((b) => b.addEventListener('click', async () => {
            const a = b.dataset.accion;
            if (a === 'app') return altaApp(base, recargar);
            const pass = await pedirPassword(a === 'correo'
                ? 'Para recibir los códigos en tu correo escribe tu contraseña.'
                : 'Para desactivar la verificación en dos pasos escribe tu contraseña. Tu cuenta quedará protegida solo con la contraseña.');
            if (!pass) return;
            try {
                const r = await api(`${base}/${a === 'correo' ? 'correo' : 'desactivar'}`, { method: 'POST', body: { password: pass } });
                avisar(r.message, 'ok'); recargar();
            } catch (e) { avisar(e.message, 'error'); }
        }));
    }

    window.DosPasos = { pedir, montarConfig, pedirPassword };
})();
