"""Конфигурация приложения.

Все настройки читаются здесь и только здесь, остальные модули берут значения
из этого файла. Значения по умолчанию подобраны для запуска в локальной сети
без дополнительной настройки.

Переменные окружения (префикс DASH_):

    DASH_HOST             адрес прослушивания, по умолчанию 0.0.0.0
    DASH_PORT             порт, по умолчанию 5000
    DASH_DATA_DIR         каталог данных, по умолчанию <проект>/data
    DASH_LOG_LEVEL        уровень логирования, по умолчанию INFO
    DASH_SERVE_FRONTEND   отдавать ли статику фронтенда, по умолчанию True
    DASH_TINKOFF_TOKEN    токен T-Invest (имеет приоритет над файлом)
    DASH_PROTOCOL_VERSION версия протокола клиент-сервер, по умолчанию 2

Существующая переменная TINKOFF_TOKEN продолжает работать.
"""

import logging
import os
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

CORE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = CORE_DIR.parent
PROJECT_ROOT = BACKEND_DIR.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"


def _env_str(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    raw = raw.strip()
    return raw if raw else default


def _env_bool(name, default):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name, default):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        raise ValueError(
            f"{name} должен быть целым числом, получено {raw!r}"
        ) from None


def _env_token(name):
    """Токен: сначала DASH_<NAME>, затем legacy <NAME> без префикса."""
    for key in (f"DASH_{name}", name):
        raw = os.environ.get(key)
        if raw and raw.strip():
            return raw.strip()
    return ""


# --- сеть -------------------------------------------------------------------

HOST = _env_str("DASH_HOST", "0.0.0.0")
PORT = _env_int("DASH_PORT", 5000)
SERVE_FRONTEND = _env_bool("DASH_SERVE_FRONTEND", True)

# --- данные -----------------------------------------------------------------

DATA_DIR = Path(_env_str("DASH_DATA_DIR", str(PROJECT_ROOT / "data"))).expanduser()
DATA_DIR = DATA_DIR if DATA_DIR.is_absolute() else (PROJECT_ROOT / DATA_DIR)

DB_PATH = DATA_DIR / "candles.db"
SETTINGS_FILE = DATA_DIR / "settings.json"

# Каталог сертификатов. Исходный российский УЦ остаётся в репозитории,
# генерируемый bundle переезжает в каталог данных.
CERTS_SOURCE_DIR = BACKEND_DIR / "certs"
NATIVE_CA = CERTS_SOURCE_DIR / "tinkoff-national-ca.pem"
CERTS_DIR = DATA_DIR / "certs"
CA_BUNDLE = CERTS_DIR / "ca-bundle.pem"

# Токен T-Invest: новый путь в каталоге данных, старый в backend/ сохранён
# как запасной, чтобы ничего не сломалось у существующих установок.
TOKEN_FILE = DATA_DIR / "tinkoff_token.txt"
TOKEN_FILE_LEGACY = BACKEND_DIR / "token.txt"
TINKOFF_TOKEN = _env_token("TINKOFF_TOKEN")

# --- прочее -----------------------------------------------------------------

LOG_LEVEL = _env_str("DASH_LOG_LEVEL", "INFO").upper()
PROTOCOL_VERSION = _env_int("DASH_PROTOCOL_VERSION", 2)
SERVER_VERSION = "0.2.0"


def ensure_dirs():
    """Создать каталоги данных. Вызывается один раз при старте."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CERTS_DIR.mkdir(parents=True, exist_ok=True)


def _move_legacy(new_path, old_path, label):
    """Перенести файл из прежнего расположения в каталог данных.

    Вызывается только если нового файла ещё нет, поэтому повторный запуск
    ничего не трогает. При невозможности переноса копирует.
    """
    if new_path.exists() or not old_path.exists():
        return False
    try:
        os.replace(str(old_path), str(new_path))
        logger.info("[Config] %s: перенесён %s -> %s", label, old_path, new_path)
        return True
    except OSError as exc:
        try:
            shutil.copy2(str(old_path), str(new_path))
            logger.info("[Config] %s: скопирован %s -> %s (%s)", label, old_path, new_path, exc)
            return True
        except OSError as copy_exc:
            logger.warning(
                "[Config] %s: не удалось перенести %s -> %s (%s); "
                "скопируйте вручную", label, old_path, new_path, copy_exc,
            )
            return False


def migrate_legacy_data():
    """Перенести данные из корня проекта в DATA_DIR.

    Нужна один раз: без неё перенос настроек и базы свечей на новую машину
    выглядел бы как потеря 111 МБ истории.
    """
    moved = []

    for new_path, old_path, label in (
        (DB_PATH, PROJECT_ROOT / "candles.db", "база свечей"),
        (SETTINGS_FILE, PROJECT_ROOT / "settings.json", "настройки"),
        (CA_BUNDLE, CERTS_SOURCE_DIR / "ca-bundle.pem", "CA bundle"),
        (TOKEN_FILE, TOKEN_FILE_LEGACY, "токен T-Invest"),
    ):
        # WAL и SHM принадлежат базе, переносить нужно вместе с ней
        if new_path == DB_PATH:
            for suffix in ("-wal", "-shm"):
                _move_legacy(
                    Path(str(new_path) + suffix),
                    Path(str(old_path) + suffix),
                    f"{label}{suffix}",
                )
        if _move_legacy(new_path, old_path, label):
            moved.append(label)

    if moved:
        logger.info("[Config] Перенесено в каталог данных: %s", ", ".join(moved))
    return moved


def public_url():
    """Адрес для сообщения при старте."""
    shown = "127.0.0.1" if HOST in ("0.0.0.0", "::") else HOST
    return f"http://{shown}:{PORT}"


def summary():
    """Значения для вывода при старте."""
    return {
        "host": HOST,
        "port": PORT,
        "data_dir": str(DATA_DIR),
        "serve_frontend": SERVE_FRONTEND,
        "log_level": LOG_LEVEL,
        "protocol_version": PROTOCOL_VERSION,
    }