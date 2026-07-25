# 0G testnet inference sidecar for fly.io.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
ENV PORT=8090
EXPOSE 8090
CMD ["node", "server.mjs"]
