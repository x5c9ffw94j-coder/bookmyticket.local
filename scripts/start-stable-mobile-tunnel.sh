#!/usr/bin/env bash
set -euo pipefail

SUBDOMAIN="${1:-bookmyticket}"
KEY_PATH="$HOME/.ssh/serveo_bookmyticket"

if [ ! -f "$KEY_PATH" ]; then
  ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -C "bookmyticket-tunnel"
fi

echo "Starting stable tunnel for subdomain: $SUBDOMAIN"
echo "If this is your first run, register your key once at:"
ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -R "$SUBDOMAIN":80:localhost:3000 serveo.net
