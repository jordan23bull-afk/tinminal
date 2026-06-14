#!/bin/bash
echo "============================================"
echo " Local Trading Dashboard - Setup & Launch"
echo "============================================"

cd backend

echo "[1/4] Creating Python virtual environment..."
python3 -m venv venv

echo "[2/4] Activating virtual environment..."
source venv/bin/activate

echo "[3/4] Installing dependencies..."
pip install -r requirements.txt

echo "[4/4] Starting backend server..."
echo "Server will run at: http://localhost:5000"
echo "Open frontend/index.html in your browser"
echo "Press Ctrl+C to stop the server"
python core/app.py
