@echo off
setlocal
cd /d "%~dp0"
if not exist "scripts\gallery_link_batch_launcher.js" (
  echo ERROR: Run this BAT from the beta project folder.
  goto finish
)
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js 24 or newer is required.
  goto finish
)
if not exist "node_modules\vue" (
  echo ERROR: Dependencies missing. Run npm install in beta first.
  goto finish
)
node "scripts\gallery_link_batch_launcher.js" form
if errorlevel 1 echo ERROR: See the message above. No batch was intentionally restarted.
:finish
echo.
pause
endlocal
