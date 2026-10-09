# Kozmok

Tienda en línea de electrónica y cómputo (laptops, PCs, componentes y periféricos) con **CRM**, **SCM** (cadena de suministro), panel de administración por roles, panel de cliente y un **chatbot asesor** que recomienda productos según uso, presupuesto e inventario disponible.

Proyecto escolar construido con **Node.js + Express**, **PostgreSQL** y un front-end en HTML, CSS y JavaScript sin frameworks.

---

## Funcionalidades principales

### Tienda (cliente)
- **Catálogo** con búsqueda, filtros por categoría, uso y precio (guardados en la URL), orden y vistos recientemente.
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
- **Clientes**: etapas `Prospecto → Activo → Frecuente → Inactivo`; un cliente pasa a *Activo* automáticamente con su primera compra.
- **Interacciones** (llamada, correo, reunión, soporte y chat), **evaluaciones** y **reportes** por rango de fechas.
- **Soporte** con tickets (`TK-1001…`), estados y prioridades.
- **Pedidos**, **garantías** y **analítica del chatbot** (qué se busca y qué búsquedas quedaron sin recomendación).

### Panel interno – SCM
- **Inventario** con alertas de stock crítico.
- **Proveedores** y **movimientos de inventario**.
- **Órdenes de compra** (`OC-100x`), generadas automáticamente cuando un producto llega a stock crítico.
- **Logística**: estrategia de reabastecimiento *push* o *pull* por producto.
- **Dashboard SCM** con nivel de madurez calculado a partir de los datos y **reportes SCM**.

---

## Roles

| Rol | Acceso |
|---|---|
| **Administrador** | Acceso total, incluida la gestión de cuentas y del equipo |
| **Vendedor** | CRM y tienda completos, sin gestión de cuentas |
| **Soporte** | Clientes, interacciones, evaluaciones, soporte, garantías y reportes |
| **Almacén** | Pedidos, inventario, proveedores, garantías y analítica del chatbot |
| **Cliente** | Solo la tienda y su propia cuenta |

El menú del panel se adapta al rol. Si alguien abre por URL una sección que no le corresponde, el sistema lo regresa al Dashboard.

---

## Instalación y ejecución

**Requisitos:** Node.js 18 o superior y PostgreSQL 16 o superior.

```bash
# 1. Clonar e instalar dependencias
git clone https://github.com/YosefDC6/Tiendatech.git
cd Tiendatech/kozmok
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

Si al arrancar la consola muestra `Base de datos: conectada … 20 productos`, todo está listo.

### Cuentas de prueba

| Rol | Correo | Contraseña |
|---|---|---|
| Admin | admin@kozmok.mx | `Admin#KZ2026` |
| Vendedor | laura.vendedor@kozmok.mx | `Vendedor#KZ2026` |
| Soporte | ruben.soporte@kozmok.mx | `Soporte#KZ2026` |
| Almacén | paola.almacen@kozmok.mx | `Almacen#KZ2026` |
| Cliente | mariana@correo.com | `Demo#KZ2026` |

---

## Estructura del proyecto

```
Tiendatech/
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
        └── admin/            # panel CRM y SCM
```

**Tablas principales:** usuarios, clientes, productos, categorías, proveedores, pedidos, pedido_items, carrito_items, interacciones, métricas_clientes, movimientos_inventario, órdenes_compra, garantías, reseñas, favoritos, direcciones, métodos_pago, movimientos_puntos, tickets, ticket_mensajes y chatbot_consultas.

---

## Notas

- Es una **demo educativa**: no hay pasarela de pago ni se hacen cargos reales. Nunca se guarda el número completo de la tarjeta ni el CVV.
- Las contraseñas se guardan con **bcrypt**. Los tokens de sesión están simplificados (Base64); para producción convendría usar JWT con expiración y variables de entorno.
- Los detalles de cada pantalla están en [`Manual_usuario.txt`](Manual_usuario.txt), y en [`kozmok/README.md`](kozmok/README.md) hay notas técnicas adicionales.
