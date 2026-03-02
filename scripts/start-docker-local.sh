#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="bookmyticket:local"
PORT="${PORT:-3000}"

cd "$(dirname "$0")/.."

docker build -t "${IMAGE_NAME}" .
docker run --rm -it \
  -p "${PORT}:3000" \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e DB_PATH=/tmp/bookmyticket.db \
  "${IMAGE_NAME}"
