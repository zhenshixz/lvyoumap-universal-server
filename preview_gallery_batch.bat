@echo off
setlocal
cd /d "%~dp0"
title Lvyoumap Gallery Preview

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  pause
  exit /b 1
)

if not exist "scripts\start_attraction_gallery_batch_preview.js" (
  echo [ERROR] Preview script is missing.
  pause
  exit /b 1
)

node scripts\start_attraction_gallery_batch_preview.js
if errorlevel 1 (
  echo [ERROR] Gallery preview failed.
  pause
  exit /b 1
)

for /f "tokens=2 delims=:," %%P in ('findstr /c:"\"port\"" ".runtime\previews\attraction-gallery-batch\state.json"') do set "PREVIEW_PORT=%%~P"
set "PREVIEW_PORT=%PREVIEW_PORT: =%"
if defined PREVIEW_PORT start "" "http://127.0.0.1:%PREVIEW_PORT%/preview.html"

echo [OK] Preview is running. Close this window when review is finished.
pause
exit /b 0
