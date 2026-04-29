FROM node:20-alpine
# better-sqlite3 precisa de compilação nativa
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
EXPOSE 3500
CMD ["node", "server.js"]
