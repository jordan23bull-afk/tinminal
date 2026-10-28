"""
ATR-скринер MOEX.

Загружает дневную историю торгов с MOEX ISS, фильтрует по ликвидности
и заданному порогу ATR (в пунктах), определяет направление дня
(покупной/продажный) и возвращает результат для простановки флажков.

Источник логики: E:\\atrnew\\atr150.py (переписано без pandas).
"""

import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import requests

MIN_VALUE_RUB = 10_000_000   # минимальный дневной оборот, руб.

_BOARD = "TQBR"

_HISTORY_URL = (
    "https://iss.moex.com/iss/history/engines/stock/"
    "markets/shares/boards/{board}/securities.json"
)
_META_URL = (
    "https://iss.moex.com/iss/engines/stock/markets/shares/"
    "boards/{board}/securities.json"
)
_CANDLES_URL = (
    "https://iss.moex.com/iss/engines/stock/markets/shares/"
    "boards/{board}/securities/{secid}/candles.json"
)

# Фьючерсы FORTS. Секция «акции» и секция «фьючерсы» — разные эндпоинты ISS,
# общих полей у них только OHLCV. Тикер вочлиста совпадает с SECID Мосбиржи
# с точностью до регистра (SiZ6 в ISS — SIZ6 в Tinkoff), поэтому справочник
# сопоставляет их по верхнему регистру.
_FUT_HISTORY_URL = (
    "https://iss.moex.com/iss/history/engines/futures/markets/forts/"
    "securities/{secid}.json"
)
_FUT_META_URL = (
    "https://iss.moex.com/iss/engines/futures/markets/forts/securities.json"
)
_FUT_CANDLES_URL = (
    "https://iss.moex.com/iss/engines/futures/markets/forts/"
    "securities/{secid}/candles.json"
)

MAX_FUTURES = 40          # потолок списка из вочлиста, чтобы не молотить ISS
FUT_META_TTL = 300        # справочник FORTS: 501 строка, держим 5 минут
_forts_meta_cache = {"ts": 0.0, "data": {}}
_TICKER_RE = re.compile(r"^[A-Z0-9]{2,12}$")

EVENING_FROM_HOUR = 19  # вечерняя сессия начинается в 19:00 МСК

_evening_cache = {}  # (date, secid) -> (high, low) | (None, None)
EVENING_WORKERS = 4  # ponytail: у ISS свои rate limits, агрессивная параллельность -> 429/бан по IP


def get_last_trading_day(max_lookback_days=10):
    """Возвращает последний торговый день (YYYY-MM-DD) или None."""
    today = datetime.now()
    for days_back in range(1, max_lookback_days + 1):
        check_date = today - timedelta(days=days_back)
        date_str = check_date.strftime("%Y-%m-%d")
        try:
            resp = requests.get(
                _HISTORY_URL.format(board=_BOARD),
                params={"date": date_str, "start": 0},
                timeout=10,
            )
            resp.raise_for_status()
            if resp.json().get("history", {}).get("data"):
                return date_str
        except requests.RequestException:
            pass
        time.sleep(0.1)
    return None


