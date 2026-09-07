@echo off
setlocal
chcp 65001 >nul
title China Tourism Map - Sync Beta to Formal Git

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%scripts\promote_to_formal_git.ps1"

if not exist "%PS_SCRIPT%" (
  echo ERROR: Missing sync script:
  echo %PS_SCRIPT%
  echo.
  pause
  exit /b 1
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: powershell.exe was not found.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" echo Sync did not complete. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
