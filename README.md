# Kozmok

Tienda en línea de electrónica y cómputo (laptops, PCs, componentes y periféricos) con **CRM**, **SCM** (cadena de suministro), **ERP** (órdenes de clientes e integración de módulos), **carrito con pagos, monedero, promociones e impuestos configurables** (Etapa 4), **seguridad contra fuerza bruta, robo de sesión e inyección SQL** (Etapa 5), panel de administración por roles, panel de cliente y un **chatbot asesor** que recomienda productos según uso, presupuesto e inventario disponible.

Proyecto escolar construido con **Node.js + Express**, **PostgreSQL** y un front-end en HTML, CSS y JavaScript sin frameworks.

---

## Funcionalidades principales

### Tienda (cliente)
- **Catálogo** de 73 productos y 35 marcas, con búsqueda, filtros por categoría, uso, precio, marca y "solo en promoción" (guardados en la URL), orden (precio, más recientes, mayor descuento) y vistos recientemente.
- **Comercialización**: banner de promociones vigentes en la portada, productos **destacados** (se marcan en el panel), sección de **novedades** y precio con descuento visible (precio final, precio de lista tachado y etiqueta `-10%` / `-$500`) en catálogo, ficha, carrito y panel lateral.
- **Panel lateral de carrito y favoritos**: el corazón y el carrito de la barra abren un panel a la derecha (pestañas Carrito / Favoritos) sin cambiar de pantalla. Al agregar un producto el panel se abre solo unos segundos para confirmarlo.
- **Navegación cómoda**: buscador con sugerencias en vivo (productos con foto y precio, categorías y búsquedas recientes; tecla `/` para buscar), ficha de producto con enlace propio que se cierra con "atrás" y se puede compartir, catálogo de 24 en 24 con "Ver más", la posición del catálogo se conserva al regresar, botón "volver arriba", menú de categorías con sus marcas principales, migas de pan y botón **Regresar** en todas las páginas, y página 404 con buscador.
- **En el celular**: filtros en un panel lateral, barra inferior con Inicio, Catálogo, Favoritos, Carrito y Cuenta (con aviso de pedido en camino) y "Mi cuenta" como fila deslizable.
- **Checkout por pasos**: Carrito → Envío → Pago → Confirmar, con barra de avance, el resumen siempre visible y cada paso en la dirección (`?paso=2`), así "atrás" regresa al paso anterior.
- **Logo KZK** (estilo Arcade: letras inclinadas con contorno grueso y sombra sólida del color del tema): en la barra, el panel, los comprobantes y el ícono de la pestaña. La **tarjeta de socio** y la del Club usan el diseño KZK; el cliente puede volver al **diseño clásico** desde la propia tarjeta o en Preferencias (se guarda en su cuenta).
- **Diseño de la tienda en estilo Arcade** (igual que el logo): títulos gruesos, inclinados y en mayúsculas, botones con contorno marcado y sombra sólida del color del tema, etiquetas de promoción tipo calcomanía y pasos de compra en bloques inclinados. Funciona con los cuatro temas (Índigo, Esmeralda, Grafito y Claro); el panel interno conserva su diseño.
- **Carrito sin sesión**: se puede llenar sin cuenta (catálogo, Arma tu PC, asesor); al iniciar sesión o registrarse pasa solo a la cuenta.
- **Ficha de producto** con especificaciones, stock real, reseñas y **garantía extendida** (12, 24 o 36 meses, con certificado y folio).
- **Comparador** de hasta 4 productos lado a lado.
- **Arma tu PC**: armado pieza por pieza con validación de compatibilidad en vivo (socket, DDR4/DDR5, formato de placa y watts de la fuente) y builds recomendadas por uso.
- **Chatbot asesor**: pregunta uso → categoría → presupuesto (o texto libre) y sugiere hasta 5 productos con stock.
- **Carrito y checkout**: direcciones y métodos de pago guardados; desglose calculado por el servidor (productos, garantías, promociones, cada impuesto activo, envío de $199 —gratis desde $10,000— y puntos). Pago con **tarjeta, PayPal (simulado), monedero, SPEI o en tienda**.
- **Mi monedero**: saldo en pesos para pagar en un clic. Recarga con tarjeta o PayPal (al instante) o por transferencia (se acredita cuando el equipo la confirma), historial con el saldo de cada movimiento y reembolso automático si se cancela una compra pagada con monedero.
- **Mi cuenta**: pedidos con seguimiento y cancelación, favoritos, direcciones, métodos de pago, seguridad, preferencias y tickets de soporte.
- **Club de puntos**: niveles Bronce, Plata, Oro y Platino; 100 puntos equivalen a $10 de descuento.
- **Tarjeta virtual de socio** con código QR para verificación en tienda física.
- **4 temas de color** (Índigo, Esmeralda, Grafito y Claro).

