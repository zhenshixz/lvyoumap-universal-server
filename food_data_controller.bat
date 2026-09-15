@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  pause
  exit /b 1
)
if not exist "scripts\food_maintenance_menu.js" (
  echo ERROR: scripts\food_maintenance_menu.js is missing.
  pause
  exit /b 1
)
chcp 65001 >nul
node "scripts\food_maintenance_menu.js"
if errorlevel 1 echo ERROR: Food data controller stopped unexpectedly.
pause
endlocal
