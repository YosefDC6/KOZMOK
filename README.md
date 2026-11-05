# Kozmok

Tienda en línea de electrónica y cómputo (laptops, PCs, componentes y periféricos) con **CRM**, **SCM** (cadena de suministro), **ERP** (órdenes de clientes e integración de módulos), **negocio electrónico** (catálogo, carrito, pagos, monedero, promociones, impuestos y atención a clientes), **seguridad** probada contra fuerza bruta, robo de credenciales e inyección SQL, panel de administración por roles, panel de cliente y un **chatbot asesor** que recomienda productos según uso, presupuesto e inventario disponible.

Proyecto escolar construido con **Node.js + Express**, **PostgreSQL** y un front-end en HTML, CSS y JavaScript sin frameworks.

---

## Funcionalidades principales

### Flujo de compra (Etapa 4)
Inicio → Catálogo → Detalle → **Carrito** → **Checkout y método de pago** → (**Pago con Monedero**) → **Confirmación**.
- **Catálogo** (`GET /api/catalogo`, `/catalogo/{id}`, `?categoria=`, `?buscar=`): precio con promoción, stock, imagen, estado y destacado. Portada con banner de promociones, *Destacados*, *En promoción*, *Novedades* y accesos a Novedades / Promociones / Más vendidos.
- **Carrito** (`carrito` + `carrito_detalle`, uno activo por cliente): agregar, cambiar cantidad, quitar, vaciar; el precio se recalcula con las promociones vigentes. `POST /carrito/agregar`, `GET /carrito/{cliente_id}`, `PUT/DELETE /carrito/item/{id}`, `DELETE /carrito/vaciar/{cliente_id}`.
- **Checkout** (`checkout.html`): datos de entrega, método de pago (**tarjeta**, **PayPal**, **transferencia SPEI** o **Monedero**), puntos del Club y resumen con subtotal, ahorro, impuestos configurados, envío y total.
- **Pago** (`POST /api/pagos/procesar`, `GET /api/pagos/{id}`): en una sola transacción valida stock, crea el pedido, registra el pago (`pagos`, un pago por pedido), descuenta inventario (SCM), descuenta el monedero, suma puntos y métricas (CRM), deja la bitácora en el ERP y manda el correo de confirmación. Tarjetas validadas con Luhn; la que termina en `0002` simula un rechazo del banco.
- **Monedero Kozmok** (`monedero.html`): saldo, recargas de $100 a $10,000 (tarjeta o PayPal al instante, transferencia pendiente de confirmar), historial de movimientos y reembolso automático si se cancela un pedido pagado con monedero.
- **Promociones** (porcentaje o monto, a todo el catálogo, una categoría o productos elegidos, con vigencia) e **impuestos** configurables (IVA 16 % por defecto) que se aplican solos en tienda y ERP.
- **Atención a clientes** (`/api/atencion/ticket`, `/atencion/tickets`, `/atencion/ticket/{id}`, `PUT /atencion/ticket/{id}/respuesta`): tickets con estado *Abierto / En proceso / Respondido / Cerrado*, cada uno registrado como interacción en el CRM.
- **Registro y autenticación** (`/api/auth/registro`, `/login`, `/logout`, `GET/PUT /perfil`, `/recuperar`, `/restablecer`): correo único, contraseña fuerte con bcrypt, sesión en cookie HttpOnly, recuperación de contraseña y “Mi cuenta → Seguridad” con sesiones abiertas y actividad.

### Seguridad (Etapa 5)
Ver **[SEGURIDAD.md](SEGURIDAD.md)**. Resumen: bloqueo por fuerza bruta (cuenta e IP), límite de intentos, sesiones seguras atadas al navegador, consultas parametrizadas + filtro de inyección SQL, limpieza de HTML y CSP contra XSS, verificación de origen (CSRF), control de acceso a datos propios (IDOR) y tablero de seguridad en el panel. Los ataques se demuestran con `npm run prueba:seguridad`.