### Panel interno – CRM
- **Dashboard** con KPIs, clientes en riesgo y productos más vendidos.
- **Clientes**: búsqueda, filtros por etapa y por estado, alta, edición y baja en dos pasos (si ya compró primero se marca inactivo; ya inactivo se elimina por completo y sus pedidos quedan como "Cliente eliminado"); etapas `Prospecto → Activo → Frecuente → Inactivo`; un cliente pasa a *Activo* automáticamente con su primera compra.
- **Interacciones** (llamada, correo, reunión, soporte y chat), **evaluaciones** y **reportes** por rango de fechas.
- **Soporte** con tickets (`TK-1001…`), estados y prioridades.
- **Pedidos**, **garantías** y **analítica del chatbot** (qué se busca y qué búsquedas quedaron sin recomendación).

### Panel interno – SCM
- **Dashboard SCM** con métricas, más vendidos, push vs pull e inventario crítico.
- **Productos** (catálogo: alta, edición, filtros por categoría y estrategia) e **Inventario** (existencias, estado Normal / Stock bajo / Agotado, valor del inventario y detalle con últimos movimientos), como pantallas separadas.
- **Proveedores** (con contacto, dirección y tiempo de entrega) y **movimientos de inventario**.
- **Pedidos** de reposición (`OC-100x`, a proveedores) y de venta en un solo listado, con filtros por estado y tipo, y su formulario (producto, cantidad, proveedor, fecha estimada de entrega, notas).
- **Reabasto automático**: al llegar al stock mínimo se genera solo el pedido al proveedor (push en cuanto toca el mínimo, pull solo cuando lo dispara una venta) y al llegar su fecha de entrega se surte solo, con su movimiento de entrada registrado a nombre del sistema. Tiene un modo de entrega inmediata para demostración.
- **Logística**: estrategia de reabastecimiento *push* o *pull* por producto.
- **Todo desde el propio panel**: en Inventario y en el Dashboard SCM los movimientos, los pedidos de reposición y los parámetros de abastecimiento (mínimo, proveedor, push/pull) se capturan en ventanas ahí mismo; las ventas de clientes también se gestionan desde Pedidos del SCM.
- **Nivel de madurez SCM** (Inicial → En desarrollo → Optimizado) en su propia pantalla, calculado a partir de los datos (el admin lo puede fijar a mano: `GET /scm/estado`, `PUT /scm/nivel`), y **reportes SCM** (más vendidos, rotación alta / media / baja, comparativa mensual push vs pull e inventario crítico).

