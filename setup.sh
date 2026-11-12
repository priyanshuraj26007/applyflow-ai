#!/usr/bin/env bash
# ==========================================
# ApplyFlow AI — one-time setup (Mac / Linux)
# ==========================================
# Run in Terminal:   bash setup.sh
# Installs the backend and creates backend/.env with YOUR keys. Nothing is uploaded anywhere.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
ENV_FILE="$BACKEND/.env"

step() { printf "\n\033[36m==> %s\033[0m\n" "$1"; }
ok()   { printf "    \033[32mOK\033[0m  %s\n" "$1"; }
warn() { printf "    \033[33m!!\033[0m  %s\n" "$1"; }
open_url() { (command -v open >/dev/null && open "$1") || (command -v xdg-open >/dev/null && xdg-open "$1") || true; }

echo "ApplyFlow AI setup — takes about 3 minutes."

# 1. Node.js
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed. Opening nodejs.org — install the LTS version, then run: bash setup.sh"
  open_url "https://nodejs.org/en/download"
  exit 1
fi
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node.js $(node -v) is too old (need 20 or newer). Install the LTS version from nodejs.org."
  open_url "https://nodejs.org/en/download"
  exit 1
fi
ok "Node.js $(node -v)"

# 2. Install backend packages
step "Installing the backend (npm install)"
(cd "$BACKEND" && npm install --no-fund --no-audit)
ok "Backend installed"

# 3. .env with the tester's keys
step "Your keys (saved only on this computer, in backend/.env)"
get_current() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
GROQ_API_KEY="$(get_current GROQ_API_KEY)"
GEMINI_API_KEY="$(get_current GEMINI_API_KEY)"
GOOGLE_CLIENT_ID="$(get_current GOOGLE_CLIENT_ID)"
GOOGLE_CLIENT_SECRET="$(get_current GOOGLE_CLIENT_SECRET)"
PORT="$(get_current PORT)"; PORT="${PORT:-3000}"
[ -f "$ENV_FILE" ] && ok "Found an existing .env — press Enter at any question to keep the current value."

ask() { # ask VAR "prompt" required(yes/no)
  local var="$1" prompt="$2" required="$3" current answer hint
  current="${!var}"
  if [ -n "$current" ]; then hint=" [press Enter to keep the current one]"; elif [ "$required" = "no" ]; then hint=" [optional — press Enter to skip]"; else hint=""; fi
  while true; do
    read -r -p "    $prompt$hint: " answer
    answer="$(echo "$answer" | xargs)"
    if [ -n "$answer" ]; then printf -v "$var" '%s' "$answer"; return; fi
    if [ -n "$current" ] || [ "$required" = "no" ]; then return; fi
    warn "This one is required."
  done
}

echo ""
echo "    1) Groq key (free, the main AI): https://console.groq.com/keys -> Create API Key (starts with gsk_)"
open_url "https://console.groq.com/keys"
ask GROQ_API_KEY "Paste your Groq key" yes
if curl -fsS -m 15 -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models >/dev/null 2>&1; then
  ok "Groq key works"
else
  warn "Groq didn't accept that key (or there is no internet). You can fix it later in backend/.env."
fi

echo ""
echo "    2) Gemini key (optional backup AI): https://aistudio.google.com/apikey"
ask GEMINI_API_KEY "Paste your Gemini key" no

echo ""
echo "    3) Gmail sending: paste the Client ID and Client Secret that the person who invited you"
echo "       sent you privately (skip if you'll copy emails by hand)."
ask GOOGLE_CLIENT_ID "Gmail Client ID" no
ask GOOGLE_CLIENT_SECRET "Gmail Client Secret" no

cat > "$ENV_FILE" <<EOF
# ApplyFlow AI - created by setup.sh. Keep this file private; never share or upload it.
GROQ_API_KEY=$GROQ_API_KEY
GEMINI_API_KEY=$GEMINI_API_KEY
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
PORT=$PORT
EOF
chmod 600 "$ENV_FILE"
ok "Saved backend/.env"

step "DONE — next steps"
echo "    1. Start the backend:  bash start.sh   (keep that Terminal window open while you use LinkedIn)"
echo "    2. Chrome -> chrome://extensions -> turn on Developer mode -> Load unpacked ->"
echo "       choose the folder:  $ROOT/extension"
echo "    3. Follow TESTING.md from step 4 (upload your resume, About me, Gmail)."
