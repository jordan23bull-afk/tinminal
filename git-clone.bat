@echo off
cd /d "%~dp0"
del "%~f0" 2>nul
git clone https://github.com/jordan23bull-afk/local-trading-dashboard.git .
if %errorlevel% neq 0 (
    echo Ошибка: клонирование не удалось. Установи git: https://git-scm.com
    pause
    goto :eof
)
run.bat
