// db.config.js
// Conexión a PostgreSQL. Los valores se leen de variables de entorno o del
// archivo .env (copia .env.example como .env y pon tu contraseña). Así la
// contraseña real no queda escrita en el código que se sube a GitHub.
// Si no hay .env se usan los valores de la instalación del salón.
const { hayArchivoEnv } = require('./env.js');

module.exports = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'kozmok',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '12345678',
    // Si la base tarda en responder no se queda colgada la petición.
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    usaValoresPorDefecto: !hayArchivoEnv && !process.env.DB_PASSWORD,
};
