# ✅ Node 20 + Debian (estable para binarios nativos)
FROM node:20-bookworm-slim

# Paquetes de build por si algún módulo los requiere
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia manifests e instala prod deps de forma reproducible
COPY package*.json ./
RUN npm ci --omit=dev

# Resto del código
COPY . .

# Carpeta de sesiones para Baileys (persistida con volumen)
RUN mkdir -p /app/sessions && chown -R node:node /app

# Corre como usuario no root
USER node

# Variables básicas
ENV NODE_ENV=production
ENV PORT=3001

# Expón el puerto interno real de tu app
EXPOSE 3001

# (Opcional) healthcheck si tienes /status
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/status').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Arranque
CMD ["node", "src/index.js"]
