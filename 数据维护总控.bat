@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title China Tourism Map - National Data Maintenance
echo Project: lvyoumap-universal-serverbeta ^(local beta workspace^)
echo Path: %CD%
echo.
if not exist package.json goto missing_project
where node >nul 2>nul
if errorlevel 1 goto missing_node
if not exist node_modules goto install_deps
node -e "require.resolve('puppeteer-extra');require.resolve('puppeteer-extra-plugin-stealth');require.resolve('puppeteer-core')" >nul 2>nul
if errorlevel 1 goto install_deps
node scripts\maintenance_menu.js
goto done

:install_deps
echo Installing dependencies...
call npm install
if errorlevel 1 goto failed
node scripts\maintenance_menu.js
goto done

:missing_project
echo ERROR: package.json was not found.
goto failed

:missing_node
echo ERROR: Node.js was not found in PATH.
goto failed

:failed
echo.
echo The maintenance tool did not start successfully.
pause
exit /b 1

:done
echo.
echo Maintenance tool closed.
pause
