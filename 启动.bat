@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "NODE_EXE=%~dp0install\runtime\node\node.exe"
if not exist "%NODE_EXE%" (
  echo.
  echo [i] Bundled Node.js not found. Downloading it now ^(about 35 MB, once^)...
  echo     This is fully automatic - no need to install Node.js yourself.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\bootstrap-node.ps1" -Root "%~dp0."
  if errorlevel 1 (
    echo.
    echo [X] Failed to prepare the bundled Node.js runtime. Check your network.
    if not defined JEEK_NO_PAUSE pause
    exit /b 1
  )
)
if not exist "%NODE_EXE%" (
  echo [X] Node.js runtime still missing after bootstrap.
  if not defined JEEK_NO_PAUSE pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0tools\launch.mjs" %*
set "JEEK_EXIT=%ERRORLEVEL%"
if not "%JEEK_EXIT%"=="0" (
  echo.
  echo [X] Launch failed, exit code %JEEK_EXIT%. See messages above.
  echo     If dependencies are missing, run the install script first.
  echo.
  if not defined JEEK_NO_PAUSE pause
)
exit /b %JEEK_EXIT%
