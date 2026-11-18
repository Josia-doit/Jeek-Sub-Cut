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
echo.
echo JeekSubCut - installing dependencies and runtime files.
echo Please keep this window open until it finishes.
echo.
node "%~dp0tools\install-deps.mjs" %*
set "JEEK_EXIT=%ERRORLEVEL%"
echo.
if not "%JEEK_EXIT%"=="0" (
  echo [X] Install failed, exit code %JEEK_EXIT%. See messages above.
) else (
  echo [OK] Done. Double-click the launcher script, or run: npm start
)
echo.
if not defined JEEK_NO_PAUSE pause
exit /b %JEEK_EXIT%
