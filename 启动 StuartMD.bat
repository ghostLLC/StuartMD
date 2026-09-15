@echo off
setlocal
cd /d "%~dp0"

rem Prefer installed copy
set "INSTALLED=%LOCALAPPDATA%\Programs\StuartMD\StuartMD.exe"
if exist "%INSTALLED%" (
  start "" "%INSTALLED%" %*
  exit /b 0
)

rem Fallback: portable dist next to this script
set "PORTABLE=%~dp0dist\StuartMD\StuartMD.exe"
if exist "%PORTABLE%" (
  start "" "%PORTABLE%" %*
  exit /b 0
)

rem Last resort: source mode
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY (
  echo [错误] 未找到 StuartMD 或 Python。请先运行 dist-installer\StuartMD-Setup-1.0.0.exe
  pause
  exit /b 1
)
"%PY%" -c "import webview" 2>nul || "%PY%" -m pip install pywebview -q
start "" "%PY%" "%~dp0main.py" %*
endlocal
