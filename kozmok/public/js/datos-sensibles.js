// =========================================================
// Datos sensibles en tickets (tomado de la rama de Gael, soporte-ti.js).
// Lo usan el servidor (require) y el panel (<script>): misma regla en los dos.
// - enmascararSensible(texto): quita número completo de tarjeta (deja los
//   últimos 4, solo si pasa la prueba de Luhn), CVV, NIP y contraseñas
//   escritas, antes de guardar un mensaje.
// - pideDatoSensible(texto): ¿una respuesta del equipo le pide al cliente
//   un dato que nunca se pide (contraseña, tarjeta completa, CVV, NIP,
//   códigos)? "Nunca te pediremos tu contraseña" no cuenta.
// =========================================================
(function (raiz) {
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

    const api = { enmascararSensible, pideDatoSensible };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else raiz.Sensible = api;
})(typeof window !== 'undefined' ? window : this);
