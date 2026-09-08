@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot open the project folder.
  pause
  exit /b 1
)
title Lvyoumap Gallery Batch

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [ERROR] node_modules is missing. Run npm install first.
  pause
  exit /b 1
)

if not exist "scripts\collect_attraction_galleries_batch.js" (
  echo [ERROR] Collection script is missing.
  pause
  exit /b 1
)
python -c "import PIL, cv2, numpy" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python image dependencies are missing: Pillow, opencv-python, numpy.
  pause
  exit /b 1
)

set "BATCH_LIMIT=520"
if not "%~1"=="" set "BATCH_LIMIT=%~1"

echo [INFO] Gallery cohort size: %BATCH_LIMIT% attractions.
echo [INFO] Progress is resumable. No production data will be written.
echo [INFO] Phase 1/2: exact and fast sources.
node scripts\collect_attraction_galleries_batch.js --limit=%BATCH_LIMIT% --max-items=%BATCH_LIMIT% --concurrency=6 --primary-only
if errorlevel 1 (
  echo [ERROR] Phase 1 stopped. Saved progress can be resumed by running this file again.
  pause
  exit /b 1
)

echo [INFO] Phase 2/2: secondary sources for items below 3 images.
node scripts\collect_attraction_galleries_batch.js --limit=%BATCH_LIMIT% --max-items=%BATCH_LIMIT% --concurrency=6 --repair-pending
if errorlevel 1 (
  echo [ERROR] Phase 2 stopped. Saved progress can be resumed by running this file again.
  pause
  exit /b 1
)

python scripts\render_attraction_gallery_batch.py
if errorlevel 1 (
  echo [ERROR] Contact sheet generation failed.
  pause
  exit /b 1
)

python scripts\compact_attraction_gallery_runtime.py
if errorlevel 1 (
  echo [WARN] Review cache compaction failed. Gallery results are still available.
)

echo [OK] Review files are under .runtime\attraction-gallery-batch\contact-sheets
pause
exit /b 0
