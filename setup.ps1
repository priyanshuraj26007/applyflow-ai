# ==========================================
# ApplyFlow AI — one-time setup (Windows)
# ==========================================
# Run by double-clicking setup.bat (it calls this script).
# Installs the backend and creates backend\.env with YOUR keys. Nothing is uploaded anywhere.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"
$envFile = Join-Path $backend ".env"

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    !!  $text" -ForegroundColor Yellow }

Write-Host "ApplyFlow AI setup" -ForegroundColor White
Write-Host "This takes about 3 minutes. Keep this window open until it says DONE."

# 1. Node.js -------------------------------------------------------------
Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Warn "Node.js is not installed."
  Write-Host "    Opening nodejs.org - install the LTS version, then run setup.bat again."
  Start-Process "https://nodejs.org/en/download"
  Read-Host "Press Enter to close"
  exit 1
}
$version = (& node -v).Trim()
$major = [int]($version.TrimStart("v").Split(".")[0])
if ($major -lt 20) {
  Warn "Node.js $version is too old (need 20 or newer)."
  Start-Process "https://nodejs.org/en/download"
  Read-Host "Install the LTS version, then run setup.bat again. Press Enter to close"
  exit 1
}
Ok "Node.js $version"

# 2. Install backend packages -------------------------------------------
Step "Installing the backend (npm install)"
Push-Location $backend
try {
  & npm.cmd install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} finally { Pop-Location }
Ok "Backend installed"

# 3. .env with the tester's keys ----------------------------------------
Step "Your keys (saved only on this computer, in backend\.env)"
$values = [ordered]@{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2] }
  }
  Ok "Found an existing .env - press Enter at any question to keep the current value."
}

function Ask($name, $prompt, $required) {
  $current = $values[$name]
  $hint = if ($current) { " [press Enter to keep the current one]" } elseif (-not $required) { " [optional - press Enter to skip]" } else { "" }
  while ($true) {
    $answer = (Read-Host "    $prompt$hint").Trim()
    if ($answer) { $values[$name] = $answer; return }
    if ($current -or -not $required) { return }
    Warn "This one is required."
  }
}

Write-Host ""
Write-Host "    1) Groq key (free, the main AI). Get it at https://console.groq.com/keys -> Create API Key."
Write-Host "       It starts with gsk_ . Opening the page for you..."
Start-Process "https://console.groq.com/keys"
Ask "GROQ_API_KEY" "Paste your Groq key" $true

# Quick check that the Groq key works.
try {
  Invoke-RestMethod -Uri "https://api.groq.com/openai/v1/models" -Headers @{ Authorization = "Bearer $($values['GROQ_API_KEY'])" } -TimeoutSec 15 | Out-Null
  Ok "Groq key works"
} catch {
  Warn "Groq didn't accept that key (or there is no internet). You can fix it later in backend\.env."
}

Write-Host ""
Write-Host "    2) Gemini key (optional backup AI): https://aistudio.google.com/apikey"
Ask "GEMINI_API_KEY" "Paste your Gemini key" $false

Write-Host ""
Write-Host "    3) Gmail sending: paste the Client ID and Client Secret that the person who"
Write-Host "       invited you sent you privately (skip if you'll copy emails by hand)."
Ask "GOOGLE_CLIENT_ID" "Gmail Client ID" $false
Ask "GOOGLE_CLIENT_SECRET" "Gmail Client Secret" $false

if (-not $values["PORT"]) { $values["PORT"] = "3000" }
$lines = @("# ApplyFlow AI - created by setup.ps1. Keep this file private; never share or upload it.")
foreach ($key in $values.Keys) { $lines += "$key=$($values[$key])" }
Set-Content -Path $envFile -Value $lines -Encoding Ascii
Ok "Saved backend\.env"

# 4. Next steps ----------------------------------------------------------
Step "DONE - next steps"
Write-Host "    1. Double-click start.bat (keep its window open while you use LinkedIn)."
Write-Host "    2. Chrome -> chrome://extensions -> turn on Developer mode -> Load unpacked ->"
Write-Host "       choose the folder:  $(Join-Path $root 'extension')"
Write-Host "    3. Follow TESTING.md from step 4 (upload your resume, About me, Gmail)."
Write-Host ""
Read-Host "Press Enter to close"
