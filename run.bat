@echo off
rem Обёртка для Windows. Вся логика запуска в run.py — он же работает
rem на Linux и macOS. Запуск напрямую: python run.py
setlocal
python "%~dp0run.py" %*
exit /b %ERRORLEVEL%