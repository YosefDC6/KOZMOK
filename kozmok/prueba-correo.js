// prueba-correo.js
// Comprueba que la cuenta de Gmail del .env funciona y manda un correo de
// prueba. No necesita la base de datos ni el servidor encendido.
//
//   npm run prueba:correo                      -> se manda a la misma cuenta
//   npm run prueba:correo -- otra@correo.com   -> se manda a otra dirección
const correo = require('./correo.js');

(async () => {
    const { CFG } = correo;
    if (!correo.configurado()) {
        console.log('\n✗ Falta configurar el correo en el archivo .env (junto a server.js):\n');
        console.log('   SMTP_USUARIO=tucuenta@gmail.com');
        console.log('   SMTP_PASSWORD=abcd efgh ijkl mnop   (contraseña de aplicación de Google)\n');
        console.log('   Crea la contraseña de aplicación en https://myaccount.google.com/apppasswords');
        console.log('   (antes activa la verificación en dos pasos de esa cuenta).\n');
        process.exit(1);
    }
    const para = (process.argv[2] || CFG.usuario).trim();
    console.log(`\n1) Entrando a ${CFG.host}:${CFG.puerto} como ${CFG.usuario}…`);
    const v = await correo.verificar();
    if (!v.ok) { console.log(`✗ ${v.motivo}\n`); process.exit(1); }
    console.log('   ✓ Gmail aceptó la cuenta y la contraseña de aplicación.');

    console.log(`2) Mandando un correo de prueba a ${para}…`);
    try {
        const hora = new Date().toLocaleString('es-MX');
        await correo.enviar({
            para,
            asunto: 'Prueba de correo de Kozmok',
            texto: `¡Funciona! Este correo lo mandó Kozmok el ${hora}.\n\nYa se enviarán de verdad la bienvenida, la recuperación de contraseña y el aviso de cambio de contraseña.`,
            html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111827"><h2 style="margin:0 0 12px">¡Funciona! ✅</h2>
                   <p>Este correo lo mandó Kozmok el ${hora}.</p>
                   <p>Ya se enviarán de verdad la bienvenida, la recuperación de contraseña y el aviso de cambio de contraseña.</p></div>`,
        });
        console.log(`   ✓ Enviado. Revisa la bandeja de ${para} (y la carpeta de spam la primera vez).\n`);
        process.exit(0);
    } catch (e) {
        console.log(`✗ ${correo.explicarError(e)}\n`);
        process.exit(1);
    }
})();
