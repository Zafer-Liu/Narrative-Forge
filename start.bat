@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Narrative Forge Launcher

set "APP_DIR=%~dp0"
set "VENV_DIR=%APP_DIR%.venv"
set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"
if not defined DIRECTOR_PORT set "DIRECTOR_PORT=8000"
set "APP_URL=http://127.0.0.1:%DIRECTOR_PORT%"

cd /d "%APP_DIR%"

if /I "%~1"=="--check" (
    call :find_python
    if errorlevel 1 exit /b 1
    "!BASE_PYTHON!" -c "import sys; print('Python ' + sys.version.split()[0] + ' OK')"
    exit /b !errorlevel!
)

call :service_ready
if not errorlevel 1 (
    echo Narrative Forge is already running.
    start "" "%APP_URL%"
    exit /b 0
)

if not exist "%PYTHON_EXE%" (
    call :find_python
    if errorlevel 1 goto :python_missing

    echo Creating the local Python environment...
    "!BASE_PYTHON!" -m venv "%VENV_DIR%"
    if errorlevel 1 goto :venv_failed
)

"%PYTHON_EXE%" -c "import requests" >nul 2>&1
if errorlevel 1 (
    echo Installing Python dependencies...
    "%PYTHON_EXE%" -m pip install -r "%APP_DIR%requirements.txt"
    if errorlevel 1 goto :dependency_failed
)

echo Starting Narrative Forge...
start "Narrative Forge Server" /D "%APP_DIR%" "%PYTHON_EXE%" app.py

for /L %%I in (1,1,30) do (
    call :service_ready
    if not errorlevel 1 goto :ready
    timeout /t 1 /nobreak >nul
)

echo.
echo Narrative Forge did not start within 30 seconds.
echo Review the server window for details.
pause
exit /b 1

:ready
start "" "%APP_URL%"
exit /b 0

:find_python
set "BASE_PYTHON="
where py >nul 2>&1
if not errorlevel 1 (
    for /f "usebackq delims=" %%P in (`py -3 -c "import sys; assert min(sys.version_info[:2], (3, 10)) == (3, 10); print(sys.executable)" 2^>nul`) do set "BASE_PYTHON=%%P"
)
if defined BASE_PYTHON exit /b 0

where python >nul 2>&1
if not errorlevel 1 (
    for /f "usebackq delims=" %%P in (`python -c "import sys; assert min(sys.version_info[:2], (3, 10)) == (3, 10); print(sys.executable)" 2^>nul`) do set "BASE_PYTHON=%%P"
)
if defined BASE_PYTHON exit /b 0
exit /b 1

:service_ready
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri '%APP_URL%/api/health' -TimeoutSec 1; if ($r.ok) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%

:python_missing
echo.
echo Python 3.10 or newer was not found.
echo Install Python from https://www.python.org/downloads/windows/
echo Enable the "Add Python to PATH" option, then run start.bat again.
pause
exit /b 1

:venv_failed
echo.
echo Failed to create the local Python environment.
pause
exit /b 1

:dependency_failed
echo.
echo Failed to install dependencies. Check the network and pip configuration.
pause
exit /b 1
