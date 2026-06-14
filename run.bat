@echo off
echo ============================================
echo  Local Trading Dashboard - Setup & Launch
echo ============================================

echo.
echo [1/4] Creating Python virtual environment...
cd backend
python -m venv venv
if errorlevel 1 (
    echo ERROR: Failed to create venv. Make sure Python 3.10+ is installed.
    pause
    exit /b 1
)

echo.
echo [2/4] Activating virtual environment...
call venv\Scripts\activate.bat

echo.
echo [3/4] Installing dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [4/4] Starting backend server...
echo Server will run at: http://localhost:5000
echo Open frontend/index.html in your browser
echo Press Ctrl+C to stop the server
echo.
python core/app.py