### Tienda (cliente)
- **Catálogo** de 73 productos y 35 marcas, con búsqueda, filtros por categoría, uso, precio y marca (guardados en la URL), orden y vistos recientemente.
- **Carrito sin sesión**: se puede llenar sin cuenta (catálogo, Arma tu PC, asesor); al iniciar sesión o registrarse pasa solo a la cuenta.
- **Ficha de producto** con especificaciones, stock real, reseñas y **garantía extendida** (12, 24 o 36 meses, con certificado y folio).
- **Comparador** de hasta 4 productos lado a lado.
- **Arma tu PC**: armado pieza por pieza con validación de compatibilidad en vivo (socket, DDR4/DDR5, formato de placa y watts de la fuente) y builds recomendadas por uso.
- **Chatbot asesor**: pregunta uso → categoría → presupuesto (o texto libre) y sugiere hasta 5 productos con stock.
- **Carrito y checkout**: direcciones y métodos de pago guardados, impuestos configurables (IVA 16 %) y envío de $199 (gratis desde $10,000).
- **Mi cuenta**: pedidos con seguimiento y cancelación, monedero, favoritos, direcciones, métodos de pago, seguridad (contraseña, sesiones abiertas, actividad), preferencias y atención a clientes.
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

### Panel interno – Tienda en línea (Etapa 4, solo admin)
- **Resumen**: ventas en línea del mes, impuestos cobrados, ahorro por promociones, carritos activos y conversión, pagos por método, promociones más usadas, tickets y el flujo de integración CRM · SCM · ERP.
- **Promociones** (alta, edición, vigencia, productos aplicables, uso y ahorro otorgado), **Impuestos** (porcentaje, activar/desactivar, recaudado y calculadora), **Monedero** (saldos, recargas por confirmar, ajustes manuales con motivo, bloqueo y reporte mensual), **Pagos** (por método y estado, CSV), **Atención a clientes** (respuesta al ticket) y **Correos enviados** (bandeja simulada: confirmaciones, respuestas, recuperación de contraseña).
- **Seguridad** (Cuenta → Seguridad): eventos de ataques detectados, intentos de inicio de sesión, bloqueos con botón *Desbloquear* y sesiones activas con *Cerrar*.

---

## Roles

Roles empresariales del ERP: solo **Administrador**, **Ventas** y **Logística**.

| Rol | Entra a | Acceso |
|---|---|---|
| **Administrador** | Dashboard CRM | Todo: CRM, SCM, ERP y Tienda en línea, cuentas y equipo, Seguridad, Nivel ERP y Panel por rol |
| **Ventas** | Dashboard CRM | Clientes (CRM), Productos (SCM, solo consulta), Órdenes de clientes (ERP, con captura), Reportes y Mi actividad |
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
#    (sin .env se usan los valores del salón: postgres / 12345678)
cp .env.example .env

# 4. Cargar esquema, triggers y datos de ejemplo (se puede volver a ejecutar)
psql -U postgres -d kozmok -f db/database.sql

# 5. Iniciar el servidor
npm start        # o: npm run dev  (con nodemon)
```

- **Tienda:** http://localhost:3000
- **Panel interno:** http://localhost:3000/admin/login.html (a propósito, no hay enlace desde la tienda)

Si al arrancar la consola muestra `Base de datos: conectada … 73 productos`, todo está listo. Si la base es de una versión anterior, el servidor la actualiza solo al arrancar (renombra `pedido_items`/`tickets`, crea las tablas nuevas, pasa el carrito anterior al nuevo modelo y registra los pagos de los pedidos que ya había); también se puede recargar `db/database.sql` para empezar con los datos de ejemplo de la Etapa 4.

### Pruebas de seguridad (con el servidor encendido)

```bash
npm run prueba:seguridad     # fuerza bruta, inyección SQL y robo de sesión
npm run desbloquear          # levanta los bloqueos que dejó la demostración
```

### Cuentas de prueba

| Rol | Correo | Contraseña |
|---|---|---|
| Admin | admin@kozmok.mx | `Admin#KZ2026` |
| Ventas | laura.ventas@kozmok.mx | `Ventas#KZ2026` |
| Logística | paola.logistica@kozmok.mx | `Logistica#KZ2026` |
| Cliente | mariana@correo.com | `Demo#KZ2026` (monedero con $1,200) |
| Cliente | diego@correo.com · sofia@correo.com · carlos@correo.com | `Demo#KZ2026` |

