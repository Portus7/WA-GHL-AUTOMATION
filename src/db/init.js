const { pool } = require("../config/db");
const bcrypt = require("bcryptjs");

const initDb = async () => {
  const client = await pool.connect();
  try {
    console.log("🛠️ Inicializando Base de Datos SaaS...");

    // 1. Tabla de PLANES
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        price DECIMAL(10, 2) DEFAULT 0,
        limits JSONB DEFAULT '{}',
        features JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Seed de planes
    await client.query(`
      INSERT INTO subscription_plans (name, price, features) 
      VALUES 
      ('trial', 0, '{"white_label": false, "auto_create_contacts": true}'),
      ('pro', 49.00, '{"white_label": true, "auto_create_contacts": true}')
      ON CONFLICT (name) DO NOTHING;
    `);

    // 2. Tabla de CLIENTES (TENANTS) - Con soporte para Agency ID
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        location_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        agency_id VARCHAR(255),
        agency_name VARCHAR(255),
        plan_id INT REFERENCES subscription_plans(id),
        status VARCHAR(20) DEFAULT 'active',
        trial_ends_at TIMESTAMP,
        subscription_ends_at TIMESTAMP,
        settings JSONB DEFAULT '{ 
            "show_source_label": true, 
            "create_unknown_contacts": true,
            "transcribe_audio": true 
        }',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tenants_agency ON tenants(agency_id);
    `);

    // 3. Tabla Tokens GHL (auth_db)
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_db (
        locationid VARCHAR(255) PRIMARY KEY REFERENCES tenants(location_id) ON DELETE CASCADE,
        raw_token JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4. Tabla Sesiones Baileys
    await client.query(`
      CREATE TABLE IF NOT EXISTS baileys_auth (
        session_id VARCHAR(128) NOT NULL,
        key_id VARCHAR(128) NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (session_id, key_id)
      );
    `);

    // 5. Tabla Routing
    await client.query(`
      CREATE TABLE IF NOT EXISTS phone_routing (
        phone VARCHAR(50) PRIMARY KEY,
        location_id VARCHAR(255) NOT NULL, 
        contact_id VARCHAR(255),
        channel_number VARCHAR(50),
        updated_at TIMESTAMP DEFAULT NOW(),
        messages_count INT DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_routing_location ON phone_routing(location_id);
    `);

    // 6. Tabla Configuración Slots
    await client.query(`
      CREATE TABLE IF NOT EXISTS location_slots (
        location_id VARCHAR(255) REFERENCES tenants(location_id) ON DELETE CASCADE,
        agency_id VARCHAR(255),
        slot_id INT,
        phone_number VARCHAR(50),
        priority INT DEFAULT 99,
        tags JSONB DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT NOW(),
        slot_name VARCHAR(100),
        PRIMARY KEY (location_id, slot_id)
      );
    `);

    // 7. Tabla Keywords
    await client.query(`
      CREATE TABLE IF NOT EXISTS keyword_tags (
        id SERIAL PRIMARY KEY,
        location_id TEXT NOT NULL, 
        keyword TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_keyword_tags_location ON keyword_tags(location_id);
    `);

    // 8. Tabla de USUARIOS (Con agency_id para jerarquía)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'admin', -- admin, agency
        agency_id VARCHAR(255),           -- ID de la Agencia (GHL Company ID)
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);


    // CREAR USUARIO ADMIN POR DEFECTO
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash("admin123", salt);

    await client.query(`
      INSERT INTO users (email, password_hash, role)
      VALUES ('admin@clicandapp.com', '${hashedPassword}', 'admin')
      ON CONFLICT (email) DO NOTHING;
    `);

    console.log("✅ Base de Datos SaaS verificada y lista.");
  } catch (error) {
    console.error("❌ Error DB init:", error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { initDb };