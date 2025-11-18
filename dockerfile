# baileys/Dockerfile
FROM node:18-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# para timezone opcional:
# RUN apk add --no-cache tzdata
# ENV TZ=America/Argentina/Buenos_Aires

ENV NODE_ENV=production
# Solo expón si realmente sirves HTTP
# ENV PORT=3000
# EXPOSE 3000

# IMPORTANTE: la carpeta de sesiones existe (para montar volumen)
RUN mkdir -p /app/sessions

CMD ["node", "src/conexion.js"]
