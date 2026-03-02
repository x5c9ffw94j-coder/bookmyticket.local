#!/usr/bin/env bash
set -euo pipefail

if ! command -v railway >/dev/null 2>&1; then
  echo "Railway CLI not found. Installing..."
  npm install -g @railway/cli
fi

if ! railway whoami >/dev/null 2>&1; then
  echo "Railway login required."
  railway login
fi

echo "Deploying BookMyTicket to Railway..."
railway up --detach

echo "Getting public domain..."
railway domain || true

echo "Done. Open Railway dashboard to copy final permanent URL."
