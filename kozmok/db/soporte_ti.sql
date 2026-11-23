-- =========================================================
-- SOPORTE TÉCNICO TI (rol Soporte). Lo aplica el servidor al arrancar
-- (server.js -> migrarEsquema, después de control_interno.sql); se puede
-- volver a ejecutar sin problema. Una base cargada con database.sql ya
-- trae todo esto; aquí se pone al día una base de una versión anterior.
--
--   - Estados: abierto, en revisión, en proceso, esperando al usuario,
--     escalado, resuelto y cerrado.
--   - Prioridad P1 crítica, P2 alta, P3 media y P4 baja.
--   - Clasificación técnica (acceso, productos, carrito, pedidos, pagos,
--     inventario, promociones, rendimiento, notificaciones, administración,
--     seguridad, otros).
--   - Datos del reporte, metodología, registro técnico, escalamiento y
--     confirmación de quien reportó.
--   - Bitácora técnica solo-agregar, evidencias y errores del servidor.
-- =========================================================

-- Un ticket lo puede reportar un cliente o una cuenta del panel.
ALTER TABLE tickets ALTER COLUMN cliente_id DROP NOT NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reportado_por INTEGER REFERENCES usuarios(id) ON DELETE CASCADE;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_quien_reporta;
ALTER TABLE tickets ADD CONSTRAINT tickets_quien_reporta CHECK (cliente_id IS NOT NULL OR reportado_por IS NOT NULL);

-- Estados y prioridades del rol.
ALTER TABLE tickets ALTER COLUMN estado TYPE VARCHAR(20);
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_estado_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_estado_check
    CHECK (estado IN ('abierto','en_revision','en_proceso','esperando_usuario','escalado','resuelto','cerrado'));
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_prioridad_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_prioridad_check CHECK (prioridad IN ('critica','alta','media','baja'));

-- Clasificación técnica.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS clasificacion VARCHAR(20) NOT NULL DEFAULT 'otros';
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_clasificacion_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_clasificacion_check
    CHECK (clasificacion IN ('acceso','productos','carrito','pedidos','pagos','inventario',
                             'promociones','rendimiento','notificaciones','administracion','seguridad','otros'));
-- Tickets de antes: se clasifican por el tema que eligió el cliente.
UPDATE tickets SET clasificacion = CASE categoria
        WHEN 'cuenta' THEN 'acceso' WHEN 'pedido' THEN 'pedidos' WHEN 'devolucion' THEN 'pedidos'
        WHEN 'facturacion' THEN 'pagos' ELSE 'otros' END
 WHERE clasificacion = 'otros' AND categoria IN ('cuenta','pedido','devolucion','facturacion');

-- Datos del reporte.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS seccion       VARCHAR(40);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dispositivo   VARCHAR(60);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS navegador     VARCHAR(80);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS mensaje_error VARCHAR(500);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS impacto       VARCHAR(10);
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_impacto_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_impacto_check CHECK (impacto IN ('bloquea','parcial','menor'));
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS alcance       VARCHAR(10) NOT NULL DEFAULT 'uno';
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_alcance_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_alcance_check CHECK (alcance IN ('uno','varios','todos'));

-- Metodología y registro técnico.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS checklist        JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS diagnostico      TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS causa_raiz       TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS causa_confirmada BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resultado        TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS area_responsable VARCHAR(20) NOT NULL DEFAULT 'soporte';
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_area_responsable_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_area_responsable_check
    CHECK (area_responsable IN ('soporte','desarrollo','infraestructura','base_datos','seguridad','administracion','pagos'));

-- Escalamiento.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalado_area    VARCHAR(20);
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_escalado_area_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_escalado_area_check
    CHECK (escalado_area IN ('desarrollo','infraestructura','base_datos','seguridad','administracion','pagos'));
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalado_motivo  VARCHAR(30);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalado_resumen TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalado_pruebas TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalado_por     INTEGER REFERENCES usuarios(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fecha_escalado   TIMESTAMP;

-- Confirmación de quien reportó y fechas para medir tiempos.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS confirmacion       VARCHAR(10);
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_confirmacion_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_confirmacion_check CHECK (confirmacion IN ('resuelto','persiste'));
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fecha_confirmacion TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fecha_resuelto     TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fecha_cerrado      TIMESTAMP;

-- Evidencias (capturas) del reporte.
CREATE TABLE IF NOT EXISTS ticket_adjuntos (
    id          SERIAL PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    mensaje_id  INTEGER REFERENCES ticket_mensajes(id) ON DELETE CASCADE,
    nombre      VARCHAR(80),
    tipo        VARCHAR(20) NOT NULL,
    datos       TEXT NOT NULL,
    tamano      INTEGER,
    fecha       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ticket_adjuntos ON ticket_adjuntos(ticket_id);

-- Bitácora técnica interna: solo agregar (documentación y trazabilidad).
CREATE TABLE IF NOT EXISTS ticket_notas (
    id              SERIAL PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    usuario_id      INTEGER,
    usuario_nombre  VARCHAR(150),
    tipo            VARCHAR(15) NOT NULL CHECK (tipo IN ('hipotesis','confirmado','prueba','accion','evidencia','escalamiento','estado','nota')),
    texto           TEXT NOT NULL,
    fecha           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ticket_notas ON ticket_notas(ticket_id, id);
DROP TRIGGER IF EXISTS trg_ticket_notas_fecha ON ticket_notas;
CREATE TRIGGER trg_ticket_notas_fecha BEFORE INSERT ON ticket_notas FOR EACH ROW EXECUTE FUNCTION kz_fecha_servidor();
DROP TRIGGER IF EXISTS trg_ticket_notas_cambios ON ticket_notas;
CREATE TRIGGER trg_ticket_notas_cambios BEFORE UPDATE OR DELETE ON ticket_notas FOR EACH ROW EXECUTE FUNCTION kz_solo_agregar();

-- Errores del servidor por folio.
CREATE TABLE IF NOT EXISTS errores_servidor (
    id          SERIAL PRIMARY KEY,
    folio       VARCHAR(12) NOT NULL,
    metodo      VARCHAR(8),
    ruta        VARCHAR(200),
    mensaje     VARCHAR(300),
    usuario_id  INTEGER,
    cliente_id  INTEGER,
    fecha       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_errores_folio ON errores_servidor(folio);
CREATE INDEX IF NOT EXISTS idx_errores_fecha ON errores_servidor(fecha DESC);
