// src/controllers/authController.js
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { pool } = require("../config/db");

const JWT_SECRET = process.env.JWT_SECRET || "secreto_super_seguro_cambiar_en_env";

// 1. Función de Login
async function login(req, res) {
    const { email, password } = req.body;
    try {
        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        const user = result.rows[0];

        if (!user) return res.status(400).json({ error: "Usuario no encontrado" });

        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(400).json({ error: "Contraseña incorrecta" });

        // Crear Token
        const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, JWT_SECRET, {
            expiresIn: "24h" // El token dura 1 día
        });

        res.json({ token, role: user.role, email: user.email });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

// 2. Middleware de Verificación (Reemplaza a tu adminAuth antiguo)
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    // El header viene como "Bearer eyJhbGci..."
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: "Acceso denegado. Token faltante." });

    try {
        const verified = jwt.verify(token, JWT_SECRET);
        req.user = verified; // Guardamos los datos del usuario en la petición
        next();
    } catch (error) {
        res.status(403).json({ error: "Token inválido o expirado" });
    }
};

module.exports = { login, verifyToken };