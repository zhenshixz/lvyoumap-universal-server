@echo off
setlocal
title Lvyoumap Universal Server
cd /d "%~dp0"

if not exist "package.json" (
  echo [ERROR] package.json was not found in: %CD%
  goto :fail
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 24 LTS or newer is required.
  echo Install it from https://nodejs.org/
  goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js 24 LTS.
  goto :fail
)

set "NODE_MAJOR="
for /f %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
  echo [ERROR] Unable to read the Node.js version.
  goto :fail
)
if %NODE_MAJOR% LSS 24 (
  echo [ERROR] Node.js 24 LTS or newer is required. Current major: %NODE_MAJOR%
  goto :fail
)

echo [1/2] Building the frontend...
call npm run build
if errorlevel 1 (
  echo [ERROR] Frontend build failed.
  goto :fail
)

set "LOCAL_IP=127.0.0.1"
for /f "delims=" %%i in ('node -e "let ip='127.0.0.1';for(const list of Object.values(require('os').networkInterfaces()))for(const net of list||[])if(net.family==='IPv4'&&!net.internal){ip=net.address;if(ip.startsWith('192.')||ip.startsWith('10.'))break}console.log(ip)"') do set "LOCAL_IP=%%i"

echo.
echo [2/2] Starting the universal server...
echo Local URL: http://127.0.0.1:3000
echo LAN URL:   http://%LOCAL_IP%:3000
echo Health:    http://127.0.0.1:3000/api/health
echo Press Ctrl+C to stop.
echo.

set "HOST=0.0.0.0"
set "PORT=3000"
node server\index.js
if errorlevel 1 (
  echo [ERROR] The server stopped unexpectedly.
  goto :fail
)

endlocal
exit /b 0

:fail
echo.
echo The server was not started. Review the error above.
echo.
pause
exit /b 1
