// graficas.js
// Se carga DESPUÉS de Chart.js. Si la librería no se pudo cargar (sin
// internet y sin `npm install`), en lugar de un error rojo "Chart is not
// defined" cada gráfica muestra un aviso entendible y el resto de la
// pantalla (tablas, números) sigue funcionando.
(function () {
    if (window.Chart) return;
    // Acepta cualquier configuración (Chart.defaults.color = …, etc.) sin fallar.
    const absorbe = () => new Proxy(function () {}, {
        get: (t, k) => (k === Symbol.toPrimitive ? () => '' : absorbe()),
        set: () => true,
        apply: () => undefined,
    });
    class SinGrafica {
        constructor(lienzo) {
            const el = typeof lienzo === 'string' ? document.getElementById(lienzo) : (lienzo && lienzo.canvas) || lienzo;
            this.canvas = el;
            if (!el || !el.parentElement) return;
            el.style.display = 'none';
            if (!el.parentElement.querySelector('.grafica-sin-red')) {
                const aviso = document.createElement('div');
                aviso.className = 'grafica-sin-red';
                aviso.textContent = 'No se pudo cargar la gráfica. Revisa la conexión a internet o ejecuta "npm install" en el servidor.';
                el.parentElement.appendChild(aviso);
            }
            this.data = { labels: [], datasets: [] };
            this.options = absorbe();
        }
        update() {} destroy() {} resize() {} reset() {} render() {} stop() {}
    }
    SinGrafica.register = () => {};
    SinGrafica.unregister = () => {};
    SinGrafica.defaults = absorbe();
    SinGrafica.getChart = () => undefined;
    window.Chart = SinGrafica;
    window.CHART_NO_DISPONIBLE = true;
})();
