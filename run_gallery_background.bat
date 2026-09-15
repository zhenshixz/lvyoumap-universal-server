@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto fail
where node >nul 2>nul
if errorlevel 1 goto fail
if not exist "scripts\codex_gallery_background.js" goto fail
if not exist "scripts\gallery_progress_server.js" goto fail
node scripts\codex_gallery_background.js --start
if errorlevel 1 goto fail
node scripts\gallery_progress_server.js --start --open
if errorlevel 1 goto fail
echo [OK] Background is running. You may close this window.
echo [INFO] Keep this PC powered on, connected and awake.
echo [INFO] Use view_gallery_progress.bat for read-only live progress.
pause
exit /b 0
:fail
echo [ERROR] Check the message above, Node.js, Python and npm dependencies.
pause
exit /b 1
