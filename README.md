# Kozmok

Tienda en línea de electrónica y cómputo (laptops, PCs, componentes y periféricos) con **CRM**, **SCM** (cadena de suministro), **ERP** (órdenes de clientes e integración de módulos), **carrito con pagos, monedero, promociones e impuestos configurables** (Etapa 4), **seguridad contra fuerza bruta, robo de sesión e inyección SQL, con verificación en dos pasos y reCAPTCHA** (Etapa 5), **garantías con casos de servicio, devoluciones por pasos y facturación CFDI 4.0**, panel de administración por roles, panel de cliente y un **chatbot asesor** que recomienda productos según uso, presupuesto e inventario disponible.

Proyecto escolar construido con **Node.js + Express**, **PostgreSQL** y un front-end en HTML, CSS y JavaScript sin frameworks.

---

## Funcionalidades principales

### Tienda (cliente)
- **Catálogo** de 73 productos y 35 marcas, con búsqueda, filtros por categoría, uso, precio, marca, "solo en promoción" y "solo disponibles" (guardados en la URL), orden (precio, más recientes, mayor descuento) y vistos recientemente.
- **Comercialización**: banner de promociones vigentes en la portada (con más de 3, un cuadro "Ver más" abre todas; cada una lleva al catálogo con exactamente sus productos, `?promo=ID`), productos **destacados** (se marcan en el panel), sección de **novedades** y precio con descuento visible (precio final, precio de lista tachado y etiqueta `-10%` / `-$500`) en catálogo, ficha, carrito y panel lateral.
- **Panel lateral de carrito y favoritos**: el corazón y el carrito de la barra abren un panel a la derecha (pestañas Carrito / Favoritos) sin cambiar de pantalla. Al agregar un producto el panel se abre solo unos segundos para confirmarlo.
- **Navegación cómoda**: buscador con sugerencias en vivo (productos con foto y precio, categorías y búsquedas recientes; tecla `/` para buscar), ficha de producto con enlace propio que se cierra con "atrás" y se puede compartir, catálogo de 24 en 24 con "Ver más", la posición del catálogo se conserva al regresar, botón "volver arriba", menú de categorías con sus marcas principales, migas de pan y botón **Regresar** en todas las páginas, y página 404 con buscador.
- **En el celular**: filtros en un panel lateral, barra inferior con Inicio, Catálogo, Favoritos, Carrito y Cuenta (con aviso de pedido en camino) y "Mi cuenta" como fila deslizable.
- **Checkout por pasos**: Carrito → Envío → Pago → Confirmar, con barra de avance, el resumen siempre visible y cada paso en la dirección (`?paso=2`), así "atrás" regresa al paso anterior. Si después de confirmar el pedido todavía no se paga (PayPal, SPEI o tienda), el cliente puede **regresarlo al carrito** para cambiar el método de pago: desde la página de pago, la de gracias o el aviso que sale en el carrito al volver con "atrás". El pedido se cancela sin cargo ni correo, los productos vuelven al carrito con su garantía, se libera el cupón y ya no se muestra en Mis pedidos (`POST /api/pedidos/:id/al-carrito`). Si se vence el tiempo para pagar, los productos también regresan al carrito.
- **Logo KZK** (estilo Arcade: letras inclinadas con contorno grueso y sombra sólida del color del tema): en la barra, el panel, los comprobantes y el ícono de la pestaña. La **tarjeta de socio** y la del Club usan el diseño KZK; el cliente puede cambiar al **diseño clásico** o al diseño **Tibu** (la mascota sobre un fondo de mar) desde la propia tarjeta o en Preferencias (se guarda en su cuenta).
- **Tibu, la mascota**: una criaturita con disfraz de tiburón, dibujada en el mismo estilo que el logo. Saluda en la portada y en los avisos vacíos, atiende el asesor con audífonos y sale en versión 8-bit en la página 404.
- **Diseño de la tienda en estilo Arcade** (igual que el logo): títulos gruesos, inclinados y en mayúsculas, botones con contorno marcado y sombra sólida del color del tema, etiquetas de promoción tipo calcomanía y pasos de compra en bloques inclinados. Funciona con los cuatro temas (Índigo, Esmeralda, Grafito y Claro); el panel interno conserva su diseño.
- **Carrito sin sesión**: se puede llenar sin cuenta (catálogo, Arma tu PC, asesor); al iniciar sesión o registrarse pasa solo a la cuenta.
- **Existencias a la vista**: cada tarjeta del catálogo dice cuántas piezas hay ("24 disponibles", "Quedan 3" o "Agotado") y el filtro **Solo disponibles** esconde los agotados. La ficha consulta la existencia al momento (`GET /api/productos/:id/existencia`) y la cantidad no pasa de las piezas disponibles ni del límite por pedido; también se ve en el carrito, Favoritos, el comparador y Arma tu PC.
- **Ficha de producto** con especificaciones, existencia al momento y reseñas (con la **respuesta de Kozmok** si el equipo respondió).
- **Garantía Kozmok de 12 meses incluida** en todo producto entregado (`GARANTIA_BASE_MESES`) y **garantía extendida** opcional de 24 o 36 meses, con certificado, folio y código. En *Mis garantías* el cliente pide servicio (falla y hasta 3 fotos) y sigue su **caso** (`RG-1xxx`) por etapas: Recibido → En diagnóstico → En reparación / Reemplazo → Listo para entregar → Cerrado, con mensajes con el equipo y avisos por correo.
- **Devoluciones** (*Mi cuenta → Devoluciones*): hasta 30 días después de la entrega, reembolso o cambio por producto y cantidad; cada devolución (`DEV-0000x`) muestra sus 4 pasos (Solicitada → Envía el producto → En revisión → Reembolso o cambio) y las instrucciones de envío cuando se aprueba.
- **Factura CFDI 4.0** desde *Mis pedidos* (hasta 30 días después del pago), timbrada con Facturama; llegan el PDF y el XML por correo.
- **Comparador** de hasta 4 productos lado a lado.
- **Arma tu PC**: armado pieza por pieza con validación de compatibilidad en vivo (socket, DDR4/DDR5, formato de placa y watts de la fuente) y builds recomendadas por uso.
- **Chatbot asesor**: pregunta uso → categoría → presupuesto (o texto libre) y sugiere hasta 5 productos con stock.
- **Carrito y checkout**: direcciones y métodos de pago guardados; desglose calculado por el servidor (productos, garantías, promociones, cada impuesto activo, envío de $199 —gratis desde $10,000— y puntos). Pago con **tarjeta, PayPal (simulado), monedero, SPEI o en tienda**.
- **Mi monedero**: saldo en pesos para pagar en un clic. Recarga con tarjeta o PayPal (al instante) o por transferencia (se acredita cuando el equipo la confirma), historial con el saldo de cada movimiento y reembolso automático si se cancela una compra pagada con monedero.
- **Mi cuenta**: pedidos con seguimiento y cancelación, devoluciones, garantías, favoritos, direcciones, métodos de pago, seguridad, preferencias y tickets de soporte. Al abrir un ticket el cliente puede elegir uno de sus pedidos o cupones y **adjuntar hasta 3 fotos** (por ejemplo, de un producto que llegó dañado); también en cada respuesta; la prioridad la pone el sistema según el caso, y un ticket resuelto o cerrado ya no recibe mensajes (se abre uno nuevo).
- **Mis cupones**: al confirmar su correo el cliente recibe un **cupón de bienvenida** (por correo y en *Mi cuenta → Mis cupones*). Cada cupón muestra su descuento, compra mínima y vigencia, se elige en el paso Pago del carrito y tiene el botón **¿Problema con este cupón?**, que abre un ticket ya ligado al cupón. Soporte puede extenderlo, reactivarlo o dar uno nuevo desde el ticket.
- **Club de puntos**: niveles Bronce, Plata, Oro y Platino; 100 puntos equivalen a $10 de descuento. **Antes de comprar** se ve cuántos puntos da cada producto ("+N pts" en el catálogo y en la ficha, según cantidad y garantía), el carrito lateral y el resumen del checkout; el servidor los calcula con la misma regla con la que después los abona (`GET /api/club/regla` y `puntos_a_ganar` en `POST /api/checkout/cotizar`).
- **Tarjeta virtual de socio** con código QR para verificación en tienda física.
- **4 temas de color** (Índigo, Esmeralda, Grafito y Claro).

