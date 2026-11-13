# Build context: raiz do repositório (ver docker-compose.yml)
FROM node:20-alpine
# better-sqlite3 precisa de compilação nativa
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package.json .
RUN npm install --omit=dev
COPY shared/ /app/shared/
COPY backend/server.js .
EXPOSE 3500
CMD ["node", "server.js"]