### Panel interno – ERP (Etapa 3)
Integra el CRM y el SCM para gestionar las operaciones del negocio desde un solo lugar.
- **Dashboard ERP**: clientes activos, órdenes de clientes, ventas totales, ventas de los últimos 6 meses por canal, productos más vendidos, últimas órdenes y el bloque de **integración entre módulos** (CRM ⇄ ERP ⇄ SCM).
- **Órdenes de clientes**: listado de las órdenes de los dos canales (capturadas en el ERP o hechas en la tienda en línea) con búsqueda, filtros y exportación a CSV. Cada orden se gestiona completa sin salir del ERP: cliente e historial, estado del envío, registro del pago, cancelación (regresa stock, garantías y puntos) y movimientos de inventario.
- **Clientes** y **Productos** (botones en Dashboard ERP y Órdenes de clientes): consulta de los clientes del CRM y del inventario del SCM sin salir del ERP, con su ficha, lo comprado o vendido y sus órdenes. Las órdenes se filtran eligiendo cliente o producto de una lista.
- **Nueva orden** en 3 pasos: *Cliente* (se elige del CRM o se da de alta ahí mismo) → *Productos* (del inventario del SCM, con stock real) → *Confirmar* (resumen con IVA y envío, forma de pago y dirección).
- **Procesamiento** en una sola transacción: crea la orden (`OR-001…`), valida y descuenta el stock, registra los movimientos de inventario, genera el pedido de reposición automático si algo cae en stock crítico y actualiza el historial del cliente (compras, etapa CRM y puntos del Club). Si algo falla, no se guarda nada.
- **Procesos internos**: cada orden guarda su bitácora (orden creada, stock validado, inventario actualizado, reabasto, historial, pago, cambios de estado, cancelación), marcando qué fue automático y qué hizo alguien del equipo. Se ve en el detalle de la orden.
- **Nivel de implementación ERP**: Básico → Integrado → Automatizado → Optimizado, calculado con datos reales a partir de un checklist de 6 puntos, con barra de progreso empresarial. El último punto (reabasto automático en uso y órdenes ERP entregadas) se resuelve en la misma pantalla, sin ir al SCM. El administrador puede fijarlo a mano (con motivo) y regresarlo al cálculo automático (`GET/PUT /api/admin/erp/estado`).
- **Reportes ERP**: KPIs por rango de fechas (ventas, órdenes, productos vendidos, clientes activos, inventario disponible, por cobrar), ventas por mes, más vendidos, inventario por rotación, órdenes por estado y exportación a CSV. Los reportes se pueden **guardar** como foto del periodo y consultarse después. `GET /api/admin/erp/metricas` devuelve los indicadores globales.
- **Panel por rol** (solo admin): columnas por rol y matriz de permisos sección × rol, generadas de los mismos permisos del menú.

### Panel interno – TIENDA (Etapa 4: carrito y sus agregados)
- **Promociones**: alta y edición de descuentos por **porcentaje** o **monto por pieza**, para todo el catálogo, una categoría o un producto, con vigencia (inicio–fin), activa/inactiva y "mostrar en el banner". Muestra situación (vigente, programada, vencida, inactiva), pedidos que la usaron y descuento otorgado. Se aplican solas en catálogo, carrito, checkout y órdenes del ERP (si a un producto le tocan varias, gana la que más descuenta).
- **Impuestos** (solo admin): configurador del cálculo. Se aplican todos los activos sobre el subtotal ya con promociones (p. ej. subtotal 1000 + IVA 16 % = 1160). Cada pedido guarda su desglose (`impuestos_detalle`), así que cambiar un porcentaje no altera pedidos anteriores.
- **Monedero**: saldo total en monederos, recargas y consumos del mes, gráfica de 6 meses, recargas por transferencia por confirmar o rechazar, ficha de cada cliente con su historial, **ajustes manuales** (abono o cargo con motivo, quedan a nombre de quien los hizo) y bloqueo del monedero.
- **Pagos**: el pago de cada pedido (tienda y ERP) con método, monto, estado (pagado, pendiente, reembolsado, cancelado), referencia y fecha de cobro; filtros, totales por método y exportación a CSV. "Gestionar" abre el gestor del pedido para registrar el cobro.