### Navegación del panel
- **Regresar a <pantalla anterior>** arriba de cada pantalla: recuerda el camino de la pestaña y regresa con sus filtros.
- **Ir a…** (`Ctrl + K` o `/`): busca una sección por nombre (varias palabras en cualquier orden) y entra con Enter (`Ctrl + Enter`, en otra pestaña). Sin escribir, muestra primero las fijadas y las recientes.
- **Secciones fijadas**: la estrella de cada sección (en el menú o en Ir a…) la pone hasta arriba del menú; hasta 9, que se abren con `Alt + 1…9`. Se guardan por cuenta en el navegador.
- **Notificaciones** para todas las cuentas del panel, en la página (campana con contador, aviso emergente y, si se permite, aviso del navegador) y **por correo** (un solo correo si llegan varias juntas): tickets y mensajes de clientes, reclamos de garantía, devoluciones, reseñas de 3★ o menos, pedidos nuevos, pagos reportados, recargas por confirmar, stock crítico o agotado, bajas por aprobar y alertas de seguridad. Cada quien recibe solo lo de las secciones de su rol y elige, por tipo, si lo quiere en el panel y por correo.
- **Puntitos de aviso** en el menú cuando una sección tiene algo nuevo desde la última vez que la abriste (tickets, pedidos, pagos o recargas por confirmar, reclamos, devoluciones, reseñas, stock crítico, alertas de seguridad…).

