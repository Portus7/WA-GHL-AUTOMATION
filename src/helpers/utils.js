function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^\d+]/g, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processAdvancedMessage(rawText) {
  if (!rawText) return { text: "", delay: 0 };

  let processedText = rawText;
  let delayMs = 0;

  // 1. Extraer y Calcular Delay: !/DELAY/MIN/MAX/!
  const delayRegex = /!\/DELAY\/(\d+)\/(\d+)\/!/;
  const delayMatch = processedText.match(delayRegex);

  if (delayMatch) {
    const min = parseInt(delayMatch[1], 10);
    const max = parseInt(delayMatch[2], 10);
    delayMs = Math.floor(Math.random() * (max - min + 1)) + min;
    processedText = processedText.replace(delayMatch[0], ''); // Borrar tag
  }

  // 2. Extraer Definiciones Spintax: !/SPINTAX_X/.../SPINTAX_X/!
  const definitions = {};
  const defRegex = /!\/SPINTAX_([a-zA-Z0-9_]+)\/(.*?)\/SPINTAX_\1\/!/gs;

  processedText = processedText.replace(defRegex, (match, id, content) => {
    // Separamos por '/' y limpiamos espacios
    const options = content.split('/').map(opt => opt.trim()).filter(opt => opt !== '');
    definitions[id] = options;
    return ''; // Borrar definición del texto visible
  });

  // 3. Reemplazar Placeholders: ${SPINTAX_X}
  const placeholderRegex = /\$\{SPINTAX_([a-zA-Z0-9_]+)\}/g;

  processedText = processedText.replace(placeholderRegex, (match, id) => {
    if (definitions[id] && definitions[id].length > 0) {
      const randomIndex = Math.floor(Math.random() * definitions[id].length);
      return definitions[id][randomIndex];
    }
    return match;
  });

  // Limpiar saltos de línea triples o más
  return {
    text: processedText.trim().replace(/\n{3,}/g, "\n\n"),
    delay: delayMs
  };
}

function toBold(text) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bold = "𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗";

  let result = "";
  for (let i = 0; i < text.length; i++) {
    const index = chars.indexOf(text[i]);
    result += index !== -1 ? bold[index] : text[i];
  }
  return result;
}

module.exports = { normalizePhone, processAdvancedMessage, sleep, toBold };