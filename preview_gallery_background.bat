@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto fail
where node >nul 2>nul
if errorlevel 1 goto fail
if not exist "scripts\start_attraction_gallery_batch_preview.js" goto fail
node scripts\start_attraction_gallery_batch_preview.js --background
if errorlevel 1 goto fail
pause
exit /b 0
:fail
echo [ERROR] Preview startup failed. Check the message above.
pause
exit /b 1
