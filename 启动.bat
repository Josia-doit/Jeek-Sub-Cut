@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Node.js 18+ not found.
  echo     Please install Node.js first: https://npmmirror.com/mirrors/node/
  echo.
  if not defined JEEK_NO_PAUSE pause
  exit /b 1
)
node "%~dp0tools\launch.mjs" %*
set "JEEK_EXIT=%ERRORLEVEL%"
if not "%JEEK_EXIT%"=="0" (
  echo.
  echo [X] Launch failed, exit code %JEEK_EXIT%. See messages above.
  echo     If dependencies are missing, run the install script first.
  echo.
  if not defined JEEK_NO_PAUSE pause
)
exit /b %JEEK_EXIT%