Las pantallas de acceso ya no muestran estas contraseñas (eran credenciales expuestas a la vista).

---

## Estructura del proyecto

```
KOZMOK/
├── README.md
├── SEGURIDAD.md              # ataques, defensas y cómo demostrarlos
├── Manual_usuario.txt        # manual completo, sección por sección
└── kozmok/
    ├── server.js             # API REST (Express): /api/...
    ├── seguridad.js          # sesiones, bloqueos, filtros SQL/XSS, cabeceras
    ├── env.js, .env.example  # configuración (la contraseña real va en .env)
    ├── db.config.js          # conexión a PostgreSQL (lee .env)
    ├── db/database.sql       # esquema + triggers + datos de ejemplo
    ├── pruebas-seguridad/    # scripts de ataque contra el servidor local
    └── public/               # front-end estático
        ├── index.html, carrito.html, checkout.html, gracias.html,
        │   monedero.html, soporte.html, seguridad.html, recuperar.html, ...
        ├── css/style.css
        ├── js/               # api, layout, chatbot, tema, toasts, etc.
        └── admin/            # panel CRM, SCM (productos, inventario, nivel-scm, ...)
                              #   y ERP (erp, ordenes-erp, orden-nueva, nivel-erp,
                              #   reportes-erp, panel-roles)
                              # Tienda: tienda, promociones, impuestos, monedero,
                              #   pagos, correos · Cuenta: seguridad
                              # admin/js/permisos.js: permisos por rol (menú + API)
```

**Tablas principales:** usuarios, clientes, productos, categorías, proveedores, pedidos (con `origen` en línea / ERP), **pedido_detalle**, **carrito**, **carrito_detalle**, **pagos**, **promociones** (+ promocion_productos), **impuestos**, **tickets_atencion** (+ ticket_mensajes), **monederos** (+ movimientos_monedero), interacciones, métricas_clientes, movimientos_inventario, órdenes_compra, garantías, reseñas, favoritos, direcciones, métodos_pago, movimientos_puntos y chatbot_consultas. Seguridad: **sesiones**, **intentos_login**, **bloqueos**, **eventos_seguridad**, **recuperaciones** y **correos_salida**.

Relaciones de la Etapa 4: un cliente tiene un carrito activo y muchos pedidos; un carrito tiene muchos productos (carrito_detalle); un pedido tiene muchas partidas (pedido_detalle) y **un** pago (`pagos.pedido_id` único); un cliente genera muchos tickets y tiene un monedero; un producto pertenece a una categoría. Todas con llaves foráneas, `CHECK` (montos ≥ 0, saldo entre 0 y $50,000, porcentajes, fechas de promoción) e índices. Propias del ERP: estado_erp (nivel de implementación), procesos_erp (procesos internos de cada orden), recursos_erp (recursos de la empresa, expuestos en `GET/POST/PUT/DELETE /api/admin/erp/recursos`) y reportes_erp (reportes guardados); las órdenes empresariales son filas de pedidos con `origen = 'erp'`.

---

## Notas

- Es una **demo educativa**: no hay pasarela de pago ni se hacen cargos reales (el flujo de pago sí es completo). Nunca se guarda el número completo de la tarjeta ni el CVV.
- Las contraseñas se guardan con **bcrypt**; la sesión es un token aleatorio en cookie HttpOnly, guardado en la base solo como hash. Ver [SEGURIDAD.md](SEGURIDAD.md).
- No hay servidor de correo: los correos que manda el sistema se ven en *Tienda → Correos enviados*.
- Los detalles de cada pantalla están en [`Manual_usuario.txt`](Manual_usuario.txt), y en [`kozmok/README.md`](kozmok/README.md) hay notas técnicas adicionales.
