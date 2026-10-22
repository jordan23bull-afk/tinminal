#!/bin/sh
# Запуск на Linux и macOS. Окружение и зависимости ставит run.py.
cd "$(dirname "$0")" || exit 1
exec python3 run.py "$@"
