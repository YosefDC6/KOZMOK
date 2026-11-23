-- =========================================================
-- CONTROL INTERNO (antifraude). Lo aplica el servidor al arrancar
-- (server.js -> migrarEsquema); se puede volver a ejecutar sin problema.
--
-- La idea: lo que ya pasó no se puede reescribir.
--   1) Las fechas de los registros históricos las pone la BASE DE DATOS
--      (reloj del servidor), nunca la pantalla ni el empleado.
--   2) Los movimientos (inventario, puntos, monedero) y la bitácora son
--      "solo agregar": no se editan ni se borran; un error se corrige con
--      un movimiento contrario, que también queda registrado.
--   3) La bitácora de auditoría va encadenada con SHA-256: cada registro
--      guarda la huella del anterior, así que si alguien borra o cambia un
--      registro directo en la base, la cadena se rompe y el panel lo marca.
--   4) Un pedido no cambia sus montos ni su fecha después de creado, y uno
--      entregado o cancelado ya no cambia de estado.
-- =========================================================

-- ---------- Bitácora de auditoría ----------
CREATE TABLE IF NOT EXISTS auditoria (
    id             BIGSERIAL PRIMARY KEY,
    fecha          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- sin llave foránea a propósito: el registro no depende de que el
    -- usuario siga existiendo (y un borrado no puede tocar la bitácora)
    usuario_id     INTEGER,
    usuario_nombre VARCHAR(150),
    rol            VARCHAR(20),
    accion         VARCHAR(40) NOT NULL,
    entidad        VARCHAR(40) NOT NULL,
    entidad_id     VARCHAR(40),
    antes          JSONB,
    despues        JSONB,
    motivo         TEXT,
    ip             VARCHAR(64),
    hash_anterior  CHAR(64),
    hash           CHAR(64)
);
-- El número lo pone el disparador (después del candado) para que la
-- secuencia no tenga huecos ni dos registros tomen el mismo "anterior".
ALTER TABLE auditoria ALTER COLUMN id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_auditoria_fecha   ON auditoria (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria (entidad, entidad_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria (usuario_id);

-- Huella de un registro (la misma fórmula sirve para verificar)
CREATE OR REPLACE FUNCTION kz_auditoria_huella(a auditoria) RETURNS CHAR(64) AS $$
    SELECT encode(sha256(convert_to(concat_ws('|',
        a.hash_anterior, a.id::text,
        to_char(a.fecha AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
        COALESCE(a.usuario_id::text, ''), a.accion, a.entidad, COALESCE(a.entidad_id, ''),
        COALESCE(a.antes::text, ''), COALESCE(a.despues::text, ''), COALESCE(a.motivo, '')
    ), 'UTF8')), 'hex')::char(64);
$$ LANGUAGE sql IMMUTABLE;

-- Al insertar: fecha del servidor, número consecutivo y huella encadenada.
-- El candado hace que dos inserciones al mismo tiempo no tomen el mismo
-- "anterior" (la segunda espera a que la primera termine).
CREATE OR REPLACE FUNCTION kz_auditoria_sellar() RETURNS trigger AS $$
DECLARE prev CHAR(64);
BEGIN
    PERFORM pg_advisory_xact_lock(727201);
    NEW.id := nextval(pg_get_serial_sequence('auditoria', 'id'));
    NEW.fecha := clock_timestamp();
    SELECT a.hash INTO prev FROM auditoria a ORDER BY a.id DESC LIMIT 1;
    NEW.hash_anterior := COALESCE(prev, repeat('0', 64));
    NEW.hash := kz_auditoria_huella(NEW);
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_auditoria_sellar ON auditoria;
CREATE TRIGGER trg_auditoria_sellar BEFORE INSERT ON auditoria
    FOR EACH ROW EXECUTE FUNCTION kz_auditoria_sellar();

-- La bitácora nunca se edita ni se borra (ni siquiera con "purga").
CREATE OR REPLACE FUNCTION kz_auditoria_inmutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'La bitácora de auditoría no se puede modificar ni borrar'
        USING ERRCODE = 'P0001', HINT = 'control_interno';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_auditoria_inmutable ON auditoria;
CREATE TRIGGER trg_auditoria_inmutable BEFORE UPDATE OR DELETE ON auditoria
    FOR EACH ROW EXECUTE FUNCTION kz_auditoria_inmutable();
DROP TRIGGER IF EXISTS trg_auditoria_sin_truncar ON auditoria;
CREATE TRIGGER trg_auditoria_sin_truncar BEFORE TRUNCATE ON auditoria
    FOR EACH STATEMENT EXECUTE FUNCTION kz_auditoria_inmutable();

-- ---------- Fecha del servidor en los registros históricos ----------
CREATE OR REPLACE FUNCTION kz_fecha_servidor() RETURNS trigger AS $$
BEGIN
    NEW.fecha := CURRENT_TIMESTAMP;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------- "Solo agregar" ----------
-- La única excepción es el borrado de un cliente desde el CRM (sus puntos
-- y su monedero se van con él): ese proceso activa kozmok.purga solo
-- dentro de su transacción y queda en la bitácora.
CREATE OR REPLACE FUNCTION kz_solo_agregar() RETURNS trigger AS $$
BEGIN
    IF current_setting('kozmok.purga', true) = 'si' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    RAISE EXCEPTION 'Los registros de % no se pueden modificar ni borrar. Si hubo un error, registra un movimiento contrario.', TG_TABLE_NAME
        USING ERRCODE = 'P0001', HINT = 'control_interno';
END $$ LANGUAGE plpgsql;

-- Movimientos de inventario: solo se puede resolver una solicitud de baja
-- pendiente (aprobarla o rechazarla); nada más cambia.
CREATE OR REPLACE FUNCTION kz_movinv_cambios() RETURNS trigger AS $$
BEGIN
    IF current_setting('kozmok.purga', true) = 'si' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.estado = 'pendiente' AND NEW.estado IN ('aplicado', 'rechazado')
       AND NEW.producto_id IS NOT DISTINCT FROM OLD.producto_id AND NEW.tipo = OLD.tipo
       AND NEW.cantidad = OLD.cantidad AND NEW.motivo IS NOT DISTINCT FROM OLD.motivo
       AND NEW.usuario_id IS NOT DISTINCT FROM OLD.usuario_id AND NEW.fecha = OLD.fecha THEN
        NEW.resuelto_fecha := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Los movimientos de inventario no se pueden modificar ni borrar. Si hubo un error, registra un movimiento contrario.'
        USING ERRCODE = 'P0001', HINT = 'control_interno';
END $$ LANGUAGE plpgsql;

-- Movimientos del monedero: solo una recarga pendiente se confirma o se
-- cancela (al confirmarla se pone la fecha del servidor).
CREATE OR REPLACE FUNCTION kz_movmon_cambios() RETURNS trigger AS $$
BEGIN
    IF current_setting('kozmok.purga', true) = 'si' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.estado = 'pendiente' AND NEW.estado IN ('aplicado', 'cancelado')
       AND NEW.monedero_id = OLD.monedero_id AND NEW.tipo = OLD.tipo AND NEW.monto = OLD.monto THEN
        NEW.fecha := CASE WHEN NEW.estado = 'aplicado' THEN CURRENT_TIMESTAMP ELSE OLD.fecha END;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Los movimientos del monedero no se pueden modificar ni borrar. Para corregir, registra un ajuste.'
        USING ERRCODE = 'P0001', HINT = 'control_interno';
END $$ LANGUAGE plpgsql;

-- Pedidos: montos, folio y fecha fijos; entregado y cancelado son finales.
CREATE OR REPLACE FUNCTION kz_pedidos_cambios() RETURNS trigger AS $$
BEGIN
    IF current_setting('kozmok.purga', true) = 'si' THEN RETURN NEW; END IF;
    IF NEW.numero_orden IS DISTINCT FROM OLD.numero_orden OR NEW.fecha_pedido IS DISTINCT FROM OLD.fecha_pedido
       OR NEW.subtotal <> OLD.subtotal OR NEW.impuestos <> OLD.impuestos OR NEW.envio <> OLD.envio
       OR NEW.descuento <> OLD.descuento OR NEW.descuento_promocion <> OLD.descuento_promocion
       OR NEW.total <> OLD.total OR NEW.origen IS DISTINCT FROM OLD.origen THEN
        RAISE EXCEPTION 'El folio, la fecha y los montos de un pedido no se pueden cambiar después de creado'
            USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF OLD.estado IN ('entregado', 'cancelado') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        RAISE EXCEPTION 'Un pedido % ya no puede cambiar de estado', OLD.estado
            USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF OLD.pago_estado = 'pagado' AND NEW.pago_estado = 'pendiente' THEN
        RAISE EXCEPTION 'Un pago registrado no se puede deshacer; si fue un error, cancela el pedido'
            USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    NEW.fecha_actualizacion := CURRENT_TIMESTAMP;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION kz_pedidos_fecha() RETURNS trigger AS $$
BEGIN
    NEW.fecha_pedido := CURRENT_TIMESTAMP;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------- Columnas nuevas para las bajas con aprobación ----------
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS estado VARCHAR(10) NOT NULL DEFAULT 'aplicado';
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS motivo_tipo VARCHAR(30);
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS aprobado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS resuelto_fecha TIMESTAMP;
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS nota_resolucion TEXT;
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS valor NUMERIC(12,2);
DO $$ BEGIN
    ALTER TABLE movimientos_inventario ADD CONSTRAINT movinv_estado_check CHECK (estado IN ('aplicado','pendiente','rechazado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_movinv_estado ON movimientos_inventario (estado) WHERE estado = 'pendiente';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago_comprobante VARCHAR(60);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago_registrado_por INTEGER REFERENCES usuarios(id);

-- ---------- Disparadores ----------
DROP TRIGGER IF EXISTS trg_movinv_fecha ON movimientos_inventario;
CREATE TRIGGER trg_movinv_fecha BEFORE INSERT ON movimientos_inventario FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_movinv_cambios ON movimientos_inventario;
CREATE TRIGGER trg_movinv_cambios BEFORE UPDATE OR DELETE ON movimientos_inventario FOR EACH ROW EXECUTE FUNCTION kz_movinv_cambios();

DROP TRIGGER IF EXISTS trg_movpts_fecha ON movimientos_puntos;
CREATE TRIGGER trg_movpts_fecha BEFORE INSERT ON movimientos_puntos FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_movpts_cambios ON movimientos_puntos;
CREATE TRIGGER trg_movpts_cambios BEFORE UPDATE OR DELETE ON movimientos_puntos FOR EACH ROW EXECUTE FUNCTION kz_solo_agregar();

DROP TRIGGER IF EXISTS trg_movmon_fecha ON movimientos_monedero;
CREATE TRIGGER trg_movmon_fecha BEFORE INSERT ON movimientos_monedero FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_movmon_cambios ON movimientos_monedero;
CREATE TRIGGER trg_movmon_cambios BEFORE UPDATE OR DELETE ON movimientos_monedero FOR EACH ROW EXECUTE FUNCTION kz_movmon_cambios();

DROP TRIGGER IF EXISTS trg_procesos_fecha ON procesos_erp;
CREATE TRIGGER trg_procesos_fecha BEFORE INSERT ON procesos_erp FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_procesos_cambios ON procesos_erp;
CREATE TRIGGER trg_procesos_cambios BEFORE UPDATE OR DELETE ON procesos_erp FOR EACH ROW EXECUTE FUNCTION kz_solo_agregar();

DROP TRIGGER IF EXISTS trg_pedidos_fecha ON pedidos;
CREATE TRIGGER trg_pedidos_fecha BEFORE INSERT ON pedidos FOR EACH ROW EXECUTE FUNCTION kz_pedidos_fecha();
DROP TRIGGER IF EXISTS trg_pedidos_cambios ON pedidos;
CREATE TRIGGER trg_pedidos_cambios BEFORE UPDATE ON pedidos FOR EACH ROW EXECUTE FUNCTION kz_pedidos_cambios();
DROP TRIGGER IF EXISTS trg_items_cambios ON pedido_items;
CREATE TRIGGER trg_items_cambios BEFORE UPDATE OR DELETE ON pedido_items FOR EACH ROW EXECUTE FUNCTION kz_solo_agregar();

-- ---------- Monedero electrónico endurecido ----------
-- activo    = se usa normal
-- congelado = temporal mientras se revisa algo (no recarga ni paga; el
--             saldo se conserva y se puede ver)
-- bloqueado = por fraude comprobado, contracargo u orden de autoridad
ALTER TABLE monederos DROP CONSTRAINT IF EXISTS monederos_estado_check;
ALTER TABLE monederos ADD CONSTRAINT monederos_estado_check CHECK (estado IN ('activo','congelado','bloqueado'));
ALTER TABLE monederos ADD COLUMN IF NOT EXISTS motivo_estado VARCHAR(40);
ALTER TABLE monederos ADD COLUMN IF NOT EXISTS detalle_estado TEXT;
ALTER TABLE monederos ADD COLUMN IF NOT EXISTS fecha_estado TIMESTAMP;
-- Quién aprobó un ajuste o confirmó una recarga (usuario_id = quien la pidió)
ALTER TABLE movimientos_monedero ADD COLUMN IF NOT EXISTS aprobado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE movimientos_monedero ADD COLUMN IF NOT EXISTS comprobante VARCHAR(60);
CREATE UNIQUE INDEX IF NOT EXISTS uq_movmon_comprobante ON movimientos_monedero (comprobante) WHERE comprobante IS NOT NULL;

-- =========================================================
-- RENDIMIENTO: índices para las consultas que más se repiten
-- (historial del cliente, reportes por fecha, tareas cada minuto).
-- Sin ellos PostgreSQL recorre la tabla completa en cada consulta.
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_fecha ON pedidos (cliente_id, fecha_pedido DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_fecha         ON pedidos (fecha_pedido DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado        ON pedidos (estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_por_avisar    ON pedidos (id) WHERE estado IS DISTINCT FROM estado_notificado;
CREATE INDEX IF NOT EXISTS idx_pedidos_pago_vence    ON pedidos (pago_vence) WHERE estado = 'pendiente' AND pago_estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido   ON pedido_items (pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_items_producto ON pedido_items (producto_id);
CREATE INDEX IF NOT EXISTS idx_movinv_producto_fecha ON movimientos_inventario (producto_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_movinv_pendientes     ON movimientos_inventario (fecha) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_movmon_pendientes     ON movimientos_monedero (fecha) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_correos_por_enviar    ON correos_salida (id) WHERE estado IN ('pendiente', 'error');
CREATE INDEX IF NOT EXISTS idx_favoritos_producto    ON favoritos (producto_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_entidad     ON auditoria (entidad, entidad_id);
CREATE INDEX IF NOT EXISTS idx_productos_activos     ON productos (nombre) WHERE activo = TRUE;
ANALYZE;

-- =========================================================
-- FECHA DEL MOVIMIENTO vs. FECHA DE REGISTRO (inventario)
--   fecha             = cuándo se capturó, la pone el servidor; nunca cambia.
--   fecha_movimiento  = cuándo dice el empleado que pasó (se puede escribir
--                       al registrar y corregir después, con motivo).
--   movimientos_inventario_fechas = historial de cada corrección:
--                       fecha anterior, nueva, quién, por qué y la hora real.
--   Así se puede registrar una merma de ayer, pero siempre se ve que se
--   capturó hoy y quién movió la fecha.
-- =========================================================
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS fecha_movimiento TIMESTAMP;
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS fecha_cambiada_por INTEGER REFERENCES usuarios(id);
ALTER TABLE movimientos_inventario ADD COLUMN IF NOT EXISTS fecha_cambiada_en TIMESTAMP;

CREATE TABLE IF NOT EXISTS movimientos_inventario_fechas (
    id              SERIAL PRIMARY KEY,
    movimiento_id   INTEGER NOT NULL REFERENCES movimientos_inventario(id) ON DELETE CASCADE,
    fecha_anterior  TIMESTAMP NOT NULL,
    fecha_nueva     TIMESTAMP NOT NULL,
    usuario_id      INTEGER REFERENCES usuarios(id),
    motivo          TEXT NOT NULL,
    fecha           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP   -- hora real del cambio
);
CREATE INDEX IF NOT EXISTS idx_movinv_fechas_mov ON movimientos_inventario_fechas (movimiento_id);
DROP TRIGGER IF EXISTS trg_movinvf_fecha ON movimientos_inventario_fechas;
CREATE TRIGGER trg_movinvf_fecha BEFORE INSERT ON movimientos_inventario_fechas FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_movinvf_cambios ON movimientos_inventario_fechas;
CREATE TRIGGER trg_movinvf_cambios BEFORE UPDATE OR DELETE ON movimientos_inventario_fechas FOR EACH ROW EXECUTE FUNCTION kz_solo_agregar();

-- Al insertar: fecha de registro del servidor; fecha del movimiento la que
-- se indicó (o la misma), nunca en el futuro.
CREATE OR REPLACE FUNCTION kz_movinv_insert() RETURNS trigger AS $$
BEGIN
    NEW.fecha := CURRENT_TIMESTAMP;
    NEW.fecha_movimiento := COALESCE(NEW.fecha_movimiento, NEW.fecha);
    NEW.fecha_cambiada_por := NULL;
    NEW.fecha_cambiada_en := NULL;
    IF NEW.fecha_movimiento > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'La fecha del movimiento no puede ser futura.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_movinv_fecha ON movimientos_inventario;
CREATE TRIGGER trg_movinv_fecha BEFORE INSERT ON movimientos_inventario FOR EACH ROW EXECUTE FUNCTION kz_movinv_insert();

-- Cambios permitidos: (1) resolver una baja pendiente; (2) corregir la
-- fecha del movimiento con motivo (kozmok.motivo_fecha) y autor. Todo lo
-- demás, incluida la fecha de registro, es inmutable.
CREATE OR REPLACE FUNCTION kz_movinv_cambios() RETURNS trigger AS $$
DECLARE motivo_f TEXT;
BEGIN
    IF current_setting('kozmok.purga', true) = 'si' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE'
       AND (NEW.producto_id, NEW.tipo, NEW.cantidad, NEW.motivo, NEW.usuario_id, NEW.fecha, NEW.motivo_tipo, NEW.valor)
           IS NOT DISTINCT FROM (OLD.producto_id, OLD.tipo, OLD.cantidad, OLD.motivo, OLD.usuario_id, OLD.fecha, OLD.motivo_tipo, OLD.valor) THEN
        -- (1) Resolver una baja pendiente
        IF OLD.estado = 'pendiente' AND NEW.estado IN ('aplicado', 'rechazado')
           AND (NEW.fecha_movimiento, NEW.fecha_cambiada_por, NEW.fecha_cambiada_en)
               IS NOT DISTINCT FROM (OLD.fecha_movimiento, OLD.fecha_cambiada_por, OLD.fecha_cambiada_en) THEN
            NEW.resuelto_fecha := CURRENT_TIMESTAMP;
            RETURN NEW;
        END IF;
        -- (2) Corregir la fecha del movimiento
        IF NEW.estado IS NOT DISTINCT FROM OLD.estado
           AND (NEW.aprobado_por, NEW.resuelto_fecha, NEW.nota_resolucion) IS NOT DISTINCT FROM (OLD.aprobado_por, OLD.resuelto_fecha, OLD.nota_resolucion)
           AND NEW.fecha_movimiento IS DISTINCT FROM OLD.fecha_movimiento THEN
            motivo_f := NULLIF(trim(current_setting('kozmok.motivo_fecha', true)), '');
            IF NEW.fecha_cambiada_por IS NULL OR motivo_f IS NULL OR length(motivo_f) < 10 THEN
                RAISE EXCEPTION 'Para corregir la fecha de un movimiento se necesita quién lo hace y el motivo (al menos 10 caracteres).'
                    USING ERRCODE = 'P0001', HINT = 'control_interno';
            END IF;
            IF NEW.fecha_movimiento IS NULL OR NEW.fecha_movimiento > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
                RAISE EXCEPTION 'La fecha del movimiento no puede ser futura.' USING ERRCODE = 'P0001', HINT = 'control_interno';
            END IF;
            NEW.fecha_cambiada_en := CURRENT_TIMESTAMP;
            INSERT INTO movimientos_inventario_fechas (movimiento_id, fecha_anterior, fecha_nueva, usuario_id, motivo)
            VALUES (OLD.id, COALESCE(OLD.fecha_movimiento, OLD.fecha), NEW.fecha_movimiento, NEW.fecha_cambiada_por, motivo_f);
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'Los movimientos de inventario no se pueden modificar ni borrar (solo corregir su fecha con motivo). Si hubo un error, registra un movimiento contrario.'
        USING ERRCODE = 'P0001', HINT = 'control_interno';
END $$ LANGUAGE plpgsql;

-- =========================================================
-- INTERACCIONES CRM REALES
--   origen: equipo (la registró una persona del panel), chatbot (el cliente
--   usó el asesor en línea), cliente (abrió un ticket), sistema.
--   Fecha del servidor y solo agregar: una interacción no se edita ni se
--   borra (se borran con el cliente, por la purga del CRM).
--   Se quitan las 4 interacciones de ejemplo que traía el script inicial.
-- =========================================================
ALTER TABLE interacciones ADD COLUMN IF NOT EXISTS origen VARCHAR(20);
DO $$ BEGIN
    PERFORM set_config('kozmok.purga', 'si', true);
    DELETE FROM interacciones WHERE descripcion IN (
        'Se discutieron opciones de laptop para edición de video.',
        'Envío de cotización PC Workstation Diseño.',
        'Consultó por el chatbot una laptop gamer con presupuesto de $28,000.',
        'Reunión inicial para conocer necesidades de cómputo de la agencia.');
    UPDATE interacciones SET origen = CASE
        WHEN usuario_id IS NOT NULL THEN 'equipo'
        WHEN tipo = 'chat' THEN 'chatbot'
        WHEN tipo = 'soporte' THEN 'cliente'
        ELSE 'sistema' END
    WHERE origen IS NULL;
    PERFORM set_config('kozmok.purga', 'no', true);
END $$;
ALTER TABLE interacciones ALTER COLUMN origen SET DEFAULT 'sistema';
ALTER TABLE interacciones DROP CONSTRAINT IF EXISTS interacciones_origen_check;
ALTER TABLE interacciones ADD CONSTRAINT interacciones_origen_check CHECK (origen IN ('equipo','chatbot','cliente','sistema'));
DROP TRIGGER IF EXISTS trg_interacciones_fecha ON interacciones;
CREATE TRIGGER trg_interacciones_fecha BEFORE INSERT ON interacciones FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_interacciones_cambios ON interacciones;
CREATE TRIGGER trg_interacciones_cambios BEFORE UPDATE OR DELETE ON interacciones FOR EACH ROW EXECUTE FUNCTION kz_solo_agregar();
CREATE INDEX IF NOT EXISTS idx_interacciones_fecha ON interacciones (fecha DESC);

-- Contraseña conocida por otra persona (la inicial del admin o la que puso
-- quien dio de alta la cuenta): el panel pide cambiarla al entrar.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cambiar_password BOOLEAN NOT NULL DEFAULT FALSE;

-- =========================================================
-- PAGOS CON PAYPAL (sandbox = sin dinero real)
--   Una fila por orden creada en PayPal. El cobro se confirma solo cuando
--   PayPal responde COMPLETED con el mismo monto y la misma referencia; la
--   orden y el cobro (capture) no se repiten. No se edita salvo el estado:
--   creada -> capturada | fallida | vencida, capturada -> reembolsada.
-- =========================================================
CREATE TABLE IF NOT EXISTS pagos_paypal (
    id              SERIAL PRIMARY KEY,
    orden_id        VARCHAR(40) NOT NULL UNIQUE,
    captura_id      VARCHAR(40) UNIQUE,
    reembolso_id    VARCHAR(40),
    tipo            VARCHAR(10) NOT NULL CHECK (tipo IN ('pedido','recarga')),
    cliente_id      INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
    pedido_id       INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
    monto           NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    moneda          VARCHAR(3) NOT NULL DEFAULT 'MXN',
    modo            VARCHAR(8) NOT NULL DEFAULT 'sandbox',
    estado          VARCHAR(12) NOT NULL DEFAULT 'creada' CHECK (estado IN ('creada','capturada','pendiente','fallida','vencida','reembolsada')),
    pagador_correo  VARCHAR(150),
    detalle         JSONB,
    fecha           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_captura   TIMESTAMP,
    fecha_reembolso TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pagos_paypal_pedido ON pagos_paypal (pedido_id);
CREATE INDEX IF NOT EXISTS idx_pagos_paypal_cliente ON pagos_paypal (cliente_id, fecha DESC);

CREATE OR REPLACE FUNCTION kz_paypal_cambios() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('kozmok.purga', true) = 'si' THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'Los pagos de PayPal no se borran.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF current_setting('kozmok.purga', true) = 'si' THEN RETURN NEW; END IF;   -- SET NULL al borrar cliente/pedido de ejemplo
    IF (NEW.orden_id, NEW.tipo, NEW.monto, NEW.moneda, NEW.modo, NEW.fecha) IS DISTINCT FROM (OLD.orden_id, OLD.tipo, OLD.monto, OLD.moneda, OLD.modo, OLD.fecha)
       OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id OR NEW.pedido_id IS DISTINCT FROM OLD.pedido_id
       OR (OLD.captura_id IS NOT NULL AND NEW.captura_id IS DISTINCT FROM OLD.captura_id) THEN
        RAISE EXCEPTION 'Los datos de un pago de PayPal no se pueden cambiar.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF OLD.estado IN ('fallida','vencida','reembolsada') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        RAISE EXCEPTION 'Ese pago de PayPal ya está cerrado.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF OLD.estado = 'capturada' AND NEW.estado NOT IN ('capturada','reembolsada') THEN
        RAISE EXCEPTION 'Un pago cobrado solo puede reembolsarse.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF NEW.estado = 'capturada' AND OLD.estado <> 'capturada' THEN NEW.fecha_captura := CURRENT_TIMESTAMP; END IF;
    IF NEW.estado = 'reembolsada' AND OLD.estado <> 'reembolsada' THEN NEW.fecha_reembolso := CURRENT_TIMESTAMP; END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_paypal_fecha ON pagos_paypal;
CREATE TRIGGER trg_paypal_fecha BEFORE INSERT ON pagos_paypal FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_paypal_cambios ON pagos_paypal;
CREATE TRIGGER trg_paypal_cambios BEFORE UPDATE OR DELETE ON pagos_paypal FOR EACH ROW EXECUTE FUNCTION kz_paypal_cambios();

-- =========================================================
-- FACTURA ELECTRÓNICA (CFDI 4.0, timbrado con Facturama)
--   datos_fiscales: lo que el cliente guarda para facturar (uno por cliente).
--   productos.clave_sat: clave del catálogo c_ClaveProdServ (si está vacía se
--     deduce de la categoría al facturar).
--   facturas: un CFDI vigente por pedido. No se borra ni cambia su contenido;
--     solo pasa de timbrada a cancelada (o en cancelación).
-- =========================================================
CREATE TABLE IF NOT EXISTS datos_fiscales (
    cliente_id      INTEGER PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
    rfc             VARCHAR(13) NOT NULL,
    razon_social    VARCHAR(254) NOT NULL,
    regimen_fiscal  VARCHAR(3) NOT NULL,
    codigo_postal   VARCHAR(5) NOT NULL,
    uso_cfdi        VARCHAR(4) NOT NULL DEFAULT 'G03',
    actualizado     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS clave_sat VARCHAR(8);

CREATE TABLE IF NOT EXISTS facturas (
    id                 SERIAL PRIMARY KEY,
    pedido_id          INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE RESTRICT,
    cliente_id         INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
    facturama_id       VARCHAR(60) NOT NULL UNIQUE,
    uuid               VARCHAR(40) UNIQUE,
    serie              VARCHAR(25),
    folio              VARCHAR(40),
    rfc                VARCHAR(13) NOT NULL,
    razon_social       VARCHAR(254) NOT NULL,
    regimen_fiscal     VARCHAR(3) NOT NULL,
    codigo_postal      VARCHAR(5) NOT NULL,
    uso_cfdi           VARCHAR(4) NOT NULL,
    forma_pago         VARCHAR(2) NOT NULL,
    total              NUMERIC(12,2) NOT NULL,
    modo               VARCHAR(8) NOT NULL DEFAULT 'sandbox',
    estado             VARCHAR(16) NOT NULL DEFAULT 'timbrada' CHECK (estado IN ('timbrada','cancelando','cancelada')),
    motivo_cancelacion VARCHAR(2),
    solicitada_por     VARCHAR(10) NOT NULL DEFAULT 'cliente' CHECK (solicitada_por IN ('cliente','equipo')),
    usuario_id         INTEGER REFERENCES usuarios(id),
    fecha              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_cancelacion  TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_facturas_pedido ON facturas (pedido_id);
-- Solo una factura vigente (timbrada o en cancelación) por pedido
CREATE UNIQUE INDEX IF NOT EXISTS uq_factura_vigente ON facturas (pedido_id) WHERE estado <> 'cancelada';

CREATE OR REPLACE FUNCTION kz_facturas_cambios() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Las facturas no se borran; se cancelan ante el SAT.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF current_setting('kozmok.purga', true) = 'si' AND NEW.cliente_id IS NULL AND OLD.cliente_id IS NOT NULL THEN RETURN NEW; END IF;
    IF (NEW.pedido_id, NEW.facturama_id, NEW.uuid, NEW.serie, NEW.folio, NEW.rfc, NEW.razon_social, NEW.regimen_fiscal, NEW.codigo_postal,
        NEW.uso_cfdi, NEW.forma_pago, NEW.total, NEW.modo, NEW.fecha, NEW.cliente_id, NEW.solicitada_por, NEW.usuario_id)
       IS DISTINCT FROM
       (OLD.pedido_id, OLD.facturama_id, OLD.uuid, OLD.serie, OLD.folio, OLD.rfc, OLD.razon_social, OLD.regimen_fiscal, OLD.codigo_postal,
        OLD.uso_cfdi, OLD.forma_pago, OLD.total, OLD.modo, OLD.fecha, OLD.cliente_id, OLD.solicitada_por, OLD.usuario_id) THEN
        RAISE EXCEPTION 'Los datos de una factura timbrada no se pueden cambiar; cancélala y emite otra.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF OLD.estado = 'cancelada' AND NEW.estado <> 'cancelada' THEN
        RAISE EXCEPTION 'Una factura cancelada no se puede reactivar.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF NEW.estado = 'cancelada' AND OLD.estado <> 'cancelada' THEN NEW.fecha_cancelacion := CURRENT_TIMESTAMP; END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_facturas_fecha ON facturas;
CREATE TRIGGER trg_facturas_fecha BEFORE INSERT ON facturas FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_facturas_cambios ON facturas;
CREATE TRIGGER trg_facturas_cambios BEFORE UPDATE OR DELETE ON facturas FOR EACH ROW EXECUTE FUNCTION kz_facturas_cambios();

-- =========================================================
-- DEVOLUCIONES (solicitud del cliente desde el detalle del pedido)
--   solicitada -> aprobada | rechazada | cancelada (por el cliente)
--   aprobada   -> recibida | cancelada
--   recibida   -> reembolsada | cambiada
--   El monto se calcula en el servidor al solicitar y no cambia. Las
--   partidas no se editan. Fechas del servidor; nada se borra.
-- =========================================================
CREATE SEQUENCE IF NOT EXISTS folio_devolucion_seq START 1;
CREATE TABLE IF NOT EXISTS devoluciones (
    id               SERIAL PRIMARY KEY,
    folio            VARCHAR(20) NOT NULL UNIQUE,
    pedido_id        INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE RESTRICT,
    cliente_id       INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
    estado           VARCHAR(12) NOT NULL DEFAULT 'solicitada'
                     CHECK (estado IN ('solicitada','aprobada','rechazada','recibida','reembolsada','cambiada','cancelada')),
    motivo           VARCHAR(20) NOT NULL CHECK (motivo IN ('defectuoso','danado_envio','equivocado','no_satisface','otro')),
    descripcion      TEXT NOT NULL,
    resolucion       VARCHAR(10) NOT NULL CHECK (resolucion IN ('reembolso','cambio')),
    reembolso_via    VARCHAR(15) CHECK (reembolso_via IN ('paypal','monedero','transferencia')),
    monto            NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
    incluye_envio    BOOLEAN NOT NULL DEFAULT FALSE,
    reembolso_ref    VARCHAR(80),
    nota_equipo      TEXT,
    revisado_por     INTEGER REFERENCES usuarios(id),
    cerrado_por      INTEGER REFERENCES usuarios(id),
    fecha            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_revision   TIMESTAMP,
    fecha_recibida   TIMESTAMP,
    fecha_cierre     TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_devoluciones_pedido ON devoluciones (pedido_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_estado ON devoluciones (estado, fecha DESC);
CREATE TABLE IF NOT EXISTS devolucion_items (
    id              SERIAL PRIMARY KEY,
    devolucion_id   INTEGER NOT NULL REFERENCES devoluciones(id) ON DELETE CASCADE,
    pedido_item_id  INTEGER NOT NULL REFERENCES pedido_items(id),
    producto_id     INTEGER REFERENCES productos(id),
    cantidad        INTEGER NOT NULL CHECK (cantidad > 0),
    monto           NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
    reingresa       BOOLEAN            -- al recibir: true = vuelve a venta, false = dañado
);
CREATE INDEX IF NOT EXISTS idx_devolucion_items_dev ON devolucion_items (devolucion_id);

CREATE OR REPLACE FUNCTION kz_devoluciones_cambios() RETURNS trigger AS $$
DECLARE ok BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Las devoluciones no se borran.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF current_setting('kozmok.purga', true) = 'si' AND NEW.cliente_id IS NULL AND OLD.cliente_id IS NOT NULL THEN RETURN NEW; END IF;
    IF (NEW.folio, NEW.pedido_id, NEW.cliente_id, NEW.motivo, NEW.descripcion, NEW.resolucion, NEW.monto, NEW.incluye_envio, NEW.fecha)
       IS DISTINCT FROM (OLD.folio, OLD.pedido_id, OLD.cliente_id, OLD.motivo, OLD.descripcion, OLD.resolucion, OLD.monto, OLD.incluye_envio, OLD.fecha) THEN
        RAISE EXCEPTION 'Los datos de una devolución no se pueden cambiar.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF NEW.estado IS DISTINCT FROM OLD.estado THEN
        ok := (OLD.estado = 'solicitada' AND NEW.estado IN ('aprobada','rechazada','cancelada'))
           OR (OLD.estado = 'aprobada'   AND NEW.estado IN ('recibida','cancelada'))
           OR (OLD.estado = 'recibida'   AND NEW.estado IN ('reembolsada','cambiada'));
        IF NOT ok THEN
            RAISE EXCEPTION 'Una devolución no puede pasar de "%" a "%".', OLD.estado, NEW.estado USING ERRCODE = 'P0001', HINT = 'control_interno';
        END IF;
        IF NEW.estado IN ('aprobada','rechazada') THEN NEW.fecha_revision := CURRENT_TIMESTAMP; END IF;
        IF NEW.estado = 'recibida' THEN NEW.fecha_recibida := CURRENT_TIMESTAMP; END IF;
        IF NEW.estado IN ('reembolsada','cambiada','cancelada','rechazada') THEN NEW.fecha_cierre := CURRENT_TIMESTAMP; END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_devoluciones_fecha ON devoluciones;
CREATE TRIGGER trg_devoluciones_fecha BEFORE INSERT ON devoluciones FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_devoluciones_cambios ON devoluciones;
CREATE TRIGGER trg_devoluciones_cambios BEFORE UPDATE OR DELETE ON devoluciones FOR EACH ROW EXECUTE FUNCTION kz_devoluciones_cambios();

-- Partidas: solo se puede anotar si la pieza vuelve a venta (una vez)
CREATE OR REPLACE FUNCTION kz_devitems_cambios() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Las partidas de una devolución no se borran.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    IF (NEW.devolucion_id, NEW.pedido_item_id, NEW.producto_id, NEW.cantidad, NEW.monto) IS DISTINCT FROM
       (OLD.devolucion_id, OLD.pedido_item_id, OLD.producto_id, OLD.cantidad, OLD.monto)
       OR (OLD.reingresa IS NOT NULL AND NEW.reingresa IS DISTINCT FROM OLD.reingresa) THEN
        RAISE EXCEPTION 'Las partidas de una devolución no se pueden cambiar.' USING ERRCODE = 'P0001', HINT = 'control_interno';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_devitems_cambios ON devolucion_items;
CREATE TRIGGER trg_devitems_cambios BEFORE UPDATE OR DELETE ON devolucion_items FOR EACH ROW EXECUTE FUNCTION kz_devitems_cambios();

-- =========================================================
-- Cuentas de Ventas y Logística (una sola vez por base).
-- Bases nuevas ya las traen de database.sql. En bases que venían de la
-- versión sin ellas (o donde limpiar:ejemplo las desactivó) se crean o
-- se reactivan UNA vez, con cambio de contraseña obligatorio. La marca en
-- auditoría evita que se repita: si después el admin las desactiva, se
-- quedan desactivadas.
-- =========================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auditoria WHERE accion = 'alta_cuentas_ventas_logistica') THEN
        INSERT INTO usuarios (nombre, email, password_hash, rol, activo, cambiar_password) VALUES
            ('Laura Méndez', 'laura.ventas@kozmok.mx', crypt('Ventas#KZ2026', gen_salt('bf', 10)), 'ventas', TRUE, TRUE),
            ('Paola Nieto', 'paola.logistica@kozmok.mx', crypt('Logistica#KZ2026', gen_salt('bf', 10)), 'logistica', TRUE, TRUE)
        ON CONFLICT (email) DO NOTHING;
        UPDATE usuarios SET activo = TRUE, cambiar_password = TRUE
         WHERE email IN ('laura.ventas@kozmok.mx', 'paola.logistica@kozmok.mx') AND activo = FALSE;
        INSERT INTO auditoria (usuario_nombre, rol, accion, entidad, motivo)
        VALUES ('Sistema', 'sistema', 'alta_cuentas_ventas_logistica', 'usuarios',
                'Cuentas base de Ventas y Logística');
    END IF;
END $$;

-- Cuenta de Soporte (una sola vez por base), igual que las de arriba: en
-- bases anteriores al rol Soporte se crea con cambio de contraseña
-- obligatorio. Si después el admin la desactiva, se queda desactivada.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auditoria WHERE accion = 'alta_cuenta_soporte') THEN
        INSERT INTO usuarios (nombre, email, password_hash, rol, activo, cambiar_password) VALUES
            ('Sofía Ramírez', 'sofia.soporte@kozmok.mx', crypt('Soporte#KZ2026', gen_salt('bf', 10)), 'soporte', TRUE, TRUE)
        ON CONFLICT (email) DO NOTHING;
        INSERT INTO auditoria (usuario_nombre, rol, accion, entidad, motivo)
        VALUES ('Sistema', 'sistema', 'alta_cuenta_soporte', 'usuarios', 'Cuenta base de Soporte');
    END IF;
END $$;