### Seguridad (Etapa 5)
Detalle de cada ataque, cómo se prueba y qué lo detiene en [`SEGURIDAD.md`](SEGURIDAD.md).
- **Fuerza bruta**: la cuenta se bloquea 15 min tras 5 contraseñas equivocadas y la IP 30 min tras 20 fallos; máximo 15 intentos por minuto, retraso progresivo y el mismo mensaje exista o no el correo.
- **Robo de credenciales y de sesión**: la sesión va en una cookie `HttpOnly; SameSite=Strict` con un token aleatorio (en la base solo su hash), vence, se cierra por inactividad y queda atada al navegador: si alguien la copia a otro, se revoca. Contraseñas con bcrypt y política fuerte (8+ caracteres, mayúsculas, minúsculas, número y símbolo).
- **Inyección SQL**: consultas parametrizadas en todo el servidor, filtro que bloquea y registra los intentos, ids numéricos validados y errores de la base ocultos.
- **XSS, CSRF y datos ajenos**: limpieza de HTML en lo que entra y escape al mostrar, cabeceras CSP, rechazo de peticiones de otros sitios y cada cliente solo ve lo suyo.
- **Tienda**: "¿Olvidaste tu contraseña?" con enlace de un solo uso (30 min) y *Mi cuenta → Seguridad* con sesiones abiertas (se pueden cerrar) y últimos intentos de acceso.
- **Panel** (*Cuenta → Seguridad*, solo admin): eventos de seguridad, intentos de inicio de sesión, bloqueos (con "Desbloquear"), sesiones activas y correos enviados.
- **Pruebas**: `npm run prueba:seguridad` ataca nuestro propio servidor (fuerza bruta, inyección SQL, robo de sesión) y marca cada defensa como DEFENDIDO o VULNERABLE. También se puede atacar por Wi-Fi desde otra computadora de la misma red (por ejemplo el hotspot de un celular): `node pruebas-seguridad/todas.js http://192.168.x.x:3000`.

---

## Roles

Roles empresariales del ERP: solo **Administrador**, **Ventas** y **Logística**.

| Rol | Entra a | Acceso |
|---|---|---|
| **Administrador** | Dashboard CRM | Todo: CRM, SCM, ERP y Tienda (incluidos Impuestos), cuentas y equipo, Nivel ERP y Panel por rol |
| **Ventas** | Dashboard CRM | Clientes (CRM), Productos (SCM, solo consulta), Órdenes de clientes (ERP, con captura), Reportes, Promociones, Monedero, Pagos y Mi actividad |
| **Logística** | Dashboard SCM | Productos e Inventario (SCM, con movimientos y pedidos de reposición en ventana), Órdenes de clientes (ERP, captura, surte y envía) y Reportes |
| **Cliente** | Tienda | Solo la tienda y su propia cuenta |

Los menús de Ventas y Logística son exactamente los de la lámina *Panel por rol (Menú dinámico)*; la pantalla **Panel por rol** los muestra con su vista previa del menú y la matriz de permisos.

Los permisos viven en un solo archivo, `public/admin/js/permisos.js`, que usan **el menú** (menú dinámico según el usuario) **y el servidor** (control de acceso por módulo en cada llamada a `/api/admin/...`), así que nunca se contradicen. Si alguien abre por URL una sección que no le corresponde, el panel lo regresa a su inicio y la API responde 403. El administrador cambia el rol de cualquier persona desde *Cuentas y equipo* (`PUT /api/admin/usuarios/:id/rol`); `GET /api/usuarios/rol` devuelve el rol y los permisos de la sesión, y `POST /api/auth/login` responde también con ellos.

Al arrancar sobre una base anterior, el servidor migra solo los roles viejos: *vendedor* y *soporte* pasan a **Ventas** y *almacén* a **Logística**.

---

## Instalación y ejecución

**Requisitos:** Node.js 18 o superior y PostgreSQL 16 o superior.

```bash
# 1. Clonar e instalar dependencias
git clone https://github.com/YosefDC6/KOZMOK.git
cd KOZMOK/kozmok
npm install

# 2. Crear la base de datos (en psql)
#    CREATE DATABASE kozmok;

# 3. Copiar .env.example como .env y poner la contraseña de PostgreSQL
#    (el .env no se sube a GitHub)

# 4. Cargar esquema, triggers y datos de ejemplo (se puede volver a ejecutar)
psql -U postgres -d kozmok -f db/database.sql

# 5. Iniciar el servidor
npm start        # o: npm run dev  (con nodemon)
```

