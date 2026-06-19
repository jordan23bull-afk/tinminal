@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"

echo ============================================
echo  Local Trading Dashboard - Setup ^& Launch
echo ============================================

echo.
echo [1/4] Creating Python virtual environment...
if exist "%BACKEND%\venv\Scripts\python.exe" (
    echo    venv already exists, skipping.
) else (
    python -m venv "%BACKEND%\venv"
    if errorlevel 1 (
        echo ERROR: Failed to create venv. Make sure Python 3.10+ is installed.
        pause
        exit /b 1
    )
)

set "PYTHON=%BACKEND%\venv\Scripts\python.exe"

echo.
echo [2/4] Installing dependencies...
"%PYTHON%" -m pip install -r "%BACKEND%\requirements.txt"
if errorlevel 1 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [3/3] Starting backend server...
echo Server will run at: http://localhost:5000
echo Open frontend/index.html in your browser
echo Press Ctrl+C to stop the server
echo.
"%PYTHON%" "%BACKEND%\core\app.py"
