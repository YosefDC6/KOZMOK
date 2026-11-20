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
