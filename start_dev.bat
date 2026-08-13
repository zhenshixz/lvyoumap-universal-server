@echo off
setlocal
cd /d "%~dp0"
title Lvyoumap Local Preview

echo ============================================================
echo China Tourism Map - Local Preview
echo ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 24 or later.
  pause
  exit /b 1
)

if not exist "server\index.js" (
  echo [ERROR] server\index.js was not found.
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo [INFO] Frontend build not found. Building now...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed. Review the message above.
    pause
    exit /b 1
  )
)

set "HOST=0.0.0.0"
set "PORT=3000"
echo [INFO] Starting stable preview server...
echo [INFO] Press Ctrl+C to stop.
echo ============================================================
node server\index.js

if errorlevel 1 (
  echo.
  echo [ERROR] The preview server stopped unexpectedly.
  pause
  exit /b 1
)

endlocal
