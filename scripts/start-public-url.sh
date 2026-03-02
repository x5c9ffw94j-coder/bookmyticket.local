#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed."
  echo "Install: brew install cloudflared"
  exit 1
fi

if ! lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Server is not running on port ${PORT}."
  echo "Start server first in another terminal:"
  echo "  npm run wifi"
  exit 1
fi

PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
EDGE_IP_VERSION="${CLOUDFLARED_EDGE_IP_VERSION:-4}"

echo "Creating public URL for http://localhost:${PORT} ..."
echo "Using protocol=${PROTOCOL}, edge-ip-version=${EDGE_IP_VERSION}"
echo "Keep this terminal open while sharing the URL."
cloudflared tunnel \
  --url "http://127.0.0.1:${PORT}" \
  --protocol "${PROTOCOL}" \
  --edge-ip-version "${EDGE_IP_VERSION}" \
  --no-autoupdate