### Panel interno – CRM
- **Dashboard** con KPIs, clientes en riesgo y productos más vendidos.
- **Clientes**: búsqueda, filtros por etapa y por estado, alta (sin contraseña: al cliente le llega un correo con un enlace de 72 h para crear la suya), edición y baja en dos pasos (si ya compró primero se marca inactivo; ya inactivo se elimina por completo y sus pedidos quedan como "Cliente eliminado"); etapas `Prospecto → Activo → Frecuente → Inactivo`; un cliente pasa a *Activo* automáticamente con su primera compra.
- **Interacciones** (llamada, correo, reunión, soporte y chat) y **reportes** por rango de fechas.
- **Evaluaciones**: promedio, distribución de estrellas (clic para filtrar), productos peor calificados y filtros (sin responder, con comentario, ocultas). Cada reseña abre su detalle (compra verificada, cliente, reclamos del producto); el equipo **responde en público** (le llega al cliente por correo) u **oculta** la reseña con motivo.
- **Centro de soporte** (inicio del rol Soporte): buscador por cliente, folio de error, o pedido; indicadores (tickets sin respuesta, reclamos, devoluciones, reseñas sin responder, tiempo de primera respuesta) y una sola bandeja **Por atender** con tickets, reclamos de garantía, devoluciones y reseñas críticas, ordenada por quién debe responder, prioridad y antigüedad; los tickets se responden ahí mismo.
- **Soporte** con tickets (`TK-1001…`), estados y prioridades. Las fotos que mande el cliente se ven en el hilo y el equipo también puede adjuntar fotos. **Diagnóstico** de solo lectura ("Revisar la cuenta", `GET /api/admin/tickets/:id/diagnostico`): acceso y bloqueos, correos que fallaron, carrito sin existencia, posible cobro doble, eventos de seguridad, folios de error y si otros clientes reportan lo mismo. El cliente recibe un correo cuando le responden o se resuelve su ticket, y el ticket guarda su navegador y dispositivo. Junto al caso está el cuadro **Cupones del cliente**: dar un cupón de compensación, extender, reactivar o cancelar (con motivo). Si el caso trae pedido, se ve y se gestiona ahí mismo (avanzar, registrar pago, cancelar) y se le deja escrita la respuesta al cliente; si no, se puede ligar uno.
- **Garantías**: reclamos en curso con etapas, resolución, conversación, fotos y notas internas; reclamo en mostrador; validación por código; garantías incluidas y extendidas.
- **Pedidos** y **analítica del chatbot** (qué se busca y qué búsquedas quedaron sin recomendación).

