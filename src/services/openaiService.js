const OpenAI = require("openai");
const fs = require("fs");
require("dotenv").config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Transcribe un archivo de audio local usando Whisper-1
 * @param {string} filePath - Ruta absoluta del archivo local
 * @returns {Promise<string>} - El texto transcrito
 */
async function transcribeAudio(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            console.error("❌ Archivo de audio no encontrado para transcribir:", filePath);
            return "";
        }

        console.log(`🎙️ Transcribiendo audio: ${filePath}...`);

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-1",
            language: "es", // Forzamos español, o quítalo para detección auto
        });

        console.log("✅ Transcripción completada.");
        return transcription.text;
    } catch (error) {
        console.error("❌ Error en OpenAI Whisper:", error.message);
        return "[Error transcribiendo audio]";
    }
}

module.exports = { transcribeAudio };