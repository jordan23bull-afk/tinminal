"""
ATR-скринер MOEX.

Загружает дневную историю торгов с MOEX ISS, фильтрует по ликвидности
и заданному порогу ATR (в пунктах), определяет направление дня
(покупной/продажный) и возвращает результат для простановки флажков.

Источник логики: E:\\atrnew\\atr150.py (переписано без pandas).
"""

import time
from datetime import datetime, timedelta

import requests

MIN_VALUE_RUB = 10_000_000   # минимальный дневной оборот, руб.
EXCLUDE_ETF = True           # отсекать биржевые фонды (ETF/БПИФ)

_BOARD = "TQBR"

_HISTORY_URL = (
    "https://iss.moex.com/iss/history/engines/stock/"
    "markets/shares/boards/{board}/securities.json"
)
_META_URL = (
    "https://iss.moex.com/iss/engines/stock/markets/shares/"
    "boards/{board}/securities.json"
)


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
    """Возвращает (step_dict, etf_secids)."""
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
        etf_secids = set()
        for row in sec_table["data"]:
            secid = row[idx["SECID"]]
            try:
                step = float(row[idx[step_col]])
            except (TypeError, ValueError):
                step = 1.0
            step_dict[secid] = step if step else 1.0
            instr = row[idx["INSTRID"]] if "INSTRID" in idx else ""
            if instr == "IFTF":
                etf_secids.add(secid)
        return step_dict, etf_secids
    except requests.RequestException:
        return {}, set()


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def scan_atr(atr_threshold, date=None):
    """
    Выполняет ATR-скрининг.

    Возвращает dict:
        {
          "date": "...",
          "threshold": ...,
          "results": [ {ticker, name, atr_points, atr_pct, close, value, direction} ]
        }
    direction: "buy" (CLOSE > OPEN), "sell" (CLOSE < OPEN), None (равно).
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

    columns, rows = _fetch_moex_history(target_date)
    if not columns or not rows:
        return {"error": f"Нет данных торгов за {target_date}", "date": target_date}

    col_idx = {c: i for i, c in enumerate(columns)}

    def col(row, name):
        i = col_idx.get(name)
        return row[i] if i is not None else None

    # Метаданные: MINSTEP и множество ETF
    step_dict, etf_secids = _get_minstep_metadata()

    results = []
    for row in rows:
        secid = col(row, "SECID")
        if not secid:
            continue
        if EXCLUDE_ETF and secid in etf_secids:
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
        results.append({
            "ticker": secid,
            "name": col(row, "SHORTNAME") or secid,
            "atr_points": round(atr_points, 2),
            "atr_pct": round(atr_pct, 2),
            "close": round(close, 2),
            "value": value,
            "direction": direction,
        })

    results.sort(key=lambda r: r["atr_points"], reverse=True)
    return {
        "date": target_date,
        "threshold": atr_threshold,
        "results": results,
    }
