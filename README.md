# Kozmok

Tienda en línea de electrónica y cómputo (laptops, PCs, componentes y periféricos) con **CRM**, **SCM** (cadena de suministro), **ERP** (órdenes de clientes e integración de módulos), panel de administración por roles, panel de cliente y un **chatbot asesor** que recomienda productos según uso, presupuesto e inventario disponible.

Proyecto escolar construido con **Node.js + Express**, **PostgreSQL** y un front-end en HTML, CSS y JavaScript sin frameworks.

---

## Funcionalidades principales

### Tienda (cliente)
- **Catálogo** de 73 productos y 35 marcas, con búsqueda, filtros por categoría, uso, precio y marca (guardados en la URL), orden y vistos recientemente.
- **Carrito sin sesión**: se puede llenar sin cuenta (catálogo, Arma tu PC, asesor); al iniciar sesión o registrarse pasa solo a la cuenta.
- **Ficha de producto** con especificaciones, stock real, reseñas y **garantía extendida** (12, 24 o 36 meses, con certificado y folio).
- **Comparador** de hasta 4 productos lado a lado.
- **Arma tu PC**: armado pieza por pieza con validación de compatibilidad en vivo (socket, DDR4/DDR5, formato de placa y watts de la fuente) y builds recomendadas por uso.
- **Chatbot asesor**: pregunta uso → categoría → presupuesto (o texto libre) y sugiere hasta 5 productos con stock.
- **Carrito y checkout**: direcciones y métodos de pago guardados, IVA 16 % y envío de $199 (gratis desde $10,000).
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

---

## Roles

| Rol | Acceso |
|---|---|
Roles empresariales del ERP: solo **Administrador**, **Ventas** y **Logística**.

| Rol | Entra a | Acceso |
|---|---|---|
| **Administrador** | Dashboard CRM | Todo: CRM, SCM y ERP, cuentas y equipo, Nivel ERP y Panel por rol |
| **Ventas** | Dashboard CRM | Clientes e interacciones (CRM), consulta de productos, captura y seguimiento de órdenes de clientes (ERP), reportes y Mi actividad |
| **Logística** | Dashboard SCM | Productos, inventario, proveedores, movimientos y reposición (SCM); surte y envía las órdenes de clientes (ERP, sin capturarlas) y reportes |
| **Cliente** | Tienda | Solo la tienda y su propia cuenta |

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

# 3. Ajustar usuario y contraseña de PostgreSQL en db.config.js

# 4. Cargar esquema, triggers y datos de ejemplo (se puede volver a ejecutar)
psql -U postgres -d kozmok -f db/database.sql

# 5. Iniciar el servidor
npm start        # o: npm run dev  (con nodemon)
```

- **Tienda:** http://localhost:3000
- **Panel interno:** http://localhost:3000/admin/login.html (a propósito, no hay enlace desde la tienda)

Si al arrancar la consola muestra `Base de datos: conectada … 73 productos`, todo está listo.

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
    ├── db.config.js          # conexión a PostgreSQL
    ├── db/database.sql       # esquema + triggers + datos de ejemplo
    └── public/               # front-end estático
        ├── index.html, carrito.html, armar-pc.html, comparar.html, ...
        ├── css/style.css
        ├── js/               # api, layout, chatbot, tema, toasts, etc.
        └── admin/            # panel CRM, SCM (productos, inventario, nivel-scm, ...)
                              #   y ERP (erp, ordenes-erp, orden-nueva, nivel-erp,
                              #   reportes-erp, panel-roles)
                              # admin/js/permisos.js: permisos por rol (menú + API)
```

**Tablas principales:** usuarios, clientes, productos, categorías, proveedores, pedidos (con `origen` en línea / ERP), pedido_items, carrito_items, interacciones, métricas_clientes, movimientos_inventario, órdenes_compra, garantías, reseñas, favoritos, direcciones, métodos_pago, movimientos_puntos, tickets, ticket_mensajes y chatbot_consultas. Propias del ERP: estado_erp (nivel de implementación), procesos_erp (procesos internos de cada orden), recursos_erp (recursos de la empresa, expuestos en `GET/POST/PUT/DELETE /api/admin/erp/recursos`) y reportes_erp (reportes guardados); las órdenes empresariales son filas de pedidos con `origen = 'erp'`.

---

## Notas

- Es una **demo educativa**: no hay pasarela de pago ni se hacen cargos reales. Nunca se guarda el número completo de la tarjeta ni el CVV.
- Las contraseñas se guardan con **bcrypt**. Los tokens de sesión están simplificados (Base64); para producción convendría usar JWT con expiración y variables de entorno.
- Los detalles de cada pantalla están en [`Manual_usuario.txt`](Manual_usuario.txt), y en [`kozmok/README.md`](kozmok/README.md) hay notas técnicas adicionales.