### Panel interno – SCM
- **Dashboard SCM** con métricas, más vendidos, push vs pull e inventario crítico.
- **Productos** (catálogo: alta, edición, filtros por categoría y estrategia) e **Inventario** (existencias, estado Normal / Stock bajo / Agotado, valor del inventario y detalle con últimos movimientos), como pantallas separadas.
- **Proveedores** (con contacto, dirección y tiempo de entrega) y **movimientos de inventario**.
- **Pedidos** de reposición (`OC-100x`, a proveedores) y de venta en un solo listado, con filtros por estado y tipo, y su formulario (producto, cantidad, proveedor, fecha estimada de entrega, notas).
- **Reabasto automático**: al llegar al stock mínimo se genera solo el pedido al proveedor (push en cuanto toca el mínimo, pull solo cuando lo dispara una venta) y al llegar su fecha de entrega se surte solo, con su movimiento de entrada registrado a nombre del sistema. Tiene un modo de entrega inmediata (el pedido llega al momento).
- **Logística**: filtros a la izquierda (búsqueda, categoría con su conteo, estrategia, solo críticos) y a la derecha los productos al instante, cada uno con su interruptor *push* / *pull* y cambio en bloque.
- **Eliminar un producto solo lo desactiva** (sale de la tienda; en carritos y favoritos aparece como "ya no está a la venta"). El borrado definitivo de la base pide que esté desactivado, sin historia y el código `CODIGO_BORRADO_DEFINITIVO` del `.env` (quedará para el superadmin).
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
- **Promociones**: alta y edición de descuentos por **porcentaje** o **monto por pieza**, para todo el catálogo, por **categoría, marca y/o palabras del nombre** combinables (p. ej. Periféricos + Logitech + "mouse") o **eligiendo productos uno por uno**, con vista previa en vivo de los productos y su precio final. Vigencia (inicio–fin: el inicio no puede ser anterior a hoy y no cambia si ya empezó), activa/inactiva y "mostrar en el banner". Muestra situación (vigente, programada, vencida, inactiva), pedidos que la usaron y descuento otorgado. Se aplican solas en catálogo, carrito, checkout y órdenes del ERP (si a un producto le tocan varias, gana la que más descuenta).
- **Cupones**: todos los cupones (bienvenida y los que da el equipo) con indicadores (disponibles, por vencer, usados, descuento otorgado y ventas con cupón), filtros, bitácora de cada cupón, extender / reactivar / cancelar con motivo y **Dar cupón** a cualquier cliente. **Enviar a varios clientes** (Administrador y Ventas): a todos, por criterios (nivel del Club, etapa del CRM, compras, gasto, clientes que dejaron de comprar, recién registrados, cumpleaños del mes) o a una lista; con vista previa obligatoria de a quiénes llega, un código por cliente, aviso por correo y seguimiento de cada envío (usados, descontado, cancelar los no usados). Ventas y Soporte tienen tope; el administrador no.
- **Impuestos** (solo admin): configurador del cálculo. Se aplican todos los activos sobre el subtotal ya con promociones (p. ej. subtotal 1000 + IVA 16 % = 1160). Cada pedido guarda su desglose (`impuestos_detalle`), así que cambiar un porcentaje no altera pedidos anteriores.
- **Monedero**: saldo total en monederos, recargas y consumos del mes, gráfica de 6 meses, recargas por transferencia por confirmar o rechazar, ficha de cada cliente con su historial, **ajustes manuales** (abono o cargo con motivo, quedan a nombre de quien los hizo) y bloqueo del monedero.
- **Facturas**: CFDI 4.0 de los pedidos de la tienda y del ERP, timbrados con Facturama (PDF y XML).
- **Devoluciones**: tablero por etapas (Por revisar, En camino, Por cerrar, Cerradas) y detalle con la acción de cada paso: aprobar o rechazar, registrar la recepción (qué vuelve a venta) y reembolsar (PayPal, monedero o transferencia) o enviar el cambio. El monto lo calcula el sistema; los reembolsos mayores a $3,000 solo los autoriza un administrador.
- **Pagos**: el pago de cada pedido (tienda y ERP) con método, monto, estado (pagado, pendiente, reembolsado, cancelado), referencia y fecha de cobro; filtros, totales por método y exportación a CSV. "Gestionar" abre el gestor del pedido para registrar el cobro.

