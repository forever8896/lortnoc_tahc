# The gate (gate/server.mjs) for fly.io. Build context = the REPO ROOT: the gate imports ../shared and
# reads app/src/lib/live/ens-deployment.json (ENS spaces). Deploy from the root:
#   flyctl deploy --config gate/fly.toml --dockerfile gate/Dockerfile
# node:sqlite needs a current Node (unflagged since 22.13; 24 LTS here).
FROM node:24-slim
WORKDIR /app
COPY gate/package.json gate/package-lock.json ./gate/
RUN cd gate && npm ci --omit=dev --no-audit --no-fund
COPY shared/package.json shared/package-lock.json* ./shared/
RUN cd shared && npm install --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY app/src/lib/live/ens-deployment.json ./app/src/lib/live/ens-deployment.json
COPY gate ./gate
WORKDIR /app/gate
# The database (gate key, deposits, sessions) lives on the mounted volume, never in the image.
ENV PORT=8080 GATE_DB=/data/gate.sqlite
EXPOSE 8080
CMD ["node", "server.mjs"]
