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

for /f "tokens=2 delims=:," %%P in ('findstr /c:""port"" ".runtime\previews\attraction-gallery-batch\state.json"') do set "PREVIEW_PORT=%%~P"
set "PREVIEW_PORT=%PREVIEW_PORT: =%"
if defined PREVIEW_PORT start "" "http://127.0.0.1:%PREVIEW_PORT%/"

echo [OK] 隔离地图预览已在浏览器中打开，手机连接同一Wi-Fi访问控制台打印的内网IP即可真实验收。
echo 关闭此窗口即可退出。
pause
exit /b 0