### Seguridad (Etapa 5)
Detalle de cada ataque, cómo se prueba y qué lo detiene en [`SEGURIDAD.md`](SEGURIDAD.md).
- **Panel en dirección secreta** (`panel.js`): las pantallas del panel no se sirven en `/admin/` (da 404, también con mayúsculas o codificada) sino en `/<PANEL_RUTA>/`; los enlaces de las pantallas, las respuestas de `/api/admin` y los correos al equipo se traducen solos. Dentro de la ruta, cada pantalla pide una sesión del equipo y un rol que la pueda ver (validado en el servidor contra la base, no contra el navegador: cambiar el rol en `localStorage` ya no abre pantallas de otro rol); sin sesión manda al login con `?next=`. Los intentos de abrir `/admin/login.html` quedan en *Seguridad → Eventos*. Es una capa extra sobre la sesión, los dos pasos y los permisos.
- **Datos sensibles en tickets** (`public/js/datos-sensibles.js`): las respuestas del equipo que piden contraseña, tarjeta completa, CVV, NIP o códigos se rechazan (y la pantalla avisa mientras se escribe), y si alguien escribe esos datos en un ticket se guardan ocultos. El cliente solo recibe los campos públicos de su ticket (no la prioridad ni a quién se asignó).
- **Folio de errores** (`errores_servidor`): cuando algo falla, el usuario ve "comparte este folio con Soporte: A1B2C3" y el error queda guardado con ese folio (sin la parte de la dirección después del `?`, que puede llevar tokens). Soporte lo busca en el Centro de soporte y el diagnóstico del ticket lo encuentra solo.
- **Fuerza bruta**: la cuenta se bloquea 15 min tras 5 contraseñas equivocadas y la IP 30 min tras 20 fallos; máximo 15 intentos por minuto, retraso progresivo y el mismo mensaje exista o no el correo.
- **Robo de credenciales y de sesión**: la sesión va en una cookie `HttpOnly; SameSite=Strict` con un token aleatorio (en la base solo su hash), vence, se cierra por inactividad y queda atada al navegador: si alguien la copia a otro, se revoca. Contraseñas con bcrypt y política fuerte (8+ caracteres, mayúsculas, minúsculas, número y símbolo).
- **Verificación en dos pasos**: código de una app autenticadora (Google o Microsoft Authenticator) o por correo; obligatoria en el panel y opcional en la tienda. El administrador la reinicia si alguien pierde su celular.
- **reCAPTCHA** ("No soy un robot") en iniciar sesión, crear cuenta y recuperar contraseña, con las llaves `RECAPTCHA_SITE_KEY` y `RECAPTCHA_SECRET_KEY` del `.env`.
- **Inyección SQL**: consultas parametrizadas en todo el servidor, filtro que bloquea y registra los intentos, ids numéricos validados y errores de la base ocultos.
- **XSS, CSRF y datos ajenos**: limpieza de HTML en lo que entra y escape al mostrar, cabeceras CSP, rechazo de peticiones de otros sitios y cada cliente solo ve lo suyo.
- **Tienda**: "¿Olvidaste tu contraseña?" con enlace de un solo uso (30 min) y *Mi cuenta → Seguridad* con los dispositivos conectados (se pueden cerrar) y los últimos inicios de sesión.
- **Mantener sesión iniciada** (solo tienda): casilla en el login, marcada por defecto. Marcada, la sesión sobrevive a cerrar el navegador durante 30 días (`SESION_DIAS_RECORDAR_CLIENTE` en el `.env`); sin marcar, termina al cerrar el navegador. El panel interno recuerda solo el correo de la cuenta y su sesión se cierra al cerrar la pestaña o el navegador. El navegador también **recuerda la cuenta** (nombre y correo, nunca la contraseña): al cerrar sesión, el login la ofrece con un clic y solo pide la contraseña; se puede quitar con la ×.
- **Contraseñas sencillas de antes**: como las contraseñas se guardan cifradas, se revisan al iniciar sesión. Si no cumplen la política actual (cuentas creadas antes de ella), al cliente se le lleva a *Mi cuenta → Seguridad* con un aviso (puede elegir "Ahora no") y ve una franja en la tienda hasta cambiarla; al equipo se le abre "Cambiar mi contraseña" en el panel. Todo el equipo puede cambiar su contraseña desde el menú del panel (`PUT /api/admin/mi-password`).
- **Correo comprobado al registrarse**: se acepta cualquier terminación (gmail, hotmail, outlook, la de una escuela o empresa…) siempre que exista: el servidor revisa en el DNS que el dominio tenga servidor de correo (registro MX) y atrapa errores de dedo como `@gmial.com` o `@hotmail.con`, ofreciendo "¿Quisiste decir…?". Con Gmail configurado, además llega un **código de 6 dígitos** (vence en 30 min, 5 intentos, reenvío cada 60 s) y hasta escribirlo en `verificar.html` la cuenta puede navegar y llenar el carrito pero no comprar (`POST /api/pedidos` responde 403 `correo_no_verificado`). Restablecer la contraseña por el enlace del correo también lo confirma, y en la ficha del cliente del CRM se puede marcar como confirmado a mano. Sin Gmail configurado, o sin internet al registrarse, no se bloquea a nadie.
- **Boletín y avisos por correo** (el cliente elige en *Mi cuenta → Preferencias*, en la casilla del registro o con "Sí, avisarme" en Favoritos): **boletín de promociones** (cada promoción se anuncia una sola vez, al empezar, con algunos productos rebajados), **bajas de precio** de sus favoritos (por promoción o cambio de precio), **favoritos disponibles otra vez** y **avisos de pedidos** (pedido recibido y cada cambio de estado; activado por defecto). Se revisan cada minuto, así funcionan venga el cambio de donde venga (panel, ERP, SCM, reabasto). Solo se mandan a correos confirmados; cada correo trae un enlace "Dejar de recibir estos correos" (`/baja`) que pide confirmación. Los datos de ejemplo cuentan como ya avisados.
- **Correos reales por Gmail**: bienvenida al crear la cuenta, enlace para recuperar la contraseña y aviso de cambio de contraseña, con diseño HTML. Se configuran en el `.env` (`SMTP_USUARIO` y `SMTP_PASSWORD` con una *contraseña de aplicación* de Google); sin configurar, solo se guardan en el panel. Cada correo queda en *Seguridad → Correos enviados* con su estado (enviado, en cola, no se envió) y un botón para reenviarlo; si Gmail falla se reintenta hasta 3 veces. El cliente SMTP (`correo.js`) no usa dependencias.
- **Panel** (*Cuenta → Seguridad*, solo admin): eventos de seguridad, intentos de inicio de sesión, bloqueos (con "Desbloquear"), sesiones activas y correos enviados. La actividad normal de las cuentas (activar dos pasos, cambiar la contraseña, una pestaña vieja tras cerrar sesión) se guarda con severidad *normal*: no cuenta como alerta y se ve solo si se pide.
- **Pruebas**: `npm run prueba:seguridad` ataca nuestro propio servidor (fuerza bruta, inyección SQL, robo de sesión) y marca cada defensa como DEFENDIDO o VULNERABLE. Necesita una cuenta de cliente de prueba en el `.env` (`PRUEBA_CORREO`, `PRUEBA_PASSWORD`); ver [`SEGURIDAD.md`](SEGURIDAD.md). También se puede atacar por Wi-Fi desde otra computadora de la misma red (por ejemplo el hotspot de un celular): `node pruebas-seguridad/todas.js http://192.168.x.x:3000`.

