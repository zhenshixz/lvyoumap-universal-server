@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto fail
where node >nul 2>nul
if errorlevel 1 goto fail
if not exist "scripts\gallery_progress_server.js" goto fail
if not exist "scripts\gallery-progress.html" goto fail
if not exist "node_modules\vue\dist\vue.global.prod.js" goto fail
node scripts\gallery_progress_server.js --start --open
if errorlevel 1 goto fail
echo [OK] Read-only progress page. Collection was not started or restarted.
pause
exit /b 0
:fail
echo [ERROR] Check the beta path, Node.js and dependencies. Run npm ci if needed.
pause
exit /b 1