- **Tienda:** http://localhost:3000
- **Panel interno:** http://localhost:3000/admin/login.html (a propósito, no hay enlace desde la tienda)
- **Desde un celular de prueba:** conéctalo a la misma red Wi-Fi que la computadora y abre la dirección que muestra la consola al arrancar (`Desde un celular en la misma red Wi-Fi abre: http://192.168.x.x:3000`). En Windows, la primera vez que corre `npm start` sale un aviso del Firewall: marca **Redes privadas** y dale **Permitir acceso** (y que la red Wi-Fi esté como *Privada*). Si la red es de la escuela y no conecta, puede bloquear la comunicación entre equipos: usa el hotspot de un celular. Con `HOST=127.0.0.1` en el `.env` solo se abre desde la computadora.

Si al arrancar la consola muestra `Base de datos: conectada … 73 productos`, todo está listo.

> **Actualizar a la Etapa 5:** al arrancar, el servidor crea solo las tablas de seguridad que falten. Las sesiones anteriores (token Base64 guardado en el navegador) ya no sirven: hay que volver a iniciar sesión. Las contraseñas nuevas deben cumplir la política; las cuentas de prueba ya la cumplen.

> **Actualizar desde una versión anterior (Etapa 4):** vuelve a cargar `db/database.sql` (paso 4). Crea las tablas nuevas (`carrito`, `carrito_detalle`, `pagos`, `promociones`, `impuestos`, `monederos`, `movimientos_monedero`) y reemplaza `carrito_items`. Si faltan, la consola lo avisa al arrancar.

### Cuentas de prueba

| Rol | Correo | Contraseña |
|---|---|---|
| Admin | admin@kozmok.mx | `Admin#KZ2026` |
| Ventas | laura.ventas@kozmok.mx | `Ventas#KZ2026` |
| Logística | paola.logistica@kozmok.mx | `Logistica#KZ2026` |
| Cliente | mariana@correo.com | `Demo#KZ2026` |

---

## Estructura del proyecto

```
KOZMOK/
├── README.md
├── Manual_usuario.txt        # manual completo, sección por sección
└── kozmok/
    ├── server.js             # API REST (Express): /api/...
    ├── db.config.js          # conexión a PostgreSQL (lee el .env)
    ├── seguridad.js          # Etapa 5: sesiones, bloqueos, filtros SQL/XSS, CSP
    ├── .env.example          # plantilla de la configuración (contraseña de la base, límites)
    ├── pruebas-seguridad/    # ataques de prueba contra el servidor local
    ├── db/database.sql       # esquema + triggers + datos de ejemplo
    └── public/               # front-end estático
        ├── index.html, carrito.html, monedero.html, armar-pc.html, comparar.html, 404.html, ...
        ├── img/kzk.svg       # logo KZK (ícono de la pestaña); en páginas se dibuja con logoKZK() de icons.js
        ├── css/style.css
        ├── js/               # api, layout (barra + panel lateral carrito/favoritos), chatbot, tema, toasts, etc.
        └── admin/            # panel CRM, SCM (productos, inventario, nivel-scm, ...)
                              #   ERP (erp, ordenes-erp, orden-nueva, nivel-erp,
                              #   reportes-erp, panel-roles) y TIENDA (promociones,
                              #   impuestos, monedero, pagos) y Seguridad
                              # admin/js/permisos.js: permisos por rol (menú + API)
```

