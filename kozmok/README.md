# Kozmok · notas técnicas

Tienda en línea de electrónica y cómputo (laptops, PCs, componentes y
periféricos) con CRM, SCM, ERP, carrito con pagos y monedero, garantías,
devoluciones, facturación y seguridad. Node/Express + PostgreSQL, front-end
en HTML, CSS y JavaScript sin frameworks.

Este archivo es la referencia técnica. Qué hace cada pantalla está en
[`../Manual_usuario.txt`](../Manual_usuario.txt), el resumen del proyecto en
[`../README.md`](../README.md) y los ataques y defensas en
[`../SEGURIDAD.md`](../SEGURIDAD.md).

> **Etapas del proyecto:** Etapa 1 = CRM, Etapa 2 = SCM, Etapa 3 = ERP
> (rutas `/api/admin/erp/*`, pantallas `admin/erp.html`, `ordenes-erp.html`,
> `orden-nueva.html`, `nivel-erp.html` y `reportes-erp.html`), Etapa 4 =
> carrito y sus agregados (promociones, impuestos, monedero, pagos),
> Etapa 5 = seguridad (`seguridad.js`, `/api/auth/*`, `/api/admin/seguridad/*`).

## Estructura

```
kozmok/
├── server.js              # API REST (Express), migraciones al arrancar y tareas cada minuto
├── seguridad.js           # sesiones, bloqueos, límites, filtros SQL/XSS, CSRF, CSP, contraseñas
├── dosfactores.js         # verificación en dos pasos (TOTP de app autenticadora y código por correo)
├── captcha.js             # Google reCAPTCHA v2 (verificación en el servidor)
├── correo.js              # cliente SMTP para Gmail, sin dependencias, y revisión MX de dominios
├── paypal.js              # API de PayPal (órdenes, captura y reembolsos)
├── facturama.js           # API de Facturama (CFDI 4.0)
├── env.js                 # lee el .env (sin dependencias)
├── db.config.js           # conexión a PostgreSQL (lee el .env)
├── .env.example           # plantilla de toda la configuración
├── limpiar-ejemplo.js     # npm run limpiar:ejemplo (bases viejas con clientes de prueba)
├── prueba-correo.js       # npm run prueba:correo (prueba la conexión con Gmail)
├── pruebas-seguridad/     # ataques contra el propio servidor (npm run prueba:seguridad)
├── db/
│   ├── database.sql       # esquema, triggers, datos iniciales y cuentas del panel (bcrypt vía pgcrypto)
│   └── control_interno.sql# bitácora encadenada, fechas del servidor, auditoría, facturas y devoluciones
│                          #   (se ejecuta solo al arrancar)
└── public/
    ├── index.html                 # portada y catálogo (filtros en la URL, ?promo=ID)
    ├── carrito.html, pagar.html, gracias.html, recibo.html
    ├── login.html, registro.html, verificar.html, recuperar.html, restablecer.html
    ├── perfil.html, pedidos.html, devoluciones.html, garantias.html, monedero.html,
    │   recompensas.html, favoritos.html, resenas.html, direcciones.html, pagos.html,
    │   soporte.html, datos.html, seguridad.html, preferencias.html   # "Mi cuenta"
    ├── cuenta.html, cliente-panel.html   # redirigen a la sección nueva (enlaces viejos)
    ├── armar-pc.html, comparar.html, socio.html, ayuda.html, terminos.html, 404.html
    ├── css/style.css, css/arcade.css     # arcade.css: estilo de la tienda (no del panel)
    ├── js/                         # api (fetch + controles numéricos), layout, chatbot, toast,
    │                               #   icons (íconos, logo KZK y fantasmita), dos-pasos, fotos,
    │                               #   garantia, paypal-botones, recibo-render, graficas, vendor/
    └── admin/                      # una pantalla por sección del panel
        └── js/
            ├── admin-layout.js     # menú, "Ir a…", puntitos de aviso, botón Regresar
            ├── permisos.js         # permisos por rol (los usa el menú y el servidor)
            ├── gestion-pedido.js   # gestor de pedidos compartido (CRM, ERP, SCM, Soporte)
            ├── scm-acciones.js     # movimiento, reposición y abastecimiento en ventana
            └── erp.js, clientes-erp.js, productos-erp.js, interaccion-sim.js
```

## Instalación

Requisitos: Node.js 18+ y PostgreSQL 16+.

```bash
npm install
```

1. Crea la base: `CREATE DATABASE kozmok;`
2. Copia `.env.example` como `.env` y pon la contraseña de PostgreSQL. El
   `.env` no se sube a GitHub.
