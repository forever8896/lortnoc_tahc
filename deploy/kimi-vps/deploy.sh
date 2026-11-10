#!/usr/bin/env bash
# Rebuild and roll the relayer and/or gate on kimi-vps. Run from anywhere:  deploy/kimi-vps/deploy.sh [relayer] [gate]
set -euo pipefail
cd "$(dirname "$0")/../.."
svcs=("${@:-relayer gate}"); svcs=(${svcs[@]})
for s in "${svcs[@]}"; do docker build -q -f "$s/Dockerfile" -t "lortnoc-$s:vps" . >/dev/null; done
docker save $(printf 'lortnoc-%s:vps ' "${svcs[@]}") | gzip -1 | ssh kimi-vps 'sudo docker load' >/dev/null
scp -q deploy/kimi-vps/compose.yml kimi-vps:/tmp/lortnoc-compose.yml
scp -q deploy/kimi-vps/tunnel-config.yml kimi-vps:/tmp/lortnoc-tunnel.yml
ssh kimi-vps "sudo install -m 644 /tmp/lortnoc-compose.yml /opt/lortnoc/compose.yml && sudo install -m 644 /tmp/lortnoc-tunnel.yml /opt/lortnoc/tunnel/config.yml && cd /opt/lortnoc && sudo docker compose up -d ${svcs[*]} tunnel && sudo docker compose ps"
