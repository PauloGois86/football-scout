# Build context: raiz do repositório (ver docker-compose.yml)
FROM node:20-alpine
# better-sqlite3 precisa de compilação nativa
RUN apk add --no-cache python3 make g++
WORKDIR /app/collector
COPY collector/package.json .
RUN npm install --omit=dev
COPY shared/ /app/shared/
COPY collector/*.js ./
# Por defeito mostra status; o cron chama daily / import / backtest
CMD ["node", "collect.js", "--mode=status"]
