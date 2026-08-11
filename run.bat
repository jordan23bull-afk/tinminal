@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"

echo ============================================
echo  Local Trading Dashboard - Setup ^& Launch
echo ============================================

echo.
echo [0/4] Checking TINKOFF_TOKEN...
if not exist "%BACKEND%\token.txt" (
    if "%TINKOFF_TOKEN%"=="" (
        echo    WARNING: TINKOFF_TOKEN is not set and backend\token.txt not found.
        echo    Set it before running:  set TINKOFF_TOKEN=your_token
        echo    Or create file backend\token.txt containing the token.
    ) else (
        echo    TINKOFF_TOKEN found.
    )
) else (
    echo    Token found in backend\token.txt.
)
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
echo [2/4] Activating virtual environment...
call "%BACKEND%\venv\Scripts\activate.bat"

echo [3/4] Installing dependencies...
"%PYTHON%" -m pip install -r "%BACKEND%\requirements.txt"
if errorlevel 1 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [4/4] Starting backend server...
echo Server will run at: http://localhost:5000
echo Open http://localhost:5000 in your browser
echo Press Ctrl+C to stop the server
echo.
"%PYTHON%" "%BACKEND%\core\app.py"
