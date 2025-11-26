const { Pool } = require("pg");

// Usamos las mismas variables de entorno que en tu index.js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

const initDb = async () => {
  const client = await pool.connect();
  try {
    console.log("🛠️ Inicializando Base de Datos...");

    // 1. Tabla de Tokens de GoHighLevel (auth_db)
    // Nota: Creamos locationid como PK para evitar duplicados
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_db (
        locationid VARCHAR(255) PRIMARY KEY,
        raw_token JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Tabla de Sesiones de Baileys (baileys_auth)
    // Guarda las credenciales de WhatsApp
    await client.query(`
      CREATE TABLE IF NOT EXISTS baileys_auth (
        session_id VARCHAR(128) NOT NULL,
        key_id VARCHAR(128) NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, key_id)
      );
    `);
    // Índice para acelerar la carga de sesiones
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_baileys_session ON baileys_auth(session_id);
    `);

    // 3. Tabla de Enrutamiento de Mensajes (phone_routing)
    // Recuerda quién habló con quién y por qué canal
    await client.query(`
      CREATE TABLE IF NOT EXISTS phone_routing (
        phone VARCHAR(50) PRIMARY KEY,
        location_id VARCHAR(255) NOT NULL,
        contact_id VARCHAR(255),
        channel_number VARCHAR(50),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Tabla de Configuración de Slots (location_slots)
    // Maneja prioridades, tags y números conectados por agencia
    await client.query(`
      CREATE TABLE IF NOT EXISTS location_slots (
        location_id VARCHAR(255),
        slot_id INT,
        phone_number VARCHAR(50),
        priority INT DEFAULT 99,
        tags JSONB DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (location_id, slot_id)
      );
    `);

    console.log("✅ Tablas verificadas/creadas correctamente.");
  } catch (error) {
    console.error("❌ Error inicializando la DB:", error);
    throw error; // Lanzar error para detener el arranque si falla la DB
  } finally {
    client.release();
  }
};

module.exports = { initDb };