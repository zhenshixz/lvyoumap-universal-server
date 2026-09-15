@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto fail
where node >nul 2>nul
if errorlevel 1 goto fail
if not exist "scripts\codex_gallery_background.js" goto fail
node scripts\codex_gallery_background.js --stop
if errorlevel 1 goto fail
pause
exit /b 0
:fail
echo [ERROR] Stop request failed. Check the message above.
pause
exit /b 1
