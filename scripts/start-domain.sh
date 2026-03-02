#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
DOMAIN="bookmyticket.local"

if ! grep -q "bookmyticket.local" /etc/hosts; then
  echo "Missing hosts entry for ${DOMAIN}."
  echo "Add this line to /etc/hosts: 127.0.0.1 ${DOMAIN}"
  exit 1
fi

if ! lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Starting app server on port ${PORT}..."
  nohup node server/index.js >/tmp/bookmyticket-domain.log 2>&1 &
  sleep 2
fi

if pgrep -x nginx >/dev/null 2>&1; then
  nginx -s reload >/dev/null 2>&1 || true
else
  nginx >/dev/null 2>&1 || true
fi

if curl -fsS "http://${DOMAIN}/api/health" >/dev/null 2>&1; then
  echo "BookMyTicket is live: http://${DOMAIN}"
else
  echo "Domain route not healthy yet. Check logs: /tmp/bookmyticket-domain.log"
  exit 1
fi