---

## Roles

Roles empresariales del ERP: **Administrador**, **Ventas**, **Logística** y **Soporte**.

| Rol | Entra a | Acceso |
|---|---|---|
| **Administrador** | Dashboard CRM | Todo: CRM, SCM, ERP y Tienda (incluidos Impuestos), cuentas y equipo, Nivel ERP y Panel por rol |
| **Ventas** | Dashboard CRM | Clientes (CRM), Productos (SCM, solo consulta), Órdenes de clientes (ERP, con captura), Reportes, Promociones, Cupones, Monedero, Pagos y Mi actividad |
| **Logística** | Dashboard SCM | Productos e Inventario (SCM, con movimientos y pedidos de reposición en ventana), Órdenes de clientes (ERP, captura, surte y envía) y Reportes |
| **Soporte** | Centro de soporte | Tickets, Garantías, Devoluciones, Evaluaciones, Clientes (solo consulta: ficha, interacciones y confirmar correo), Interacciones, Pedidos, Facturas y Cupones del cliente |
| **Cliente** | Tienda | Solo la tienda y su propia cuenta |

Los menús de Ventas y Logística son exactamente los de la lámina *Panel por rol (Menú dinámico)* (Soporte se agregó después); la pantalla **Panel por rol** los muestra con su vista previa del menú y la matriz de permisos.

Los permisos viven en un solo archivo, `public/admin/js/permisos.js`, que usan **el menú** (menú dinámico según el usuario) **y el servidor** (control de acceso por módulo en cada llamada a `/api/admin/...`), así que nunca se contradicen. Si alguien abre por URL una sección que no le corresponde, el panel lo regresa a su inicio y la API responde 403. El administrador cambia el rol de cualquier persona desde *Cuentas y equipo* (`PUT /api/admin/usuarios/:id/rol`); `GET /api/usuarios/rol` devuelve el rol y los permisos de la sesión, y `POST /api/auth/login` responde también con ellos.

Al arrancar sobre una base anterior, el servidor migra solo los roles viejos (*vendedor* pasa a **Ventas** y *almacén* a **Logística**) y agrega el rol **Soporte** con su cuenta.

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
#    (el .env no se sube a GitHub). Para que los correos salgan de verdad,
#    pon también SMTP_USUARIO y SMTP_PASSWORD (ver "Correos por Gmail").

# 4. Cargar esquema, triggers y datos de ejemplo (se puede volver a ejecutar)
psql -U postgres -d kozmok -f db/database.sql

