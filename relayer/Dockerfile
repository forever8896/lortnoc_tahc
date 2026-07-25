FROM node:22-slim
WORKDIR /app
# The relayer imports shared/ticket.mjs and reads the deployment JSONs, so the build context is
# the repo root (see fly.toml / the deploy command in README).
COPY relayer/package.json relayer/package-lock.json* ./relayer/
RUN cd relayer && npm install --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY app/src/lib/live/zerog-deployment.json ./app/src/lib/live/zerog-deployment.json
COPY app/src/lib/live/ens-deployment.json ./app/src/lib/live/ens-deployment.json
COPY relayer ./relayer
WORKDIR /app/relayer
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
