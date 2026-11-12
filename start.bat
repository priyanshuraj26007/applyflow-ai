@echo off
rem ApplyFlow AI - start the backend. Keep this window open while you use LinkedIn.
title ApplyFlow AI backend
cd /d "%~dp0backend"
if not exist ".env" (
  echo backend\.env is missing. Run setup.bat first.
  pause
  exit /b 1
)
call npm.cmd start
pause
