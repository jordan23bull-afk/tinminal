#!/usr/bin/env python3
"""Кроссплатформенный запуск торгового дашборда.

Работает на Windows, Linux и macOS: создаёт виртуальное окружение, ставит
зависимости и запускает сервер. Замена run.bat, который понимает только cmd.exe.

    python run.py              создать окружение и запустить
    python run.py --no-setup   запустить без установки зависимостей
    python run.py --host 0.0.0.0 --port 8080
    python run.py --data-dir D:/dash-data
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
REQUIREMENTS = BACKEND / "requirements.txt"
APP = BACKEND / "core" / "app.py"
VENV = BACKEND / "venv"

# Старый каталог окружения на Windows: venv/Scripts/python.exe.
# На POSIX он называется bin/python, поэтому путь выбирается по ОС.
WINDOWS_PYTHON = VENV / "Scripts" / "python.exe"
POSIX_PYTHON = VENV / "bin" / "python"


def banner(step, total, text):
    print(f"[{step}/{total}] {text}", flush=True)


def venv_python():
    if sys.platform == "win32":
        return WINDOWS_PYTHON if WINDOWS_PYTHON.exists() else None
    return POSIX_PYTHON if POSIX_PYTHON.exists() else None


def create_venv():
    banner(1, 3, "Creating virtual environment...")
    if venv_python():
        print("    already exists, skipping.", flush=True)
        return venv_python()
    try:
        subprocess.run(
            [sys.executable, "-m", "venv", str(VENV)],
            check=True,
        )
    except subprocess.CalledProcessError:
        print("ERROR: failed to create venv. Install Python 3.10+ first.", flush=True)
        raise SystemExit(1)
    py = venv_python()
    if not py:
        print(f"ERROR: venv created but interpreter not found under {VENV}", flush=True)
        raise SystemExit(1)
    return py


def install_deps(python):
    banner(2, 3, "Installing dependencies...")
    if not REQUIREMENTS.exists():
        print(f"ERROR: {REQUIREMENTS} not found.", flush=True)
        raise SystemExit(1)
    try:
        subprocess.run(
            [str(python), "-m", "pip", "install", "-q", "-r", str(REQUIREMENTS)],
            check=True,
        )
    except subprocess.CalledProcessError:
        print("ERROR: failed to install dependencies.", flush=True)
        raise SystemExit(1)


def export_env(args):
    if args.host:
        os.environ["DASH_HOST"] = args.host
    if args.port:
        os.environ["DASH_PORT"] = str(args.port)
    if args.data_dir:
        os.environ["DASH_DATA_DIR"] = str(Path(args.data_dir).expanduser())
    if args.no_frontend:
        os.environ["DASH_SERVE_FRONTEND"] = "false"
    if args.log_level:
        os.environ["DASH_LOG_LEVEL"] = args.log_level


def main():
    parser = argparse.ArgumentParser(
        description="Запуск торгового дашборда (Windows / Linux / macOS).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--host", default=None, help="адрес прослушивания")
    parser.add_argument("--port", type=int, default=None, help="порт")
    parser.add_argument("--data-dir", default=None, help="каталог данных")
    parser.add_argument("--log-level", default=None,
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    parser.add_argument("--no-setup", action="store_true",
                        help="не создавать venv и не ставить зависимости")
    parser.add_argument("--no-frontend", action="store_true",
                        help="не отдавать статику фронтенда (только API)")
    args = parser.parse_args()

    print("=" * 44)
    print(" Trading Dashboard - Setup & Launch")
    print("=" * 44, flush=True)

    # Пути токена — те же, что у сервера. Своя копия путей расходилась:
    # предупреждение ругалось на отсутствие токена, когда он лежал в
    # каталоге данных.
    export_env(args)
    sys.path.insert(0, str(BACKEND))
    from core import config  # noqa: E402  (импорт после export_env: путь из --data-dir)

    if not (os.environ.get("TINKOFF_TOKEN") or os.environ.get("DASH_TINKOFF_TOKEN")
            or config.TOKEN_FILE.exists() or config.TOKEN_FILE_LEGACY.exists()):
        print("    WARNING: токен T-Invest не найден.")
        print(f"    Задайте TINKOFF_TOKEN или положите файл в {config.TOKEN_FILE}")

    if args.no_setup:
        python = venv_python() or sys.executable
    else:
        python = create_venv()
        install_deps(python)

    banner(3, 3, "Starting backend server...")
    print("    Press Ctrl+C to stop.", flush=True)
    print(f"    Data dir: {os.environ.get('DASH_DATA_DIR', '(default: <project>/data)')}",
          flush=True)
    print(flush=True)

    try:
        subprocess.run([str(python), str(APP)], check=False)
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())