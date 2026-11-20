// facturama.js — factura electrónica CFDI 4.0 con el PAC Facturama (API Web).
// Sin dependencias: usa fetch de Node 18+.
//
// Por defecto usa el SANDBOX de Facturama: los CFDI se timbran de prueba y
// NO tienen validez fiscal. Para el modo real hacen falta FACTURAMA_MODO=live
// y FACTURAMA_PERMITIR_REAL=1 (con una sola, se queda en sandbox).
//
// .env:
//   FACTURAMA_USUARIO=...           (usuario de tu cuenta sandbox de Facturama)
//   FACTURAMA_PASSWORD=...
//   FACTURA_LUGAR_EXPEDICION=20000  (código postal del domicilio fiscal de la tienda)
//   FACTURA_SERIE=KZ
// Los datos del emisor (RFC, razón social, régimen y sellos CSD) se configuran
// en el perfil de la cuenta de Facturama. En sandbox: RFC EKU9003173C9.
require('./env.js');

const real = process.env.FACTURAMA_MODO === 'live' && process.env.FACTURAMA_PERMITIR_REAL === '1';
const CFG = {
    usuario: (process.env.FACTURAMA_USUARIO || '').trim(),
    password: (process.env.FACTURAMA_PASSWORD || '').trim(),
    modo: real ? 'live' : 'sandbox',
    base: real ? 'https://api.facturama.mx' : (process.env.FACTURAMA_API_PRUEBAS || 'https://apisandbox.facturama.mx'),   // _PRUEBAS: solo pruebas automáticas
    lugar: (process.env.FACTURA_LUGAR_EXPEDICION || '').trim(),
    serie: (process.env.FACTURA_SERIE || 'KZ').trim().slice(0, 25),
};
const configurado = () => !!(CFG.usuario && CFG.password && /^\d{5}$/.test(CFG.lugar));

function errorFacturama(mensaje, detalle, status) {
    const e = new Error(mensaje);
    e.facturama = detalle || null;
    e.status = status || 502;
    e.publico = true;
    return e;
}

// Facturama responde los errores de validación como { Message, ModelState: { campo: [mensajes] } }
function explicar(d) {
    if (!d) return '';
    const partes = [];
    if (d.Message) partes.push(d.Message);
    if (d.ModelState) for (const v of Object.values(d.ModelState)) partes.push(...[].concat(v));
    return partes.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

async function llamar(metodo, ruta, cuerpo) {
    const r = await fetch(CFG.base + ruta, {
        method: metodo,
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${CFG.usuario}:${CFG.password}`).toString('base64'),
            'Content-Type': 'application/json',
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    const txt = await r.text();
    let datos = {};
    try { datos = txt ? JSON.parse(txt) : {}; } catch { datos = { Message: txt.slice(0, 300) }; }
    if (r.status === 401) throw errorFacturama('Facturama rechazó el usuario o la contraseña: revisa FACTURAMA_USUARIO y FACTURAMA_PASSWORD en el .env', datos, 502);
    return { ok: r.ok, status: r.status, datos };
}

// Timbra un CFDI de ingreso. Devuelve { id, uuid, serie, folio, fecha, total }.
async function timbrar(cfdi) {
    const { ok, status, datos } = await llamar('POST', '/3/cfdis', cfdi);
    if (!ok || !datos.Id) {
        const motivo = explicar(datos);
        throw errorFacturama(`El SAT/PAC no aceptó la factura${motivo ? ': ' + motivo : ''}`, datos, status >= 500 ? 502 : 400);
    }
    return {
        id: datos.Id,
        uuid: ((datos.Complement || {}).TaxStamp || {}).Uuid || null,
        serie: datos.Serie || null,
        folio: datos.Folio || null,
        fecha: datos.Date || null,
        total: datos.Total != null ? Number(datos.Total) : null,
    };
}

// PDF o XML del CFDI: { contenido: Buffer, tipo }
async function descargar(id, formato) {
    if (!['pdf', 'xml'].includes(formato)) throw new Error('Formato no válido');
    const { ok, status, datos } = await llamar('GET', `/cfdi/${formato}/issued/${encodeURIComponent(id)}`);
    if (!ok || !datos.Content) throw errorFacturama('No se pudo descargar la factura de Facturama', datos, status);
    return { contenido: Buffer.from(datos.Content, 'base64'), tipo: formato === 'pdf' ? 'application/pdf' : 'application/xml' };
}

// Cancela ante el SAT. motivo: 02 (con errores, sin relación) o 03 (la
// operación no se llevó a cabo). Devuelve { estado: canceled|pending|active, mensaje }.
async function cancelar(id, motivo = '03') {
    if (!['02', '03', '04'].includes(motivo)) throw new Error('Motivo de cancelación no válido');
    const { ok, status, datos } = await llamar('DELETE', `/cfdi/${encodeURIComponent(id)}?type=issued&motive=${motivo}`);
    if (!ok) throw errorFacturama(`No se pudo cancelar la factura${explicar(datos) ? ': ' + explicar(datos) : ''}`, datos, status >= 500 ? 502 : 400);
    return { estado: String(datos.Status || '').toLowerCase() || 'pending', mensaje: datos.Message || null, acuse: datos.AcuseXmlBase64 || null };
}

// Facturama manda el PDF y el XML al correo del cliente (máx. 5 veces en 12 h).
async function enviarPorCorreo(id, correo, asunto) {
    const q = new URLSearchParams({ CfdiType: 'issued', CfdiId: id, Email: correo, Subject: asunto || 'Tu factura de Kozmok' });
    const { ok, datos } = await llamar('POST', `/Cfdi?${q.toString()}`);
    return ok && datos.success !== false;
}

module.exports = { CFG, configurado, timbrar, descargar, cancelar, enviarPorCorreo };
