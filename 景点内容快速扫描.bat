@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto no_node
node scripts\scan_attraction_content_quick.js --open
if errorlevel 1 goto failed
echo.
echo Scan completed. The report should open automatically.
pause
exit /b 0
:no_node
echo Node.js was not found. Install Node.js and try again.
pause
exit /b 1
:failed
echo Scan failed. Review the message above.
pause
exit /b 1