# 5. Iniciar el servidor
npm start        # o: npm run dev  (con nodemon)
```

### Correos por Gmail

1. En la cuenta de Gmail que enviará los correos activa la **verificación en dos pasos**.
2. Entra a <https://myaccount.google.com/apppasswords>, crea una contraseña de aplicación (por ejemplo "Kozmok") y copia las 16 letras.
3. En el `.env`:

```
SMTP_USUARIO=tucuenta@gmail.com
SMTP_PASSWORD=abcd efgh ijkl mnop
```

4. Prueba la configuración sin encender la tienda: `npm run prueba:correo` (manda un correo de prueba a la misma cuenta) o `npm run prueba:correo -- otra@correo.com`.
5. Reinicia el servidor. La consola dice `Correo: Gmail conectado como …` si todo está bien, o el motivo si Gmail lo rechazó.

Si pruebas desde un celular, pon `URL_PUBLICA=http://192.168.x.x:3000` para que el enlace de recuperación abra desde ese celular (con `localhost` solo abre en la computadora del servidor).

- **Tienda:** http://localhost:3000
- **Panel interno:** en una **dirección secreta**, `http://localhost:3000/<PANEL_RUTA>/login.html`; la consola la muestra al arrancar. `/admin/` responde "página no encontrada". Si el `.env` no trae `PANEL_RUTA`, el servidor inventa una al azar la primera vez y la guarda en `.panel-ruta` (no se sube a GitHub); `PANEL_RUTA=admin` vuelve a la dirección de antes. Los correos al equipo ya llevan la ruta correcta.
- Las gráficas del panel usan Chart.js instalado con `npm install` (se sirve en `/vendor/chart.js/`), así funcionan sin internet; si falta, se intenta desde cdnjs y, si tampoco carga, cada gráfica muestra un aviso en vez de un error. (a propósito, no hay enlace desde la tienda)
- **Desde un celular de prueba:** conéctalo a la misma red Wi-Fi que la computadora y abre la dirección que muestra la consola al arrancar (`Desde un celular en la misma red Wi-Fi abre: http://192.168.x.x:3000`). En Windows, la primera vez que corre `npm start` sale un aviso del Firewall: marca **Redes privadas** y dale **Permitir acceso** (y que la red Wi-Fi esté como *Privada*). Si la red es de la escuela y no conecta, puede bloquear la comunicación entre equipos: usa el hotspot de un celular. Con `HOST=127.0.0.1` en el `.env` solo se abre desde la computadora.
- **Dirección fija aunque cambie la red:** usa **http://kozmok.local:3000** (panel: `/<PANEL_RUTA>/login.html`). El servidor anuncia ese nombre en la red local (mDNS, `mdns.js`, sin dependencias) con la IP que tenga en ese momento. Como el navegador guarda contraseñas, cuentas recordadas, tema y carrito *por dirección*, con la IP todo eso se "pierde" al cambiar de red; con el nombre fijo no. Si la red cambia con el servidor encendido, la consola muestra las direcciones nuevas. `MDNS_NOMBRE` en el `.env` cambia el nombre (`no` lo apaga); si algún celular no abre el nombre, usa la IP.

Si al arrancar la consola muestra `Base de datos: conectada … 73 productos`, todo está listo.

> **Actualizar a la Etapa 5:** al arrancar, el servidor crea solo las tablas de seguridad que falten. Las sesiones anteriores (token Base64 guardado en el navegador) ya no sirven: hay que volver a iniciar sesión. Las contraseñas nuevas deben cumplir la política; las cuentas de prueba ya la cumplen.

> **Actualizar desde una versión anterior (Etapa 4):** vuelve a cargar `db/database.sql` (paso 4). Crea las tablas nuevas (`carrito`, `carrito_detalle`, `pagos`, `promociones`, `impuestos`, `monederos`, `movimientos_monedero`) y reemplaza `carrito_items`. Si faltan, la consola lo avisa al arrancar.

### Cuentas del panel

La base empieza sin datos de ejemplo: sin clientes, pedidos ni interacciones. Todo lo que aparece en CRM, ERP y reportes viene del uso real de la tienda. El panel trae una cuenta por rol; las cuatro piden cambiar la contraseña la primera vez que entran:

| Rol | Nombre | Correo | Contraseña inicial |
|---|---|---|---|
| Administrador | Administrador | admin@kozmok.mx | `Admin#KZ2026` |
| Ventas | Laura Méndez | laura.ventas@kozmok.mx | `Ventas#KZ2026` |
| Logística | Paola Nieto | paola.logistica@kozmok.mx | `Logistica#KZ2026` |
| Soporte | Sofía Ramírez | sofia.soporte@kozmok.mx | `Soporte#KZ2026` |

