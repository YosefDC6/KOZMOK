// db.config.js
// Conexión a PostgreSQL. Los valores se leen del archivo .env (ver
// .env.example); la contraseña nunca se escribe en el código.
require('./env.js');

module.exports = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'kozmok',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
};
