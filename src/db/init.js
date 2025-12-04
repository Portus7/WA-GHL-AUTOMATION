const { pool } = require("../config/db");

const initDb = async () => {
  const client = await pool.connect();
  try {
    console.log("🛠️ Inicializando Base de Datos SaaS...");

    // 1. Tabla de PLANES (Para gestionar qué ofreces)
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE, -- 'free_trial', 'basic', 'pro'
        price DECIMAL(10, 2) DEFAULT 0,
        limits JSONB DEFAULT '{}', -- { "max_slots": 1, "monthly_msgs": 1000 }
        features JSONB DEFAULT '{}', -- { "white_label": false, "transcription": true }
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Inserción de planes por defecto (Seed)
    await client.query(`
      INSERT INTO subscription_plans (name, price, features) 
      VALUES 
      ('trial', 0, '{"white_label": false, "auto_create_contacts": true}'),
      ('pro', 49.00, '{"white_label": true, "auto_create_contacts": true}')
      ON CONFLICT (name) DO NOTHING;
    `);

    // 2. Tabla de CLIENTES (TENANTS) - El corazón de tu SaaS
    // Aquí guardamos la configuración específica de cada Location
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        location_id VARCHAR(255) PRIMARY KEY,
        plan_id INT REFERENCES subscription_plans(id),
        status VARCHAR(20) DEFAULT 'active', -- 'active', 'suspended', 'trial'
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
    `);

    // 3. Tabla Tokens GHL (auth_db)
    // Nota: Podrías fusionarla con tenants, pero mantenerla separada es más seguro/limpio
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
        slot_id INT,
        phone_number VARCHAR(50),
        priority INT DEFAULT 99,
        tags JSONB DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (location_id, slot_id)
      );
    `);

    // 7. Tabla Keywords (Tags Automáticos)
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

    console.log("✅ Base de Datos SaaS verificada y lista.");
  } catch (error) {
    console.error("❌ Error DB init:", error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { initDb };