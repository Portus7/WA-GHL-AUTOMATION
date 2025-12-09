# Usamos Alpine (ligero) con Node 20
FROM node:20-alpine

# ✅ CORRECCIÓN 1: Usamos 'apk' en lugar de 'apt-get'
# ✅ CORRECCIÓN 2: Agregamos 'git' (obligatorio para instalar Baileys desde GitHub)
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    ca-certificates \
    tzdata

WORKDIR /app

# Copia manifests
COPY package*.json ./

# ✅ CORRECCIÓN 3: Usamos 'npm install' en lugar de 'npm ci'
# 'npm ci' suele fallar con dependencias de GitHub si el lockfile tiene hash de Windows
RUN npm install --omit=dev

# Resto del código
COPY . .

# Carpeta de sesiones (por seguridad, aunque usemos BD)
RUN mkdir -p /app/sessions && chown -R node:node /app

# Corre como usuario no root
USER node

# Variables básicas
ENV NODE_ENV=production
ENV PORT=3001

# Expón el puerto interno
EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/status').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Arranque
CMD ["node", "src/index.js"]