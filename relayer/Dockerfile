FROM node:22-slim
WORKDIR /app
# The relayer imports shared/ticket.mjs and reads the deployment JSONs, so the build context is
# the repo root (see fly.toml / the deploy command in README).
COPY relayer/package.json relayer/package-lock.json* ./relayer/
RUN cd relayer && npm install --omit=dev --no-audit --no-fund
# shared/ has its OWN manifest (viem + the noble packages) and sits OUTSIDE relayer/node_modules,
# so Node resolving `viem` from /app/shared/ticket.mjs never looks inside it. This used to work
# only by accident: with no .dockerignore, `COPY shared ./shared` dragged the HOST's
# shared/node_modules into the image. That is a host-built tree shipped to a different platform,
# and it vanished the moment node_modules was ignored. Install it properly instead.
COPY shared/package.json shared/package-lock.json* ./shared/
RUN cd shared && npm install --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY app/src/lib/live/zerog-deployment.json ./app/src/lib/live/zerog-deployment.json
COPY app/src/lib/live/ens-deployment.json ./app/src/lib/live/ens-deployment.json
COPY app/src/lib/live/spaces-deployment.json ./app/src/lib/live/spaces-deployment.json
COPY relayer ./relayer
WORKDIR /app/relayer
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