def _fetch_moex_history(date_str):
    """Загружает дневную историю торгов за дату (с пагинацией)."""
    rows = []
    columns = []
    start = 0
    page_size = 100
    while True:
        try:
            resp = requests.get(
                _HISTORY_URL.format(board=_BOARD),
                params={"date": date_str, "start": start},
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            history = data.get("history", {})
            if not columns:
                columns = history.get("columns", [])
            page_data = history.get("data", [])
            if not page_data:
                break
            rows.extend(page_data)
            start += page_size
            time.sleep(0.2)
        except requests.RequestException:
            break
    return columns, rows


def _get_minstep_metadata():
    """Возвращает (step_dict, equity_secids).

    equity_secids — множество SECID только обычных/привилегированных акций
    (INSTRID == "EQIN"). Всё остальное (ETF/ПИФы IFTF/IFAY, облигации и
    депозитарные расписки IFA1) отсеивается ещё до подсчёта ATR.
    """
    try:
        resp = requests.get(_META_URL.format(board=_BOARD), timeout=15)
        resp.raise_for_status()
        sec_table = resp.json().get("securities")
        if not sec_table:
            return {}, set()
        cols = sec_table["columns"]
        step_col = next(
            (c for c in cols if c.upper() in ("MINSTEP", "MIN_PRICE_STEP", "STEP")),
            None,
        )
        if not step_col:
            return {}, set()
        idx = {c: i for i, c in enumerate(cols)}
        step_dict = {}
        equity_secids = set()
        for row in sec_table["data"]:
            secid = row[idx["SECID"]]
            try:
                step = float(row[idx[step_col]])
            except (TypeError, ValueError):
                step = 1.0
            step_dict[secid] = step if step else 1.0
            instr = row[idx["INSTRID"]] if "INSTRID" in idx else ""
            if instr == "EQIN":
                equity_secids.add(secid)
        return step_dict, equity_secids
    except requests.RequestException:
        return {}, set()


def _fetch_evening_session(date_str, secid, candles_url=_CANDLES_URL):
    """High/Low вечерней сессии (с 19:00 МСК до закрытия) за дату.

    Берёт часовые свечи MOEX (времена — МСК) и агрегирует max(HIGH)/min(LOW)
    по барам, начавшимся с EVENING_FROM_HOUR. Возвращает (high, low) или
    (None, None) если данных/вечерки нет.

    Шаблон адреса — параметр: у акций и фьючерсов разные эндпоинты ISS,
    агрегация и кэш у них общие.
    """
    key = (date_str, secid)
    if key in _evening_cache:
        return _evening_cache[key]
    try:
        resp = requests.get(
            candles_url.format(board=_BOARD, secid=secid),
            params={"interval": 60, "from": date_str, "till": date_str, "iss.meta": "off"},
            timeout=15,
        )
        resp.raise_for_status()
        candles = resp.json().get("candles", {})
        cols = candles.get("columns", [])
        rows = candles.get("data", [])
        if not cols or not rows:
            _evening_cache[key] = (None, None)
            return None, None
        idx = {c: i for i, c in enumerate(cols)}
        if not all(c in idx for c in ("begin", "high", "low", "end")):
            _evening_cache[key] = (None, None)
            return None, None

        highs, lows = [], []
        for row in rows:
            begin = row[idx["begin"]]
            if not begin:
                continue
            hour = int(begin[11:13])
            if hour < EVENING_FROM_HOUR:
                continue
            try:
                highs.append(float(row[idx["high"]]))
                lows.append(float(row[idx["low"]]))
            except (TypeError, ValueError):
                pass

        if not highs:
            _evening_cache[key] = (None, None)
            return None, None
        result = (max(highs), min(lows))
        _evening_cache[key] = result
        return result
    except requests.RequestException:
        _evening_cache[key] = (None, None)
        return None, None


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def _get_forts_metadata():
    """Справочник фьючерсов FORTS: {UPPER(SECID): {...}}.

    Нужен MINSTEP (пункты), STEPPRICE (рубли за шаг), LASTTRADEDATE (срок)
    и настоящий SECID: у Si он смешанного регистра (`SiZ6`), и по нему
    строятся адреса истории и свечей. Справочник большой и меняется редко,
    поэтому кэшируется на FUT_META_TTL.
    """
    now = time.time()
    cached = _forts_meta_cache["data"]
    if cached and now - _forts_meta_cache["ts"] < FUT_META_TTL:
        return cached
    try:
        resp = requests.get(_FUT_META_URL, params={"iss.meta": "off"}, timeout=20)
        resp.raise_for_status()
        table = resp.json().get("securities")
        if not table or not table.get("data"):
            return cached
        cols = table["columns"]
        idx = {c: i for i, c in enumerate(cols)}

        def cell(row, name):
            i = idx.get(name)
            return row[i] if i is not None else None

        out = {}
        for row in table["data"]:
            secid = cell(row, "SECID")
            if not secid:
                continue
            step = _to_float(cell(row, "MINSTEP"))
            if not (step > 0):
                step = 1.0
            price_step = _to_float(cell(row, "STEPPRICE"))
            if not (price_step > 0):
                price_step = 0.0
            out[str(secid).upper()] = {
                "secid": str(secid),
                "name": cell(row, "SHORTNAME") or secid,
                "step": step,
                "step_price": price_step,
                "expires": cell(row, "LASTTRADEDATE"),
            }
        _forts_meta_cache["ts"] = now
        _forts_meta_cache["data"] = out
        return out
    except requests.RequestException:
        return cached


def _fetch_fort_day(secid, date_str):
    """Строка дневной истории фьючерса за дату.

    Возвращает (row, ok): ok=False — запрос к ISS не удался, и тогда
    контракт нельзя считать просроченным, даже если строки нет.
    Только `from`/`till`: параметр `date` у этого эндпоинта игнорируется
    и возвращает историю с начала торгов контракта.
    """
    try:
        resp = requests.get(
            _FUT_HISTORY_URL.format(secid=secid),
            params={"from": date_str, "till": date_str, "iss.meta": "off"},
            timeout=20,
        )
        resp.raise_for_status()
        hist = resp.json().get("history") or {}
        cols = hist.get("columns") or []
        rows = hist.get("data") or []
        if not cols or not rows:
            return None, True
        idx = {c: i for i, c in enumerate(cols)}

        def cell(row, name):
            i = idx.get(name)
            return row[i] if i is not None else None

        row = rows[0]
        return {
            "secid": cell(row, "SECID") or secid,
            "name": cell(row, "SHORTNAME"),
            "open": _to_float(cell(row, "OPEN")),
            "high": _to_float(cell(row, "HIGH")),
            "low": _to_float(cell(row, "LOW")),
            "close": _to_float(cell(row, "CLOSE")),
            "volume": _to_float(cell(row, "VOLUME")),
            "value": _to_float(cell(row, "VALUE")),
        }, True
    except requests.RequestException:
        return None, False


def scan_futures(tickers, date):
    """ATR-скан фьючерсов из вочлиста за дату.

    Порог ATR и фильтры ликвидности к фьючерсам не применяются: контракт
    из вочлиста попадает в результат всегда, если за дату есть торговые
    данные. Направление — CLOSE к OPEN, как у акций.

    Просроченные контракты (срок раньше даты скана) и неизвестные тикеры
    уходят в `removed` — клиент убирает их из вочлиста. Живой контракт без
    данных за выбранную дату попадает в `no_data` и остаётся в вочлисте.
    """
    wanted = []
    seen = set()
    for t in tickers or []:
        norm = str(t or "").strip().upper()
        if not norm or norm in seen or not _TICKER_RE.match(norm):
            continue
        seen.add(norm)
        wanted.append(norm)
        if len(wanted) >= MAX_FUTURES:
            break

    if not wanted:
        return {"results": [], "removed": [], "no_data": []}

    if _evening_cache and next(iter(_evening_cache))[0] != date:
        _evening_cache.clear()

    meta = _get_forts_metadata()
    results = []
    removed = []
    no_data = []

    for ticker in wanted:
        info = meta.get(ticker) or {}
        secid = info.get("secid") or ticker
        row, ok = _fetch_fort_day(secid, date)
        expires = info.get("expires")

        if not ok:
            no_data.append({"ticker": ticker, "reason": "ISS не ответил"})
            continue

        high = row["high"] if row else float("nan")
        low = row["low"] if row else float("nan")
        close = row["close"] if row else float("nan")
        open_ = row["open"] if row else float("nan")

        if not row or not (high > 0) or not (low > 0) or not (close > 0):
            # Справочник не получен — виноват ISS, а не контракт: ничего
            # не удаляем, иначе сетевая ошибка вычистила бы вочлист.
            if not meta:
                no_data.append({"ticker": ticker, "reason": "справочник ISS недоступен"})
            elif not info:
                removed.append({"ticker": ticker, "reason": "контракт не найден"})
            elif expires and expires < date:
                removed.append({"ticker": ticker, "reason": "истёк " + expires})
            else:
                no_data.append({"ticker": ticker, "reason": "нет данных за " + date})
            continue

        if open_ > 0 and close > open_:
            direction = "buy"
        elif open_ > 0 and close < open_:
            direction = "sell"
        else:
            direction = None

        step = info.get("step") or 1.0
        step_price = info.get("step_price") or 0.0
        atr_points = (high - low) / step if step else 0.0
        evening_high, evening_low = _fetch_evening_session(date, secid, _FUT_CANDLES_URL)

        results.append({
            "ticker": ticker,
            "name": info.get("name") or row["name"] or ticker,
            "step": round(step, 6),
            "step_price": round(step_price, 6),
            "atr_points": round(atr_points, 2),
            "atr_rub": round(atr_points * step_price, 2),
            "atr_pct": round((high - low) / close * 100, 2),
            "close": round(close, 4),
            "high": round(high, 4),
            "low": round(low, 4),
            "evening_high": round(evening_high, 4) if evening_high is not None else None,
            "evening_low": round(evening_low, 4) if evening_low is not None else None,
            "value": row["value"] if row["value"] == row["value"] else None,
            "direction": direction,
            "expires": expires,
        })

    results.sort(key=lambda r: r["atr_points"], reverse=True)
    return {"results": results, "removed": removed, "no_data": no_data}


def scan_atr(atr_threshold, date=None, futures=None):
    """
    Выполняет ATR-скрининг акций и фьючерсов из вочлиста.

    Возвращает dict:
        {
          "date": "...",
          "threshold": ...,
          "results": [ {ticker, name, atr_points, atr_pct, close, high, low,
                        evening_high, evening_low, value, direction} ],
          "futures": {"results": [...], "removed": [...], "no_data": [...]}
        }
    direction: "buy" (CLOSE > OPEN), "sell" (CLOSE < OPEN), None (равно).

    `futures` — тикеры контрактов FORTS из вочлиста. Они считаются всегда,
    без порога ATR: у фьючерсов пункты разных контрактов несопоставимы,
    и фильтровать их тем же числом, что акции, бессмысленно.
    """
    try:
        atr_threshold = float(atr_threshold)
    except (TypeError, ValueError):
        atr_threshold = 0.0

    if date:
        target_date = date
    else:
        target_date = get_last_trading_day()
        if not target_date:
            return {"error": "Не удалось определить последний торговый день"}

    fut_block = None
    if futures:
        try:
            fut_block = scan_futures(futures, target_date)
        except Exception as e:  # фьючерсы не должны ронять скан акций
            fut_block = {"error": str(e), "results": [], "removed": [], "no_data": []}

    columns, rows = _fetch_moex_history(target_date)
    if not columns or not rows:
        result = {"error": f"Нет данных торгов за {target_date}", "date": target_date}
        if fut_block is not None:
            result["futures"] = fut_block
        return result

    if _evening_cache and next(iter(_evening_cache))[0] != target_date:
        _evening_cache.clear()

    col_idx = {c: i for i, c in enumerate(columns)}

    def col(row, name):
        i = col_idx.get(name)
        return row[i] if i is not None else None

    # Метаданные: MINSTEP и множество обычных/привилегированных акций (EQIN)
    step_dict, equity_secids = _get_minstep_metadata()
    keep_all = not equity_secids  # при сбое метаданных не отсеиваем ничего

    selected = []
    for row in rows:
        secid = col(row, "SECID")
        if not secid:
            continue
        # Оставляем только акции (EQIN); ETF/ПИФы, облигации и депорасписки
        # отсекаем ещё до подсчёта ATR
        if not keep_all and secid not in equity_secids:
            continue

        close = _to_float(col(row, "CLOSE"))
        open_ = _to_float(col(row, "OPEN"))
        high = _to_float(col(row, "HIGH"))
        low = _to_float(col(row, "LOW"))
        volume = _to_float(col(row, "VOLUME"))
        value = _to_float(col(row, "VALUE"))

        # Фильтры ликвидности (все кроме ATR)
        if not (close > 0):
            continue
        if not (volume > 0):
            continue
        if not (value >= MIN_VALUE_RUB):
            continue

        step = step_dict.get(secid, 1.0)
        atr_points = (high - low) / step if step else 0.0
        if atr_points <= atr_threshold:
            continue

        if close > open_:
            direction = "buy"
        elif close < open_:
            direction = "sell"
        else:
            direction = None

        atr_pct = (high - low) / close * 100 if close else 0.0
        selected.append({
            "secid": secid,
            "name": col(row, "SHORTNAME") or secid,
            "step": step,
            "close": close,
            "atr_points": atr_points,
            "atr_pct": atr_pct,
            "high": high,
            "low": low,
            "value": value,
            "direction": direction,
        })

    results = []
    with ThreadPoolExecutor(max_workers=EVENING_WORKERS) as pool:
        pending = {
            pool.submit(_fetch_evening_session, target_date, s["secid"]): s
            for s in selected
        }
        for fut in as_completed(pending):
            s = pending[fut]
            evening_high, evening_low = fut.result()
            results.append({
                "ticker": s["secid"],
                "name": s["name"],
                "step": round(s["step"], 6),
                "atr_points": round(s["atr_points"], 2),
                "atr_pct": round(s["atr_pct"], 2),
                "close": round(s["close"], 2),
                "high": round(s["high"], 2),
                "low": round(s["low"], 2),
                "evening_high": round(evening_high, 2) if evening_high is not None else None,
                "evening_low": round(evening_low, 2) if evening_low is not None else None,
                "value": s["value"],
                "direction": s["direction"],
            })

    results.sort(key=lambda r: r["atr_points"], reverse=True)
    result = {
        "date": target_date,
        "threshold": atr_threshold,
        "results": results,
    }
    if fut_block is not None:
        result["futures"] = fut_block
    return result
