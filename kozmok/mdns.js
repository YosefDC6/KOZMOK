// mdns.js
// Nombre fijo en la red local: anuncia "kozmok.local" (mDNS, el mismo
// mecanismo que usan las impresoras y Bonjour) apuntando a la IP que tenga
// la computadora en ese momento. Así la tienda y el panel se abren siempre
// en http://kozmok.local:3000 aunque cambie la red o la IP, y el navegador
// conserva lo que guarda por dirección: contraseñas guardadas, cuentas
// recordadas, tema, carrito sin sesión…
//
// Sin dependencias (dgram de Node). Responde solo preguntas de tipo A (IPv4)
// por ese nombre, con la IP de la red de quien pregunta. Si el puerto 5353
// está ocupado o la red no deja usar multicast, solo avisa y la tienda sigue
// funcionando por IP.
const dgram = require('dgram');
const os = require('os');

const GRUPO = '224.0.0.251';
const PUERTO = 5353;

function ipsLocales() {
    return Object.values(os.networkInterfaces()).flat()
        .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal && !i.address.startsWith('169.254.'));
}
const aNum = (ip) => ip.split('.').reduce((a, n) => ((a << 8) >>> 0) + Number(n), 0) >>> 0;
// La IP de esta computadora que está en la misma red que quien pregunta.
function ipPara(origen) {
    const lista = ipsLocales();
    const o = /^\d+\.\d+\.\d+\.\d+$/.test(origen || '') ? aNum(origen) : null;
    if (o !== null) {
        const misma = lista.find((i) => { const m = aNum(i.netmask); return ((aNum(i.address) & m) >>> 0) === ((o & m) >>> 0); });
        if (misma) return [misma.address];
    }
    return lista.map((i) => i.address);
}

function leerNombre(buf, pos) {
    const partes = [];
    let saltos = 0, fin = null;
    while (pos < buf.length) {
        const len = buf[pos];
        if (len === 0) { pos += 1; break; }
        if ((len & 0xc0) === 0xc0) {                // puntero (compresión)
            if (fin === null) fin = pos + 2;
            pos = ((len & 0x3f) << 8) | buf[pos + 1];
            if (++saltos > 10) throw new Error('nombre inválido');
            continue;
        }
        partes.push(buf.toString('utf8', pos + 1, pos + 1 + len));
        pos += 1 + len;
    }
    return { nombre: partes.join('.').toLowerCase(), pos: fin !== null ? fin : pos };
}
function codificarNombre(nombre) {
    const partes = nombre.split('.').filter(Boolean).map((p) => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
    return Buffer.concat([...partes, Buffer.from([0])]);
}
function respuesta({ id, nombre, ips, conPregunta }) {
    const nom = codificarNombre(nombre);
    const cab = Buffer.alloc(12);
    cab.writeUInt16BE(id, 0);
    cab.writeUInt16BE(0x8400, 2);                 // respuesta con autoridad
    cab.writeUInt16BE(conPregunta ? 1 : 0, 4);
    cab.writeUInt16BE(ips.length, 6);
    const partes = [cab];
    if (conPregunta) partes.push(nom, Buffer.from([0, 1, 0, 1]));
    for (const ip of ips) {
        const r = Buffer.alloc(10);
        r.writeUInt16BE(1, 0);                     // tipo A
        r.writeUInt16BE(conPregunta ? 1 : 0x8001, 2); // clase IN (+ cache-flush en multicast)
        r.writeUInt32BE(60, 4);                    // TTL corto: la IP puede cambiar
        r.writeUInt16BE(4, 8);
        partes.push(nom, r, Buffer.from(ip.split('.').map(Number)));
    }
    return Buffer.concat(partes);
}

function iniciar({ nombre = 'kozmok', log = console } = {}) {
    const fqdn = `${String(nombre).toLowerCase().replace(/\.local$/, '')}.local`;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let unidas = new Set();
    const unirse = () => {
        for (const i of ipsLocales()) {
            if (unidas.has(i.address)) continue;
            try { sock.addMembership(GRUPO, i.address); unidas.add(i.address); } catch { /* esa interfaz no admite multicast */ }
        }
        // Las que ya no existen se olvidan (al volver se unen otra vez).
        const vivas = new Set(ipsLocales().map((i) => i.address));
        unidas = new Set([...unidas].filter((a) => vivas.has(a)));
    };
    sock.on('message', (msg, rinfo) => {
        try {
            if (msg.length < 12 || (msg.readUInt16BE(2) & 0x8000)) return;   // solo preguntas
            const id = msg.readUInt16BE(0);
            const qd = msg.readUInt16BE(4);
            let pos = 12, pide = false, unicast = false;
            for (let q = 0; q < qd; q++) {
                const r = leerNombre(msg, pos);
                const tipo = msg.readUInt16BE(r.pos), clase = msg.readUInt16BE(r.pos + 2);
                pos = r.pos + 4;
                if (r.nombre === fqdn && (tipo === 1 || tipo === 255)) { pide = true; if (clase & 0x8000) unicast = true; }
            }
            if (!pide) return;
            const ips = ipPara(rinfo.address);
            if (!ips.length) return;
            // Pregunta "de una sola vez" (puerto distinto a 5353): se responde directo.
            if (rinfo.port !== PUERTO) {
                sock.send(respuesta({ id, nombre: fqdn, ips, conPregunta: true }), rinfo.port, rinfo.address);
                return;
            }
            const r = respuesta({ id: 0, nombre: fqdn, ips, conPregunta: false });
            if (unicast) sock.send(r, rinfo.port, rinfo.address);
            sock.send(r, PUERTO, GRUPO);
        } catch { /* paquete que no es para nosotros */ }
    });
    sock.on('error', (e) => {
        log.log(`Nombre ${fqdn}: no se pudo anunciar (${e.code || e.message}); usa la dirección con IP.`);
        try { sock.close(); } catch { /* ya cerrado */ }
    });
    sock.bind(PUERTO, () => {
        try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch { /* opcional */ }
        unirse();
    });
    const reloj = setInterval(unirse, 15000);
    reloj.unref();
    return { nombre: fqdn, cerrar: () => { clearInterval(reloj); try { sock.close(); } catch { /* nada */ } } };
}

module.exports = { iniciar, ipsLocales };
