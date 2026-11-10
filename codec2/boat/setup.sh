#!/usr/bin/env bash
# Build and (re)start codec2 on its boat sandbox. Idempotent. Run from your machine:
#
#   boat push bx_… codec2
#   cat secrets.env | boat ssh bx_… -- 'bash ~/codec2/boat/setup.sh --secrets'
#   boat ssh bx_… -- 'bash ~/codec2/boat/setup.sh'
#
# --secrets reads KEY=VALUE lines (WALRUS_KEY, DROP_SECRET, DOOR_SECRET) from stdin into a mode-600
# file and does nothing else, so a secret never appears in a command line or a log.
set -euo pipefail
SECRETS=/home/user/codec2-secrets.env

if [ "${1:-}" = "--secrets" ]; then
  umask 077
  cat > "$SECRETS.tmp" && mv "$SECRETS.tmp" "$SECRETS"
  echo "secrets: $(cut -d= -f1 "$SECRETS" | tr '\n' ' ')"
  exit 0
fi

[ -s "$SECRETS" ] || { echo "no $SECRETS — run with --secrets first" >&2; exit 1; }
mkdir -p /home/user/codec2-data
sudo systemctl enable --now docker >/dev/null
cd "$(dirname "$0")/.."
sudo docker build -q -t lortnoc-codec2 .
sudo docker compose -f boat/compose.yml -p codec2 up -d
echo "up — model loads in ~10-30 s; check: curl -s localhost:8080/health (needs X-Door-Secret)"
