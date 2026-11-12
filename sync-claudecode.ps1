# Copies the latest COMMITTED version of ApplyFlow AI into the "applyflow-ai/" folder
# of your private ClaudeCode repo (keeps full commit history via git subtree).
#
# Usage (from this folder, after `git commit` + `git push`):
#   .\sync-claudecode.ps1
#
# One-time setup (already done on the original PC):
#   git remote add claudecode https://github.com/<you>/ClaudeCode.git
$ErrorActionPreference = "Stop"

$root = (git rev-parse --show-toplevel).Trim()
$url  = (git -C $root remote get-url claudecode).Trim()
$tmp  = Join-Path $env:TEMP ("claudecode-sync-" + [guid]::NewGuid().ToString("N").Substring(0, 8))

Write-Host "Syncing ApplyFlow AI -> $url (applyflow-ai/)..."
git clone -q $url $tmp
if ($LASTEXITCODE -ne 0) { throw "Could not clone the ClaudeCode repo." }
try {
  if (Test-Path (Join-Path $tmp "applyflow-ai")) {
    git -C $tmp subtree pull -q --prefix=applyflow-ai $root main -m "Sync ApplyFlow AI"
  } else {
    git -C $tmp subtree add -q --prefix=applyflow-ai $root main
  }
  if ($LASTEXITCODE -ne 0) { throw "git subtree failed." }
  git -C $tmp push -q origin main
  if ($LASTEXITCODE -ne 0) { throw "Push to ClaudeCode failed." }
  Write-Host "Done. ClaudeCode/applyflow-ai is up to date."
} finally {
  Set-Location $root
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
