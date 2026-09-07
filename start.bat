@echo off
rem ============================================
rem  Novel Crawler Launcher (double-click me)
rem  Starts the web GUI and opens the browser.
rem ============================================
setlocal
cd /d "%~dp0"

rem --- prefer managed venv python, then system python ---
set "PY=%~dp0.venv\Scripts\python.exe"
if exist "%PY%" goto :found

set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if exist "%PY%" goto :found

set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if exist "%PY%" goto :found

set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.9+ first.
    pause
    exit /b 1
)

:found
echo Using Python: %PY%
"%PY%" start.py %*
if errorlevel 1 (
    echo.
    echo Something went wrong. See messages above.
    pause
)
endlocal
