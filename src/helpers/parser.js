function parseGHLCommand(text) {
    if (!text || !text.startsWith('#btn')) return null;

    try {
        // Estructura: #btn|Titulo|Cuerpo|elemento1|elemento2...
        const parts = text.split('|');
        
        // Extraer cabeceras básicas
        const title = parts[1] || "";
        const body = parts[2] || "";
        const extraParts = parts.slice(3); // El resto son botones o imágenes

        let image = null;
        const buttons = [];

        extraParts.forEach(part => {
            const p = part.split('*');
            const type = p[0].trim();

            // 1. Detectar Imagen
            if (type === 'image') {
                image = p[1]; // URL de la imagen
            } 
            // 2. Detectar Quick Reply (Botón de respuesta)
            else if (type === 'quick_reply') {
                buttons.push({
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: p[1],
                        id: p[2] || `btn_${Date.now()}`
                    })
                });
            }
            // 3. Detectar CTA URL (Ir a sitio web)
            else if (type === 'cta_url') {
                buttons.push({
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: p[1],
                        url: p[2],
                        merchant_url: p[2]
                    })
                });
            }
            // 4. Detectar CTA COPY (Copiar código)
            else if (type === 'cta_copy') {
                buttons.push({
                    name: 'cta_copy',
                    buttonParamsJson: JSON.stringify({
                        display_text: p[1],
                        copy_code: p[2]
                    })
                });
            }
            // 5. Detectar CTA CALL (Llamada)
            else if (type === 'cta_call') {
                 buttons.push({
                    name: 'cta_call',
                    buttonParamsJson: JSON.stringify({
                        display_text: p[1],
                        phone_number: p[2]
                    })
                });
            }
        });

        return { title, body, image, buttons };

    } catch (e) {
        console.error("Error parseando comando:", e);
        return null;
    }
}

module.exports = { parseGHLCommand };