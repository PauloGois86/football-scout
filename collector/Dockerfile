FROM node:20-alpine

# better-sqlite3 precisa de compilação nativa
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json .
RUN npm install --production

COPY collect.js .

# Volume para persistir a base de dados
VOLUME ["/app/../data"]

# Por defeito mostra status; o cron vai chamar daily
CMD ["node", "collect.js", "--mode=status"]

# Copia também o collector alternativo
COPY collect-alt.js .
