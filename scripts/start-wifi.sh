#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

detect_lan_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      if [ -n "$ip" ]; then
        echo "$ip"
        return 0
      fi
    done
  fi

  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
    return 0
  fi

  return 1
}

detect_local_hostname() {
  if command -v scutil >/dev/null 2>&1; then
    scutil --get LocalHostName 2>/dev/null || true
    return 0
  fi

  hostname 2>/dev/null | sed 's/\.local$//' || true
}

LAN_IP="$(detect_lan_ip || true)"
LOCAL_HOSTNAME="$(detect_local_hostname || true)"

echo "BookMyTicket Wi-Fi start"
echo "Local:   http://localhost:${PORT}"
if [ -n "$LAN_IP" ]; then
  echo "Wi-Fi:   http://${LAN_IP}:${PORT}"
  echo "Hosts entry for other laptop:"
  echo "  ${LAN_IP} bookmyticket.local"
  echo "Then open (HTTP): http://bookmyticket.local:${PORT}"
fi
if [ -n "$LOCAL_HOSTNAME" ]; then
  echo "Bonjour: http://${LOCAL_HOSTNAME}.local:${PORT}"
fi
echo "Important: use HTTP for local Wi-Fi URL (not HTTPS)."
echo

if lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use."
  echo "Server is likely already running. Open one of the URLs above."
  echo "If needed, stop old process and run again:"
  echo "  lsof -i :${PORT}"
  echo "  kill <PID>"
  exit 0
fi

echo "Starting server on HOST=${HOST}, PORT=${PORT}..."
HOST="${HOST}" PORT="${PORT}" node server/index.js
