const { pool } = require("../config/db");

const initDb = async () => {
  const client = await pool.connect();
  try {
    console.log("🛠️ Inicializando Base de Datos...");

    // Tabla Tokens GHL
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_db (
        locationid VARCHAR(255) PRIMARY KEY,
        raw_token JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabla Sesiones Baileys
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

    // Tabla Routing
    await client.query(`
      CREATE TABLE IF NOT EXISTS phone_routing (
        phone VARCHAR(50) PRIMARY KEY,
        location_id VARCHAR(255) NOT NULL,
        contact_id VARCHAR(255),
        channel_number VARCHAR(50),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        messages_count INT DEFAULT 0
      );
    `);

    // Tabla Configuración Slots
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

    console.log("✅ Tablas verificadas.");
  } catch (error) {
    console.error("❌ Error DB init:", error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { initDb };