**Tablas principales:** usuarios, clientes, productos, categorías, proveedores, pedidos (con `origen` en línea / ERP), pedido_items, carrito y carrito_detalle, interacciones, métricas_clientes, movimientos_inventario, órdenes_compra, garantías, reseñas, favoritos, direcciones, métodos_pago, movimientos_puntos, tickets, ticket_mensajes y chatbot_consultas. Propias del ERP: estado_erp (nivel de implementación), procesos_erp (procesos internos de cada orden), recursos_erp (recursos de la empresa, expuestos en `GET/POST/PUT/DELETE /api/admin/erp/recursos`) y reportes_erp (reportes guardados); las órdenes empresariales son filas de pedidos con `origen = 'erp'`. Propias de la Etapa 4: carrito (uno por cliente) y carrito_detalle, pagos (uno por pedido, lo mantiene el trigger `trg_pedido_pago`), promociones, impuestos, monederos (lo crea el trigger `trg_cliente_monedero` para cada cliente) y movimientos_monedero. Propias de la Etapa 5: sesiones, intentos_login, bloqueos, eventos_seguridad, recuperaciones y correos_salida.

### Rutas de la Etapa 4 (nombres del documento)

| Sección | Rutas |
|---|---|
| Catálogo | `GET /api/catalogo`, `GET /api/catalogo/:id`, `?categoria=`, `?buscar=`, `?destacado=1`, `?promocion=1`, `?orden=novedades` |
| Pagos | `POST /api/pagos/procesar` (valida stock → genera pedido → registra pago → actualiza inventario), `GET /api/pagos/:id`, `GET /api/pedidos/:id/pago`, `GET /api/admin/pagos` |
| Carrito | `POST /api/carrito/agregar`, `GET /api/carrito/:cliente_id`, `PUT /api/carrito/item/:id`, `DELETE /api/carrito/item/:id`, `DELETE /api/carrito/vaciar/:cliente_id`, `POST /api/checkout/cotizar` |
| Promociones | `GET /api/promociones`, `POST /api/promociones`, `PUT /api/promociones/:id` (+ `/api/admin/promociones`, con `DELETE`) |
| Impuestos | `GET /api/impuestos`, `POST /api/impuestos`, `PUT /api/impuestos/:id` (+ `/api/admin/impuestos`, con `DELETE`) |
| Atención a clientes | `POST /api/atencion/ticket`, `GET /api/atencion/tickets`, `GET /api/atencion/ticket/:id`, `PUT /api/atencion/ticket/:id/respuesta` |
| Autenticación | `POST /api/auth/registro`, `POST /api/auth/login` (con `correo` = cliente, con `email` = equipo; o `tipo`), `POST /api/auth/logout`, `GET /api/auth/perfil`, `PUT /api/auth/perfil` |
| Seguridad (Etapa 5) | `GET /api/auth/estado`, `POST /api/auth/recuperar`, `POST /api/auth/restablecer`, `GET /api/auth/sesiones`, `DELETE /api/auth/sesiones/:id`, `POST /api/auth/sesiones/cerrar-otras`, `GET /api/auth/actividad`, `GET /api/admin/seguridad/resumen`, `POST /api/admin/seguridad/bloqueos/:id/levantar`, `POST /api/admin/seguridad/sesiones/:id/revocar`, `GET /api/admin/correos[/:id]` |
| Monedero | `GET /api/monedero`, `POST /api/monedero/recargar`, `GET /api/admin/monederos[/:clienteId]`, `POST /api/admin/monederos/:clienteId/ajuste`, `PUT /api/admin/monederos/:clienteId/estado`, `PUT /api/admin/monederos/movimientos/:id` |

---

## Notas

- Es una **demo educativa**: no hay pasarela de pago ni se hacen cargos reales. Nunca se guarda el número completo de la tarjeta ni el CVV.
- Las contraseñas se guardan con **bcrypt** y las sesiones son tokens aleatorios en cookie HttpOnly (Etapa 5, ver [`SEGURIDAD.md`](SEGURIDAD.md)). En producción hay que servirlo con HTTPS y `COOKIE_SEGURA=1`.
- Los detalles de cada pantalla están en [`Manual_usuario.txt`](Manual_usuario.txt), y en [`kozmok/README.md`](kozmok/README.md) hay notas técnicas adicionales.
