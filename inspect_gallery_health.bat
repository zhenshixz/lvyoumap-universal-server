@echo off
chcp 65001 >nul
echo ===================================================
echo   [Gallery Health] Inspect and Heal Pipeline
echo ===================================================
node "%~dp0scripts\inspect_and_heal_gallery_pipeline.js"
echo.
pause
