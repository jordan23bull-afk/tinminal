"""Подготовка схемы состояния при старте.

Вызывается один раз перед обслуживанием запросов. Идемпотентно:
повторный запуск ничего не меняет.
"""

import logging

from core import store

logger = logging.getLogger(__name__)

# Ключ в settings.json, который раньше был единственным носителем состояния.
LEGACY_STATE_KEY = "trading-dashboard-state"


def init():
    """Создать таблицы состояния."""
    store.init_schema()
    logger.info("[Migrations] Схема состояния актуальна")


def ensure_default_layout(default_name="Основная"):
    """Гарантировать наличие раскладки по умолчанию.

    Пустая база после развёртывания не должна приводить к 404 при первом
    открытии страницы — клиент сможет либо взять эту раскладку, либо создать свою.
    """
    existing = store.list_layouts()
    if existing:
        return existing[0]
    layout = store.create_layout(name=default_name)
    logger.info("[Migrations] Создана раскладка по умолчанию: %s", layout["id"])
    return layout