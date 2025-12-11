const fs = require('fs');
const path = require('path');

// Ajustamos la ruta para salir de src/services/ hacia public/media
const MEDIA_DIR = path.join(__dirname, '..', '..', 'public', 'media');

// Configuración: Archivos mayores a 24 horas serán borrados
const MAX_AGE_HOURS = 168;
const MAX_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1000;

// Intervalo de ejecución: Cada 1 hora
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function cleanOldFiles() {
    console.log('🧹 [MediaCleanup] Iniciando limpieza de archivos antiguos...');

    if (!fs.existsSync(MEDIA_DIR)) {
        console.log('⚠️ Carpeta media no existe, omitiendo limpieza.');
        return;
    }

    fs.readdir(MEDIA_DIR, (err, files) => {
        if (err) {
            console.error('❌ Error leyendo directorio media:', err);
            return;
        }

        const now = Date.now();
        let deletedCount = 0;
        let errorsCount = 0;

        files.forEach(file => {
            // Ignorar archivos ocultos o .gitkeep si los hubiera
            if (file.startsWith('.')) return;

            const filePath = path.join(MEDIA_DIR, file);

            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error(`Error obteniendo stats de ${file}`, err);
                    return;
                }

                // Si la fecha de modificación es más antigua que el límite
                if (now - stats.mtimeMs > MAX_AGE_MS) {
                    fs.unlink(filePath, (unlinkErr) => {
                        if (unlinkErr) {
                            console.error(`❌ Error borrando ${file}:`, unlinkErr);
                            errorsCount++;
                        } else {
                            deletedCount++;
                        }
                    });
                }
            });
        });

        // Nota: El log final puede salir antes de que terminen los borrados asíncronos, 
        // pero para propósitos de monitoreo básico está bien.
    });
}

function startMediaCleanup() {
    // 1. Ejecutar limpieza inicial al arrancar (con un pequeño delay para no saturar el inicio)
    setTimeout(cleanOldFiles, 10000);

    // 2. Programar intervalo periódico
    setInterval(cleanOldFiles, CHECK_INTERVAL_MS);

    console.log(`✅ Servicio de Limpieza de Media activado (Ciclo: ${MAX_AGE_HOURS}h)`);
}

module.exports = { startMediaCleanup };