> **Antes de configurar Gmail:** el panel pide la verificación en dos pasos y, por defecto, manda el código al correo de la cuenta. Los correos `@kozmok.mx` no existen, así que ese código nunca llegaría. Entra como `admin@kozmok.mx`, crea en *Cuentas y equipo* una cuenta de Administrador con tu correo real, entra con ella y desactiva las de `@kozmok.mx` que no uses. Sin Gmail configurado el código no se pide (para no dejar fuera al equipo).

Si tu base es de una versión que no tenía las cuentas de Ventas, Logística o Soporte (o `limpiar:ejemplo` las desactivó), el servidor las crea o reactiva una sola vez al arrancar. Si después el administrador las desactiva, se quedan desactivadas.

Los clientes se registran en la tienda y más empleados se dan de alta en el panel (Cuentas y equipo); a cada empleado nuevo se le pide cambiar la contraseña la primera vez.

**¿Tu base ya tenía los datos de ejemplo?** `npm run limpiar:ejemplo` muestra qué hay y `npm run limpiar:ejemplo -- --confirmar` borra los 4 clientes de prueba con sus pedidos, puntos y monederos y quita la promoción de ejemplo. No toca productos, empleados ni nada que hayas creado tú.

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
    ├── cupones.js            # cupones de bienvenida y de Soporte
    ├── panel.js              # sirve el panel en su dirección secreta (PANEL_RUTA)
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

**Tablas principales:** usuarios, clientes, productos, categorías, proveedores, pedidos (con `origen` en línea / ERP), pedido_items, carrito y carrito_detalle, interacciones, métricas_clientes, movimientos_inventario, órdenes_compra, garantías, reseñas, favoritos, direcciones, métodos_pago, movimientos_puntos, tickets, ticket_mensajes y chatbot_consultas. Propias del ERP: estado_erp (nivel de implementación), procesos_erp (procesos internos de cada orden), recursos_erp (recursos de la empresa, expuestos en `GET/POST/PUT/DELETE /api/admin/erp/recursos`) y reportes_erp (reportes guardados); las órdenes empresariales son filas de pedidos con `origen = 'erp'`. Propias de la Etapa 4: carrito (uno por cliente) y carrito_detalle, pagos (uno por pedido, lo mantiene el trigger `trg_pedido_pago`), promociones, impuestos, monederos (lo crea el trigger `trg_cliente_monedero` para cada cliente) y movimientos_monedero. Cupones: cupones (y `cupon_id`/`descuento_cupon` en pedidos); fotos de tickets: ticket_adjuntos. Propias de la Etapa 5: sesiones, intentos_login, bloqueos, eventos_seguridad, recuperaciones, recuperaciones_usuario, activaciones_usuario, desafios_2fa y correos_salida. Garantías y devoluciones: reclamos_garantia, reclamo_mensajes y reclamo_adjuntos; devoluciones y devolucion_items. Promociones por selección: promocion_productos. Control interno y facturación (`db/control_interno.sql`, se carga solo al arrancar): auditoria, facturas y datos_fiscales.

### Rutas de la Etapa 4 (nombres del documento)

| Sección | Rutas |
|---|---|
| Catálogo | `GET /api/catalogo`, `GET /api/catalogo/:id`, `?categoria=`, `?buscar=`, `?destacado=1`, `?promocion=1`, `?disponible=1`, `?orden=novedades`, `GET /api/productos/:id/existencia` |
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

- **Pagos y facturas**: PayPal y Facturama se conectan con sus credenciales del `.env`; en modo *sandbox* no se cobra dinero real y los CFDI no tienen validez fiscal. El pago con tarjeta es simulado: nunca se guarda el número completo de la tarjeta ni el CVV.
- Al arrancar, el servidor actualiza solo la base (columnas y tablas nuevas, permisos y migraciones de datos), así que basta `git pull` y reiniciar.
- Las contraseñas se guardan con **bcrypt** y las sesiones son tokens aleatorios en cookie HttpOnly (Etapa 5, ver [`SEGURIDAD.md`](SEGURIDAD.md)). En producción hay que servirlo con HTTPS y `COOKIE_SEGURA=1`.
- Los detalles de cada pantalla están en [`Manual_usuario.txt`](Manual_usuario.txt), y en [`kozmok/README.md`](kozmok/README.md) hay notas técnicas adicionales.
