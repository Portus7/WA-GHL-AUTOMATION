const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { pool } = require("../config/db");

const JWT_SECRET = process.env.JWT_SECRET || false;
if (!JWT_SECRET) throw new Error("JWT_SECRET no definido");


// ✅ NUEVA FUNCIÓN: CAMBIAR CONTRASEÑA
async function changePassword(req, res) {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "Faltan datos." });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
    }

    try {
        // 1. Buscar usuario
        const result = await pool.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
        const user = result.rows[0];

        if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

        // 2. Verificar contraseña actual
        const validPass = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPass) {
            return res.status(401).json({ error: "La contraseña actual es incorrecta." });
        }

        // 3. Hashear nueva contraseña
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(newPassword, salt);

        // 4. Actualizar DB
        await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, userId]);

        res.json({ success: true, message: "Contraseña actualizada correctamente." });

    } catch (e) {
        console.error("Error cambiando password:", e);
        res.status(500).json({ error: "Error interno del servidor." });
    }
}

// 1. Login
async function login(req, res) {
    const { email, password } = req.body;
    try {
        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        const user = result.rows[0];

        if (!user) return res.status(400).json({ error: "Usuario no encontrado" });

        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(400).json({ error: "Contraseña incorrecta" });

        // Incluimos agencyId en el token
        const tokenPayload = {
            id: user.id,
            role: user.role,
            email: user.email,
            agencyId: user.agency_id
        };

        const token = jwt.sign(tokenPayload, JWT_SECRET, {
            expiresIn: "24h"
        });

        // Devolvemos agencyId para el Frontend
        res.json({
            token,
            role: user.role,
            email: user.email,
            agencyId: user.agency_id
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

// 2. Middleware Verificar Token
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: "Acceso denegado. Token faltante." });

    try {
        const verified = jwt.verify(token, JWT_SECRET);
        req.user = verified;
        next();
    } catch (error) {
        res.status(403).json({ error: "Token inválido o expirado" });
    }
};

// 3. Middleware Roles
const requireRole = (role) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: "No autenticado" });

        if (req.user.role === 'admin') {
            next();
            return;
        }

        if (req.user.role !== role) {
            return res.status(403).json({ error: "Acceso denegado: Permisos insuficientes" });
        }
        next();
    };
};

module.exports = { login, verifyToken, requireRole, changePassword };