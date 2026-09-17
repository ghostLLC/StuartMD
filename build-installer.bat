@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo   StuartMD Build Pipeline
echo ============================================

set "SYS_PY=C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe"
if not exist "%SYS_PY%" (
  where python >nul 2>nul && set "SYS_PY=python"
)
if "%SYS_PY%"=="" (
  echo [ERROR] Python not found
  exit /b 1
)

set "ISCC=C:\Users\Administrator\AppData\Local\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"

echo [1/3] Cleaning previous outputs...
if exist "dist\StuartMD" rmdir /s /q "dist\StuartMD"
if exist "dist-installer" rmdir /s /q "dist-installer"
mkdir dist 2>nul
mkdir dist-installer 2>nul

echo [2/3] PyInstaller packaging...
"%SYS_PY%" -m PyInstaller --noconfirm --clean StuartMD.spec
if errorlevel 1 (
  echo [ERROR] PyInstaller failed
  exit /b 1
)

if not exist "dist\StuartMD\StuartMD.exe" (
  echo [ERROR] EXE not produced at dist\StuartMD\StuartMD.exe
  exit /b 1
)

echo [3/3] Inno Setup installer...
if not exist "%ISCC%" (
  echo [WARN] ISCC not found - portable folder only: dist\StuartMD\
  exit /b 0
)

"%ISCC%" "installer\StuartMD.iss"
if errorlevel 1 (
  echo [ERROR] Inno Setup failed
  exit /b 1
)

echo.
echo ============================================
echo   BUILD OK
echo   Portable folder: dist\StuartMD\
echo   Installer:       dist-installer\StuartMD-Setup-1.2.1.exe
echo ============================================
endlocal