3. Carga el esquema: `psql -U postgres -d kozmok -f db/database.sql`. Se
   puede repetir: borra todo y lo recrea.
4. `npm start`. Tienda en http://localhost:3000 y panel en
   http://localhost:3000/admin/login.html.

La base empieza sin clientes ni pedidos. Trae tres cuentas del panel (una
por rol) que piden cambiar la contraseña al entrar; están en
[`../README.md`](../README.md). Antes de configurar Gmail crea un
administrador con un correo real: con Gmail activo, la verificación en dos
pasos del panel manda el código al correo de la cuenta y los correos
`@kozmok.mx` no existen.

### Actualizar una base existente

No hace falta volver a cargar `database.sql`. Al arrancar,
`migrarEsquema()` (en `server.js`) aplica solo lo que falte con
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
cambia restricciones, migra datos (roles viejos, reclamos del sistema
anterior, garantía base de lo ya entregado, severidades de seguridad) y al
final ejecuta `db/control_interno.sql`. Basta `git pull` y reiniciar.

Al agregar un cambio de esquema: ponlo en `migrarEsquema()` (para bases
existentes) **y** en `database.sql` (para bases nuevas).

### Configuración (.env)

`.env.example` documenta cada variable. Las principales:

| Grupo | Variables |
|---|---|
| Base | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` |
| Servidor | `PORT`, `HOST` (`127.0.0.1` = solo esta computadora), `URL_PUBLICA` (enlaces de los correos) |
| Correo | `SMTP_USUARIO`, `SMTP_PASSWORD` (contraseña de aplicación de Gmail), `CORREO_REMITENTE` |
| Seguridad | `MAX_FALLOS_CUENTA`, `MAX_FALLOS_IP`, `BLOQUEO_*`, `SESION_*`, `INACTIVIDAD_MIN_*`, `BCRYPT_COSTO`, `FILTRO_SQLI`, `COOKIE_SEGURA` |
| Dos pasos y captcha | `DOSF_PANEL_OBLIGATORIO`, `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`, `RECAPTCHA_DOMINIOS` |
| Pagos y facturas | `PAYPAL_*`, `FACTURAMA_*`, `FACTURA_*`, `EMPRESA_*`, `SPEI_*` (datos de transferencia) |
| Negocio | `GARANTIA_BASE_MESES`, `DEVOLUCION_*`, `DEVOLUCIONES_DIRECCION`, `MONEDERO_*`, `BAJA_UMBRAL_*`, `MAX_PIEZAS_POR_PRODUCTO`, `MAX_PEDIDOS_SIN_PAGAR`, `INVENTARIO_MAX_POR_MOVIMIENTO` |
| Administración | `CODIGO_BORRADO_DEFINITIVO` (borrado definitivo de productos; vacío = apagado) |
| Pruebas | `PRUEBA_CORREO`, `PRUEBA_PASSWORD` (cuenta de cliente para `npm run prueba:seguridad`) |

## Scripts

| Comando | Qué hace |
|---|---|
| `npm start` / `npm run dev` | Inicia el servidor (`dev` con nodemon) |
| `npm run prueba:seguridad` | Fuerza bruta, inyección SQL y robo de sesión contra el propio servidor; revisa antes la cuenta de prueba |
| `npm run prueba:fuerza-bruta`, `prueba:sqli`, `prueba:sesion` | Cada prueba por separado |
| `npm run desbloquear` | Levanta bloqueos (`-- --todo` también borra la bitácora de intentos y eventos) |
| `npm run prueba:correo` | Manda un correo de prueba con la configuración de Gmail |
| `npm run limpiar:ejemplo` | Muestra (o con `-- --confirmar` borra) los clientes de prueba de bases viejas |

## Arquitectura del servidor

- **Rutas**: tienda en `/api/*`, panel en `/api/admin/*`. Todas las de
  `/api/admin/*` exigen sesión del equipo; `PERMISOS_API` (regex por ruta y
  método) más `admin/js/permisos.js` deciden qué rol entra a cada una.
- **Sesiones**: token aleatorio de 256 bits en cookie HttpOnly
  (`kz_sesion` tienda, `kz_admin` panel); en la tabla `sesiones` solo su
  hash. Desde Postman: `{"modo":"token"}` en el login y
  `Authorization: Bearer <token>`.
- **Errores**: `asyncRoute()` atrapa las excepciones; la base nunca muestra
  su mensaje al usuario (`seg.mensajeSeguro`).
- **Bitácoras**: `auditar()` para acciones del equipo (encadenada en
  `auditoria`), `seg.registrarEvento()` para seguridad (severidad `info`,
  `baja`, `media` o `alta`; `info` es actividad normal y no cuenta como
  alerta).
- **Correos**: `enviarCorreo()` los guarda en `correos_salida` y el
  despachador los manda cada 30 s con reintentos.
- **Tareas cada minuto** (`tareasPeriodicas`): reabasto automático,
  cancelación de pedidos con el plazo de pago vencido, conciliación de pagos
  de PayPal pendientes y avisos por correo (boletín, favoritos, pedidos).
- **Promociones**: `promocionesVigentes()` y `adjuntarAlcance()` calculan
  qué productos entran en cada una (todo el catálogo, filtro por
  categoría/marca/palabras o selección en `promocion_productos`);
  `decorarPrecios()` aplica la que más descuenta.

### Consultas a PostgreSQL

- Siempre parametrizadas (`$1, $2…`); nunca se concatena un dato.
- **Un mismo `$n` debe tener un solo tipo** en toda la consulta. Si se usa
  como fecha y como texto (o número y texto), PostgreSQL responde
  *"inconsistent types deduced for parameter"*. Usa un parámetro por uso o
  un cast explícito (`$1::int`, `$2::timestamp`), y para meses
  `make_interval(months => $1::int)` en vez de `($1 || ' months')::interval`.
- Para validar todas las consultas contra una base real: extraerlas y
  correr `PREPARE` en `psql`; detecta errores de tipos sin ejecutar nada.

## Chatbot de recomendaciones

`POST /api/chatbot/recomendar` recibe `{ uso, presupuesto, categoria,
cliente_id, mensaje }`: filtra productos activos con stock y dentro del
presupuesto, da puntaje por uso (`gaming`, `oficina`, `diseno`,
`programacion`, `estudiante`, `streaming`, `servidor`) y cercanía al
presupuesto, y devuelve hasta 5. Guarda la consulta en `chatbot_consultas`
y, con cliente en sesión, una interacción CRM `tipo = chat`. También arma
PCs pieza por pieza filtrando por compatibilidad.

## Control interno, monedero y rendimiento

- **Antifraude**: `db/control_interno.sql` (fechas del servidor, tablas de
  solo agregar, pedidos sellados, bitácora encadenada). Detalle en
  `../SEGURIDAD.md` §4.
- **Auditoría** (panel, solo admin): bitácora con filtros, verificación de la
  cadena y bajas de inventario pendientes de aprobar.
- **Monedero**: límites en `.env` (`MONEDERO_*`), congelar o bloquear con
  motivo, ajustes grandes con segunda firma. Reglas públicas en
  `terminos.html` (lee `/api/reglamento`).
- **Rendimiento**: caché en memoria del catálogo (se invalida con cualquier
  cambio), gzip, índices y reportes con consultas en paralelo.

## Pagos con PayPal y factura electrónica

Los dos funcionan en **sandbox**: se usan las APIs reales, pero no se mueve
dinero ni se emiten facturas con validez fiscal. El modo real exige dos
variables a propósito (`*_MODO=live` y `*_PERMITIR_REAL=1`).

- **PayPal o tarjeta** (`paypal.js`): el pedido se aparta 60 min y se paga
  en `pagar.html` con los botones de PayPal. El servidor crea la orden con
  su propio total y solo confirma si PayPal responde `COMPLETED` con el
  mismo monto, moneda y pedido. Cancelar un pedido pagado o reembolsar una
  devolución hace el reembolso real en PayPal. Kozmok no recibe números de
  tarjeta. Configura `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET`
  (developer.paypal.com → Apps & Credentials → Sandbox).
- **Factura CFDI 4.0** (`facturama.js`): el cliente factura un pedido
  pagado desde Mis pedidos; el equipo en Panel → Facturas. Se timbra con
  Facturama y llegan PDF y XML por correo. Configura `FACTURAMA_USUARIO`,
  `FACTURAMA_PASSWORD` y `FACTURA_LUGAR_EXPEDICION`; en sandbox, el emisor
  de prueba `EKU9003173C9`.
- Sin credenciales, esas opciones aparecen como "no disponible" y el resto
  de la tienda funciona igual.

## Notas para producción

- Sirve todo con HTTPS y pon `COOKIE_SEGURA=1` (agrega `Secure` a las
  cookies y HSTS).
- El límite de intentos por minuto vive en memoria; con varios servidores
  habría que moverlo a la base o a Redis.
- Las imágenes de producto son URLs externas; en un entorno real conviene
  almacenamiento propio (S3, Cloud Storage, etc.).
- Detalle y limitaciones de seguridad en `../SEGURIDAD.md`.
