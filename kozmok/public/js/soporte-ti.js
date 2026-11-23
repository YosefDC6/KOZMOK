// public/js/soporte-ti.js
// =========================================================
// SOPORTE TÉCNICO TI (rol Soporte)
// Reglas del agente de soporte técnico de la tienda en línea: clasificación,
// prioridad P1-P4 por impacto real, estados, metodología de 12 pasos,
// escalamiento, registro técnico y protección de datos. Aquí solo hay
// reglas (sin base de datos). Lo usan el servidor (require) y las
// pantallas de soporte del panel y de la tienda (<script>), así las dos
// partes aplican exactamente las mismas reglas.
// =========================================================

(function (raiz) {
    // ---- Estados (sección 7) ----
    const ESTADOS = {
        abierto: 'Abierto',
        en_revision: 'En revisión',
        en_proceso: 'En proceso',
        esperando_usuario: 'Esperando al usuario',
        escalado: 'Escalado',
        resuelto: 'Resuelto',
        cerrado: 'Cerrado',
    };
    // Casos que siguen en manos de alguien (no están resueltos ni cerrados).
    const ESTADOS_ACTIVOS = ['abierto', 'en_revision', 'en_proceso', 'esperando_usuario', 'escalado'];
    const SQL_ACTIVOS = `('${ESTADOS_ACTIVOS.join("','")}')`;

    // ---- Prioridad (sección 5): P1 crítica .. P4 baja ----
    const PRIORIDADES = {
        critica: { p: 'P1', label: 'Crítica', guia: 'Tienda caída, nadie puede comprar, incidente de seguridad activo o fallas generalizadas de pago.' },
        alta:    { p: 'P2', label: 'Alta',    guia: 'Una función importante interrumpida, un grupo de usuarios no puede comprar o errores generalizados en pedidos o inventario.' },
        media:   { p: 'P3', label: 'Media',   guia: 'Afecta a usuarios individuales, fallas parciales o existe una alternativa temporal.' },
        baja:    { p: 'P4', label: 'Baja',    guia: 'Detalles visuales, consultas técnicas o incidencias que no impiden usar la tienda.' },
    };
    const ORDEN_PRIORIDAD = { critica: 0, alta: 1, media: 2, baja: 3 };

    // ---- Clasificación técnica (sección 4) ----
    const CLASIFICACIONES = {
        acceso: 'Acceso', productos: 'Productos', carrito: 'Carrito', pedidos: 'Pedidos', pagos: 'Pagos',
        inventario: 'Inventario', promociones: 'Promociones', rendimiento: 'Rendimiento',
        notificaciones: 'Notificaciones', administracion: 'Administración', seguridad: 'Seguridad', otros: 'Otros',
    };

    // ---- Lo que elige quien reporta (áreas A-J del alcance + postventa) ----
    // clasif: clasificación técnica inicial que le corresponde.
    const CATEGORIAS = {
        cuenta:         { label: 'Acceso a mi cuenta (iniciar sesión, registro, contraseña, verificación)', clasif: 'acceso' },
        productos:      { label: 'Productos (no aparecen, imágenes, información o categorías)', clasif: 'productos' },
        carrito:        { label: 'Carrito (no agrega, se vacía, cantidades o precios)', clasif: 'carrito' },
        pedido:         { label: 'Un pedido (no aparece, estado o confirmación)', clasif: 'pedidos' },
        pago:           { label: 'Pago (rechazado, pendiente o posible cargo doble)', clasif: 'pagos' },
        inventario:     { label: 'Disponibilidad (aparece agotado o existencias incorrectas)', clasif: 'inventario' },
        promociones:    { label: 'Cupón o promoción (no se aplica o vigencia)', clasif: 'promociones' },
        rendimiento:    { label: 'La página no carga, va lenta o marca un error', clasif: 'rendimiento' },
        notificaciones: { label: 'Correos o notificaciones (no llegan o son incorrectos)', clasif: 'notificaciones' },
        garantia:       { label: 'Garantía', clasif: 'otros' },
        devolucion:     { label: 'Devolución o cambio', clasif: 'pedidos' },
        facturacion:    { label: 'Facturación', clasif: 'pagos' },
        panel:          { label: 'Panel administrativo', clasif: 'administracion', soloEquipo: true },
        general:        { label: 'Otro', clasif: 'otros' },
    };

    // ---- Datos del reporte (sección 3) ----
    const SECCIONES = {
        inicio: 'Inicio o catálogo', producto: 'Ficha de un producto', carrito: 'Carrito', pago: 'Pago (checkout)',
        pedidos: 'Mis pedidos', cuenta: 'Mi cuenta', login: 'Iniciar sesión o crear cuenta', correo: 'Un correo que recibí',
        panel: 'Panel administrativo', otra: 'Otra',
    };
    const IMPACTOS = {
        bloquea: 'No puedo comprar o usar mi cuenta',
        parcial: 'Funciona a medias o hay otra forma de hacerlo',
        menor: 'Es un detalle menor',
    };
    const ALCANCES = { uno: 'Un usuario', varios: 'Varios usuarios', todos: 'Todos los usuarios' };

    // ---- Metodología de resolución (sección 6) ----
    const PASOS = [
        ['leer', 'Leer y comprender el ticket'],
        ['funcionalidad', 'Identificar la funcionalidad afectada'],
        ['impacto', 'Determinar el impacto'],
        ['clasificar', 'Clasificar la incidencia'],
        ['causas', 'Identificar posibles causas'],
        ['info', 'Solicitar información adicional si es necesaria'],
        ['pruebas', 'Realizar o proponer pruebas de diagnóstico autorizadas'],
        ['solucion', 'Determinar una solución'],
        ['verificar', 'Verificar el resultado'],
        ['documentar', 'Documentar las acciones realizadas'],
        ['estado', 'Actualizar el estado del ticket'],
        ['escalar', 'Escalar cuando sea necesario'],
    ];
    const CLAVES_PASOS = PASOS.map(([k]) => k);

    // ---- Escalamiento (sección 8) ----
    const AREAS = {
        desarrollo: 'Desarrollo', infraestructura: 'Infraestructura', base_datos: 'Base de datos',
        seguridad: 'Seguridad', administracion: 'Administración', pagos: 'Pagos',
    };
    const AREAS_DESC = {
        desarrollo: 'Errores de código y funcionalidades',
        infraestructura: 'Servidores, hosting, DNS y disponibilidad',
        base_datos: 'Consultas, integridad y sincronización',
        seguridad: 'Accesos sospechosos y vulnerabilidades',
        administracion: 'Autorizaciones y operaciones comerciales',
        pagos: 'Conciliaciones y problemas con proveedores de pago',
    };
    const MOTIVOS_ESCALAMIENTO = {
        infraestructura: 'Requiere acceso a infraestructura productiva',
        financiero: 'Transacción financiera que necesita intervención autorizada',
        perdida_datos: 'Riesgo de pérdida de información',
        vulnerabilidad: 'Posible vulnerabilidad',
        multiples_usuarios: 'Afecta a múltiples usuarios',
        codigo_bd: 'Requiere cambios en código fuente o base de datos',
        sin_procedimiento: 'No se resuelve con los procedimientos disponibles',
    };
    // Área sugerida para escalar según la clasificación.
    const AREA_SUGERIDA = {
        acceso: 'desarrollo', productos: 'desarrollo', carrito: 'desarrollo', pedidos: 'base_datos', pagos: 'pagos',
        inventario: 'base_datos', promociones: 'administracion', rendimiento: 'infraestructura',
        notificaciones: 'infraestructura', administracion: 'administracion', seguridad: 'seguridad', otros: 'desarrollo',
    };

    // ---- Bitácora técnica (sección 11): lo confirmado separado de las hipótesis ----
    const TIPOS_NOTA = {
        hipotesis: 'Hipótesis', confirmado: 'Confirmado', prueba: 'Prueba de diagnóstico', accion: 'Acción realizada',
        evidencia: 'Evidencia de resolución', nota: 'Nota',
    };

    // ---------------------------------------------------------
    // Clasificación automática: la elección de quien reporta y, si dice algo
    // más específico, lo que describe. Soporte la puede corregir.
    // ---------------------------------------------------------
    const PISTAS = [
        // Seguridad primero: una cuenta robada no es "un problema de acceso".
        ['seguridad', /(hacke|me\s+robaron|robaron\s+mi|cuenta\s+robada|acceso\s+no\s+autorizado|alguien\s+(entr[oó]|us[oó])\s+(a\s+)?mi\s+cuenta|suplant|phishing|fraude|estafa|vulnerab|inyecci[oó]n|xss|cargo\s+no\s+reconocido|no\s+reconozco\s+(el|un|este)?\s*cargo)/i],
        ['pagos', /(pag(o|u[eé])|cobr|cargo|tarjeta|paypal|transferencia|spei|reembols|factur)/i],
        ['acceso', /(no\s+puedo\s+(entrar|iniciar)|iniciar\s+sesi[oó]n|contrase[nñ]a|registr|bloquead|verificaci[oó]n|c[oó]digo\s+de\s+verificaci|se\s+(me\s+)?cierra\s+la\s+sesi|sesi[oó]n\s+se\s+cierra)/i],
        ['promociones', /(cup[oó]n|descuento|promoci)/i],
        ['carrito', /carrito/i],
        ['inventario', /(agotad|existencia|stock|disponib|sin\s+inventario)/i],
        ['rendimiento', /(no\s+carga|no\s+abre|lent[oa]|tarda|pantalla\s+en\s+blanco|error\s*(4\d\d|5\d\d)|\b(400|401|403|404|500|502|503)\b|ca[ií]d[oa]|se\s+traba|navegador|javascript)/i],
        ['notificaciones', /(correo|e-?mail|notificaci|no\s+me\s+lleg)/i],
        ['productos', /(imagen|foto|producto|categor[ií]a|ficha|precio\s+del\s+producto|duplicad)/i],
        ['pedidos', /(pedido|orden|compra|historial|env[ií]o|gu[ií]a)/i],
    ];
    function clasificar(categoria, texto) {
        const base = (CATEGORIAS[categoria] || CATEGORIAS.general).clasif;
        const t = String(texto || '');
        if (PISTAS[0][1].test(t)) return 'seguridad';
        if (base !== 'otros') return base;
        for (const [clave, re] of PISTAS) if (re.test(t)) return clave;
        return 'otros';
    }

    // ---------------------------------------------------------
    // Prioridad sugerida por el IMPACTO REAL (no por la urgencia que exprese
    // quien reporta): qué tanto le impide usar la tienda y a cuántos usuarios
    // afecta. Un incidente de seguridad activo siempre es P1.
    // ---------------------------------------------------------
    const INCIDENTE_ACTIVO = /(hacke|me\s+robaron|cuenta\s+robada|acceso\s+no\s+autorizado|alguien\s+(entr[oó]|us[oó])\s+(a\s+)?mi\s+cuenta|suplant|fuga\s+de\s+datos|cargo\s+no\s+reconocido|no\s+reconozco\s+(el|un|este)?\s*cargo|fraude)/i;
    function prioridadSugerida({ clasificacion, impacto, alcance = 'uno', texto = '' }) {
        if (clasificacion === 'seguridad' && INCIDENTE_ACTIVO.test(String(texto))) return 'critica';
        if (alcance === 'todos' && impacto === 'bloquea') return 'critica';
        if (alcance === 'todos' || (alcance === 'varios' && impacto === 'bloquea')) return 'alta';
        if (clasificacion === 'seguridad') return 'alta';
        if (alcance === 'varios') return 'media';
        if (impacto === 'menor') return 'baja';
        if (impacto === 'bloquea' || impacto === 'parcial') return 'media';
        // Sin dato de impacto: individual y sin bloqueo confirmado.
        return clasificacion === 'otros' ? 'baja' : 'media';
    }
    // Cuántos usuarios distintos reportaron algo de la misma clasificación hace
    // poco: con eso se estima el alcance (un caso aislado o algo generalizado).
    function alcancePorReportes(n) {
        if (n >= 10) return 'todos';
        if (n >= 3) return 'varios';
        return 'uno';
    }

    // ---------------------------------------------------------
    // Protección de datos (sección 9)
    // ---------------------------------------------------------
    function luhn(num) {
        let suma = 0, doble = false;
        for (let i = num.length - 1; i >= 0; i--) {
            let d = Number(num[i]);
            if (doble) { d *= 2; if (d > 9) d -= 9; }
            suma += d; doble = !doble;
        }
        return suma % 10 === 0;
    }
    // Quita de un texto los datos que nunca deben quedar guardados: número
    // completo de tarjeta (deja los últimos 4), CVV, NIP y contraseñas escritas.
    function enmascararSensible(texto) {
        let ocultos = 0;
        let t = String(texto || '');
        t = t.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
            const num = m.replace(/[ -]/g, '');
            if (num.length < 13 || num.length > 19 || !luhn(num)) return m;
            ocultos++;
            return `[tarjeta ****${num.slice(-4)}]`;
        });
        t = t.replace(/\b(cvv|cvc|cvv2|c[oó]digo\s+de\s+seguridad)\b(\s*(es|:|=)?\s*)(\d{3,4})\b/gi, (m, a, b) => { ocultos++; return `${a}${b}[oculto]`; });
        t = t.replace(/\b(nip|pin)\b(\s*(es|:|=)?\s*)(\d{4,6})\b/gi, (m, a, b) => { ocultos++; return `${a}${b}[oculto]`; });
        t = t.replace(/\b(contrase[nñ]a|password|clave)\b(\s*(es|era|:|=)\s*)(\S{4,})/gi, (m, a, b) => { ocultos++; return `${a}${b}[oculta]`; });
        return { texto: t, ocultos };
    }
    // ¿El mensaje del equipo le pide al usuario un dato que nunca se pide?
    // (contraseñas, datos completos de tarjeta, CVV, NIP, códigos de
    // verificación o tokens). "Nunca te pediremos tu contraseña" no cuenta.
    const PIDE = /(env[ií]a(me|nos)?|m[aá]nda(me|nos)?|comp[aá]rte(me|nos)?|compartir|proporci[oó]na(me|nos)?|proporcionar|escr[ií]be(me|nos)?|d[ií](me|nos)|ind[ií]ca(me|nos)?|indicar|conf[ií]rma(me|nos)?|necesit(o|amos|aremos)|requer(imos|iremos)|requiero|p[aá]sa(me|nos)|facil[ií]ta(me|nos)|danos|d[eé]nos|cu[aá]l\s+es|cu[aá]les\s+son|podr[ií]as\s+(darnos|enviarnos|pasarnos|compartir|indicarnos|decirnos|escribirnos)|puedes\s+(darnos|enviarnos|pasarnos|compartir|indicarnos|decirnos|escribirnos))/i;
    const DATO_SENSIBLE = /(contrase[nñ]a|password|clave\s+de\s+acceso|cvv|cvc|c[oó]digo\s+de\s+seguridad\s+de\s+(la|tu)\s+tarjeta|n[uú]mero\s+(completo\s+)?de\s+(la\s+|tu\s+|su\s+)?tarjeta|(los\s+)?16\s+d[ií]gitos|datos\s+(completos\s+)?de\s+(la\s+|tu\s+|su\s+)?tarjeta|\bnip\b|\bpin\b|token|c[oó]digo\s+(de\s+)?(verificaci[oó]n|autenticaci[oó]n|acceso|sms|2fa|de\s+dos\s+pasos)|clave\s+(bancaria|de\s+tu\s+banco))/i;
    function pideDatoSensible(texto) {
        const t = String(texto || '');
        // Se revisa oración por oración: el verbo y el dato en la misma frase.
        for (const frase of t.split(/[.\n!?¿¡;]+/)) {
            const v = frase.match(PIDE);
            if (!v || !DATO_SENSIBLE.test(frase.slice(v.index))) continue;
            const antes = frase.slice(Math.max(0, v.index - 14), v.index).toLowerCase();
            if (/\b(no|nunca|jam[aá]s)\b/.test(antes)) continue;
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------
    // Reglas para cambiar el estado (secciones 6, 7 y 9). Devuelve el motivo
    // por el que no se puede, o null si se puede.
    //   t: el ticket; n: conteo de notas por tipo de la bitácora
    // ---------------------------------------------------------
    function motivoNoCambiar(t, nuevo, n = {}) {
        if (!ESTADOS[nuevo]) return 'Estado no válido';
        if (nuevo === t.estado) return null;
        if (nuevo === 'escalado') return 'Para escalar usa "Escalar": pide el área, el motivo, el resumen técnico y las pruebas realizadas.';
        if (nuevo === 'resuelto') {
            const falta = [];
            if (String(t.diagnostico || '').trim().length < 10) falta.push('el diagnóstico');
            if (!n.accion) falta.push('al menos una acción realizada en la bitácora');
            if (String(t.resultado || '').trim().length < 10) falta.push('el resultado obtenido');
            if (!(t.checklist && t.checklist.verificar)) falta.push('marcar "Verificar el resultado" en la metodología');
            if (t.clasificacion === 'seguridad' && t.escalado_area !== 'seguridad') falta.push('escalarlo a Seguridad (es un posible incidente de seguridad)');
            if (falta.length) return `Para marcarlo como resuelto falta: ${falta.join(', ')}.`;
            return null;
        }
        if (nuevo === 'cerrado') {
            if (t.estado !== 'resuelto') return 'Solo se cierra un ticket resuelto: primero márcalo como resuelto con su diagnóstico, acciones y resultado verificado.';
            if (t.confirmacion === 'persiste') return 'Quien reportó dice que el problema persiste: reábrelo y revísalo antes de cerrarlo.';
            if (t.confirmacion !== 'resuelto' && !n.evidencia) {
                return 'No se cierra sin evidencia: espera la confirmación de quien reportó o registra en la bitácora la evidencia de resolución.';
            }
            return null;
        }
        return null;
    }

    // Navegador y dispositivo a partir del User-Agent (lo manda el navegador
    // solo; nadie lo escribe a mano).
    function describirNavegador(ua) {
        const s = String(ua || '');
        if (!s) return { navegador: null, dispositivo: null };
        const v = (re) => { const m = s.match(re); return m ? m[1].split('.')[0] : ''; };
        let navegador = 'Otro';
        if (/Edg\//.test(s)) navegador = `Edge ${v(/Edg\/([\d.]+)/)}`;
        else if (/OPR\//.test(s)) navegador = `Opera ${v(/OPR\/([\d.]+)/)}`;
        else if (/SamsungBrowser\//.test(s)) navegador = `Samsung Internet ${v(/SamsungBrowser\/([\d.]+)/)}`;
        else if (/Firefox\//.test(s)) navegador = `Firefox ${v(/Firefox\/([\d.]+)/)}`;
        else if (/Chrome\//.test(s)) navegador = `Chrome ${v(/Chrome\/([\d.]+)/)}`;
        else if (/Safari\//.test(s) && /Version\//.test(s)) navegador = `Safari ${v(/Version\/([\d.]+)/)}`;
        let so = 'otro sistema';
        if (/Windows NT/.test(s)) so = 'Windows';
        else if (/Android/.test(s)) so = 'Android';
        else if (/iPhone|iPad|iPod/.test(s)) so = 'iOS';
        else if (/Mac OS X/.test(s)) so = 'macOS';
        else if (/Linux/.test(s)) so = 'Linux';
        const tipo = /iPad|Tablet/.test(s) ? 'Tableta' : /Mobi|Android|iPhone/.test(s) ? 'Celular' : 'Computadora';
        return { navegador: navegador.trim().slice(0, 80), dispositivo: `${tipo} · ${so}`.slice(0, 60) };
    }

    // Datos del reporte que faltan (sección 3): solo se piden los necesarios.
    function datosFaltantes(t) {
        const f = [];
        if (!t.seccion) f.push({ campo: 'seccion', texto: '¿En qué parte de la tienda ocurre el problema (por ejemplo, el carrito, el pago o tu cuenta)?' });
        if (!t.impacto) f.push({ campo: 'impacto', texto: '¿El problema te impide comprar o usar tu cuenta, o puedes seguir de otra forma?' });
        if (!t.mensaje_error && ['rendimiento', 'pagos', 'acceso', 'carrito', 'pedidos', 'administracion'].includes(t.clasificacion)) {
            f.push({ campo: 'mensaje_error', texto: '¿Te apareció algún mensaje de error? Si es así, escríbenos el texto exacto o el folio que aparece.' });
        }
        if (!t.navegador) f.push({ campo: 'navegador', texto: '¿Qué navegador y qué dispositivo usas (por ejemplo, Chrome en una computadora o Safari en iPhone)?' });
        if (!t.adjuntos && ['productos', 'rendimiento', 'carrito', 'promociones', 'administracion'].includes(t.clasificacion)) {
            f.push({ campo: 'evidencia', texto: '¿Podrías adjuntarnos una captura de pantalla de lo que ves?' });
        }
        return f;
    }

    const api = {
        ESTADOS, ESTADOS_ACTIVOS, SQL_ACTIVOS, PRIORIDADES, ORDEN_PRIORIDAD, CLASIFICACIONES, CATEGORIAS, SECCIONES,
        IMPACTOS, ALCANCES, PASOS, CLAVES_PASOS, AREAS, AREAS_DESC, MOTIVOS_ESCALAMIENTO, AREA_SUGERIDA, TIPOS_NOTA,
        clasificar, prioridadSugerida, alcancePorReportes, enmascararSensible, pideDatoSensible, motivoNoCambiar,
        describirNavegador, datosFaltantes,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else raiz.SoporteTI = api;
})(typeof window !== 'undefined' ? window : this);
