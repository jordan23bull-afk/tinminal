"""Шаг цены инструмента и привязка цен к нему.

На бирже сделки бывают только на шагах цены: между шагами их не бывает.
Поэтому всё, что становится уровнем или алертом, обязано лежать на шаге.
Иначе линия стоит на цене, по которой никто не торговал, и срабатывание
приходится проверять с допуском в половину шага — допуск маскирует ошибку
вместо того, чтобы её не допускать.

Сравнение цены с уровнем поэтому идёт не по расстоянию, а по номеру шага:
`step_index(цена) == step_index(уровень)`. Это то же самое, что «на одном
шаге», но без магической константы и без допуска на глаз.

Шаг берётся у источника (`get_tick`), а не из настроек графика: у каждого
тикера он свой, у акций и фьючерсов считается в разных единицах.
"""

import logging
import math
import threading

logger = logging.getLogger("dash.prices")

# Запасной шаг: когда инструмент ещё не разрешён. Совпадает с DEFAULT_TICK
# в frontend/js/prices.js, поэтому обе стороны округляют одинаково.
DEFAULT_TICK = 0.01

_ticks = {}
_ticks_lock = threading.Lock()


def _step(tick):
    """Положительный шаг инструмента или запасной."""
    try:
        raw = float(tick or 0.0)
    except (TypeError, ValueError):
        return DEFAULT_TICK
    return raw if math.isfinite(raw) and raw > 0 else DEFAULT_TICK


def tick_decimals(tick):
    """Сколько знаков после запятой нужно, чтобы записать шаг без потерь.

    0.0025 -> 4, 0.01 -> 2, 25 -> 0. Без этого 0.1 + 0.2 даёт
    0.30000000000000004 и цена снова сходит с шага.
    """
    try:
        text = f"{float(tick):.10f}".rstrip("0")
    except (TypeError, ValueError):
        return 0
    if "." not in text:
        return 0
    return len(text.split(".")[1])


def step_index(price, tick):
    """Номер шага, на котором стоит цена. None, если цены нет.

    Округление — `floor(x + 0.5)`, а не `round`: Python округляет половину
    к чётному, JavaScript `Math.round` — вверх. Без общего правила клиент и
    сервер разошлись бы ровно на полушаге (100.005 при шаге 0.01).
    """
    try:
        value = float(price)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return int(math.floor(value / _step(tick) + 0.5))


def snap(price, tick):
    """Ближайшая цена, кратная шагу. None, если цены нет.

    Шаг неизвестен или не положительный — округляем до DEFAULT_TICK.
    Так из базы уходит пиксельный хвост вроде 3772.340834460112.
    """
    step = _step(tick)
    index = step_index(price, step)
    if index is None:
        return None
    return round(index * step, tick_decimals(step))


def tick_for(symbol):
    """Шаг цены инструмента. 0, если узнать не удалось.

    Ноль — не ошибка: без источника (самотесты, нет токена) привязка идёт
    по DEFAULT_TICK, а сравнение с уровнем остаётся точным.
    """
    key = str(symbol or "").upper()
    if not key:
        return 0.0
    with _ticks_lock:
        known = _ticks.get(key)
    if known:
        return known

    try:
        from core.registry import ModuleRegistry

        for name in ModuleRegistry.list_data_sources():
            try:
                source = ModuleRegistry.get_data_source(name)
            except Exception:
                continue
            getter = getattr(source, "get_tick", None)
            if getter is None:
                continue
            try:
                tick = float(getter(key) or 0.0)
            except Exception:
                continue
            if tick > 0:
                # Кэшируем только удачный ответ: шаг инструмента не меняется,
                # а нулевой результат мог быть сетевым сбоем.
                with _ticks_lock:
                    _ticks[key] = tick
                return tick
    except Exception:
        logger.debug("Не удалось получить шаг цены для %s", key, exc_info=True)
    return 0.0
