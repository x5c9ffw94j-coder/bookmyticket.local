#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
SERVER_STARTED_BY_SCRIPT="false"
SERVER_PID=""

cleanup() {
  if [ "${SERVER_STARTED_BY_SCRIPT}" = "true" ] && [ -n "${SERVER_PID}" ]; then
    if kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
      kill "${SERVER_PID}" >/dev/null 2>&1 || true
    fi
  fi
}

trap cleanup EXIT INT TERM

if lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Server already running on port ${PORT}. Reusing existing server."
else
  echo "Starting BookMyTicket server on port ${PORT}..."
  HOST="${HOST}" PORT="${PORT}" node server/index.js &
  SERVER_PID="$!"
  SERVER_STARTED_BY_SCRIPT="true"

  echo "Waiting for server health..."
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "Server did not become healthy on port ${PORT}."
    exit 1
  fi
fi

echo "Starting public tunnel..."
bash scripts/start-public-url.sh
