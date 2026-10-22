"""Серверная проверка алертов.

Раньше алерты жили в localStorage и проверялись в браузере: без открытой
вкладки они не срабатывали, а в двух вкладках одно и то же срабатывало
дважды. Теперь условие проверяет сервер на каждой свече, состояние
хранится в таблице alerts.

Условия:
    above   — цена пересекла уровень снизу вверх;
    below   — цена пересекла уровень сверху вниз;
    cross   — свеча задела уровень с любой стороны;
    inside  — цена внутри коридора [price, price_high].

Жизненный цикл: armed -> fired | expired | disabled.
"""

import logging
import threading
import time

from . import store

logger = logging.getLogger("dash.alerts")

CONDITIONS = ("above", "below", "cross", "inside")
DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60


def _f(value):
    """Цена может прийти и числом, и строкой из localStorage."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def matches(alert, candle):
    """Сработал ли алерт на этой свече."""
    close = _f(candle.get("close"))
    high = _f(candle.get("high"))
    low = _f(candle.get("low"))
    if close is None:
        return False

    price = _f(alert.get("price"))
    high_price = _f(alert.get("price_high"))
    condition = alert.get("condition") or "cross"
    if high is None:
        high = close
    if low is None:
        low = close

    if condition == "above":
        return price is not None and close >= price
    if condition == "below":
        return price is not None and close <= price
    if condition == "cross":
        # Уровень внутри диапазона свечи: цена его коснулась.
        return price is not None and low <= price <= high
    if condition == "inside":
        if price is None or high_price is None:
            return False
        lo, hi = (price, high_price) if price <= high_price else (high_price, price)
        return lo <= close <= hi
    return False


def expire_stale():
    """Перевести истёкшие алерты в статус expired. Возвращает список id."""
    now = int(time.time())
    conn = store._conn()
    rows = conn.execute(
        "SELECT id FROM alerts WHERE status='armed' AND expires_at IS NOT NULL AND expires_at < ?",
        (now,),
    ).fetchall()
    expired = [r["id"] for r in rows]
    if expired:
        conn.executemany(
            "UPDATE alerts SET status='expired' WHERE id=?", [(a,) for a in expired]
        )
        conn.commit()
        logger.info("Alerts expired: %s", len(expired))
    return expired


def matches_price(alert, price, tolerance=0.0):
    """Сработал ли алерт на цене отдельной сделки.

    Уровень ставится магнитом по цене свечи, но в базу попадает пересчитанным
    из пикселя, поэтому сравниваем с допуском в половину шага инструмента.
    """
    level = _f(alert.get("price"))
    if level is None or price is None:
        return False
    return abs(price - level) <= max(0.0, tolerance)


def after_arming(alert, ts):
    """Не сработать на том, что произошло до постановки алерта.

    Иначе алерт, поставленный посередине незакрытой свечи, выстрелил бы
    сразу: её диапазон уже накрывает уровень, а свечные сделки за прошедшую
    часть свечи давно позади.
    """
    created = alert.get("created_at")
    if created is None or ts is None:
        return True
    return int(ts) > int(created)


def evaluate_trades(symbol, trades, tick=0.0):
    """Проверить алерты по потоку сделок.

    trades — список пар (время в секундах, цена) в порядке поступления.
    Возвращает сработавшие алерты с ценой сделки, на которой сработали.
    """
    symbol = str(symbol or "").upper()
    expire_stale()
    tolerance = float(tick or 0.0) / 2.0

    armed = store.list_armed_alerts(symbol)
    if not armed or not trades:
        return []

    fired = []
    for ts, raw_price in trades:
        price = _f(raw_price)
        if price is None:
            continue
        for alert in armed:
            if any(f["id"] == alert["id"] for f in fired):
                continue
            if not after_arming(alert, ts):
                continue
            if not matches_price(alert, price, tolerance):
                continue

            store.mark_alert_fired(alert["id"])
            # repeat_mode='always' — алерт возвращается в бой после срабатывания.
            if (alert.get("repeat_mode") or "once") == "always":
                store.update_alert(alert["id"], status="armed")

            current = dict(store.get_alert(alert["id"]) or alert)
            current["trade"] = {"price": price, "time": ts}
            fired.append(current)

    if fired:
        logger.info("Alerts fired for %s by trades: %s",
                    symbol, [f["id"] for f in fired])
    return fired


def evaluate_candle(symbol, timeframe, candle):
    """Запасная проверка по свече — если поток сделок недоступен.

    Основной путь проверки — сделки. Здесь важно лишь не дать сработать
    на свече, начавшейся до постановки алерта.
    """
    symbol = str(symbol or "").upper()
    expire_stale()

    fired = []
    for alert in store.list_armed_alerts(symbol):
        if not after_arming(alert, candle.get("time")):
            continue
        if not matches(alert, candle):
            continue

        updated = store.mark_alert_fired(alert["id"])
        # repeat_mode='always' — алерт возвращается в бой после срабатывания.
        if (alert.get("repeat_mode") or "once") == "always":
            store.update_alert(alert["id"], status="armed")
            updated = store.get_alert(alert["id"])
        if updated:
            updated = dict(updated)
            updated["candle"] = {"close": candle.get("close"), "time": candle.get("time")}
            fired.append(updated)

    if fired:
        logger.info("Alerts fired for %s: %s", symbol, [a["id"] for a in fired])
    return fired


class AlertWatcher:
    """Держит потоки сделок для символов с активными алертами.

    Без этого алерты молчат, когда ни одна вкладка не подписана на поток:
    сервер тогда просто ничего не получает. Ключ — только символ: по
    сделкам таймфрейм не имеет значения.
    """

    def __init__(self, ensure_stream, drop_stream, interval=10):
        self._ensure_stream = ensure_stream
        self._drop_stream = drop_stream
        self._interval = interval
        self._held = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="alert-watcher", daemon=True)
        self._thread.start()
        logger.info("Alert watcher started")

    def stop(self):
        self._stop.set()

    def _loop(self):
        # Первый проход сразу: иначе после перезапуска сервера первые
        # секунды алерты молчат, пока не отработает первый интервал.
        try:
            self.tick()
        except Exception:
            logger.exception("Alert watcher first tick failed")
        while not self._stop.wait(self._interval):
            try:
                self.tick()
            except Exception:
                logger.exception("Alert watcher tick failed")

    def tick(self):
        """Подстроить потоки под текущий набор активных алертов."""
        needed = set()
        for alert in store.list_armed_alerts():
            symbol = str(alert.get("symbol") or "").upper()
            if symbol:
                needed.add(symbol)

        with self._lock:
            for symbol in needed - self._held:
                try:
                    self._ensure_stream(symbol)
                    self._held.add(symbol)
                except Exception:
                    logger.exception("Не удалось запустить поток сделок: %s", symbol)

            # Потоки без алертов больше не нужны: освобождаем подписку.
            for symbol in list(self._held - needed):
                try:
                    self._drop_stream(symbol)
                except Exception:
                    logger.exception("Не удалось остановить поток сделок: %s", symbol)
                self._held.discard(symbol)

    def held_rooms(self):
        with self._lock:
            return set(self._held)