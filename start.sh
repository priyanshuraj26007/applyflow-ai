#!/usr/bin/env bash
# ApplyFlow AI — start the backend (Mac / Linux). Keep this window open while you use LinkedIn.
cd "$(dirname "$0")/backend" || exit 1
if [ ! -f .env ]; then
  echo "backend/.env is missing. Run: bash setup.sh"
  exit 1
fi
npm start
