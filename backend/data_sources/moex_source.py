import threading
import requests
import sys
import os
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.interfaces import IDataSource
from core.registry import ModuleRegistry

TF_MAP = {
    "1m": "1", "10m": "10",
    "1h": "60", "1d": "24",
}

TF_SECONDS = {"1m": 60, "10m": 600, "1h": 3600, "1d": 86400}

MOEX_TICKERS = {
    "SBER": "SBER", "GAZP": "GAZP", "LKOH": "LKOH",
    "YDEX": "YDEX", "GMKN": "GMKN", "ROSN": "ROSN",
    "SNGS": "SNGS", "VTBR": "VTBR", "TCSG": "TCSG",
    "PHOR": "PHOR", "SBERP": "SBERP", "GMKNP": "GMKNP",
}


class MoexSource(IDataSource):
    def __init__(self):
        self._stop_events = {}

    @property
    def name(self):
        return "moex"

    @property
    def supported_timeframes(self):
        return ["1m", "10m", "1h", "1d"]

    def _resolve_ticker(self, symbol):
        symbol = symbol.upper()
        if symbol in MOEX_TICKERS:
            return MOEX_TICKERS[symbol]
        return symbol

    def _fetch_candles(self, ticker, interval, from_date, to_date, start=0):
        url = (
            f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/"
            f"securities/{ticker}/candles.json"
            f"?from={from_date}&till={to_date}"
            f"&interval={interval}&start={start}&iss.meta=off&iss.json=extended"
        )
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list) or len(data) < 2:
            return []
        return data[1].get("candles", [])

    def _fetch_all_candles(self, ticker, interval, from_date, to_date):
        all_candles = []
        start = 0
        while True:
            batch = self._fetch_candles(ticker, interval, from_date, to_date, start)
            if not batch:
                break
            all_candles.extend(batch)
            if len(batch) < 500:
                break
            start += 500
        return all_candles

    def get_historical_data(self, symbol, timeframe, limit=500):
        ticker = self._resolve_ticker(symbol)
        interval = TF_MAP.get(timeframe, "60")
        tf_sec = TF_SECONDS.get(timeframe, 3600)

        now = datetime.now(timezone.utc)
        from_date = (now - timedelta(seconds=limit * tf_sec)).strftime("%Y-%m-%d")
        to_date = now.strftime("%Y-%m-%d")

        try:
            all_candles = self._fetch_all_candles(ticker, interval, from_date, to_date)

            if not all_candles:
                return []

            result = []
            for row in all_candles:
                dt_naive = datetime.strptime(row["begin"], "%Y-%m-%d %H:%M:%S")
                result.append({
                    "time": int(dt_naive.replace(tzinfo=timezone.utc).timestamp()),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": int(row["volume"]),
                })

            return result[-limit:] if len(result) > limit else result

        except Exception as e:
            print(f"[MOEX] Error fetching candles for {ticker}: {e}")
            raise

    def subscribe_realtime(self, symbol, timeframe, callback):
        ticker = self._resolve_ticker(symbol)
        interval = TF_MAP.get(timeframe, "60")
        interval_sec = TF_SECONDS.get(timeframe, 3600)
        key = (symbol, timeframe)

        if key in self._stop_events:
            return True

        stop_event = threading.Event()
        self._stop_events[key] = stop_event
        last_broadcast = {"time": 0, "price": 0, "volume": 0}
        current_candle = {"open": None, "high": None, "low": None, "volume": 0}

        def get_candle_time():
            now_utc = datetime.now(timezone.utc)
            now_msk = now_utc + timedelta(hours=3)
            if interval_sec >= 3600:
                aligned = now_msk.replace(minute=0, second=0, microsecond=0)
            else:
                msk_minutes = now_msk.hour * 60 + now_msk.minute
                aligned_minutes = msk_minutes - (msk_minutes % (interval_sec // 60))
                h = aligned_minutes // 60
                m = aligned_minutes % 60
                aligned = now_msk.replace(hour=h, minute=m, second=0, microsecond=0)
            return int(aligned.replace(tzinfo=timezone.utc).timestamp())

        def stream():
            print(f"[MOEX] Stream started for {ticker} {timeframe}")
            while not stop_event.is_set():
                try:
                    url = (
                        f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/"
                        f"securities/{ticker}.json"
                        f"?iss.meta=off"
                    )

                    resp = requests.get(url, timeout=5)
                    resp.raise_for_status()
                    data = resp.json()

                    if isinstance(data, dict):
                        md_list = data.get("marketdata", {}).get("data", [])
                        md_cols = data.get("marketdata", {}).get("columns", [])
                    else:
                        md_list = []
                        md_cols = []

                    if md_list and md_cols:
                        row = md_list[0]
                        last_idx = md_cols.index("LAST") if "LAST" in md_cols else None
                        open_idx = md_cols.index("OPEN") if "OPEN" in md_cols else None
                        high_idx = md_cols.index("HIGH") if "HIGH" in md_cols else None
                        low_idx = md_cols.index("LOW") if "LOW" in md_cols else None
                        vol_idx = md_cols.index("VOLTODAY") if "VOLTODAY" in md_cols else None

                        if last_idx is not None and row[last_idx] is not None:
                            price = float(row[last_idx])
                            open_price = float(row[open_idx]) if open_idx is not None and row[open_idx] is not None else price
                            high = float(row[high_idx]) if high_idx is not None and row[high_idx] is not None else price
                            low = float(row[low_idx]) if low_idx is not None and row[low_idx] is not None else price
                            volume = int(row[vol_idx]) if vol_idx is not None and row[vol_idx] is not None else 0

                            candle_time = get_candle_time()

                            if candle_time != last_broadcast["time"]:
                                current_candle["open"] = price
                                current_candle["high"] = price
                                current_candle["low"] = price
                                current_candle["volume"] = 0
                            else:
                                if current_candle["high"] is None or price > current_candle["high"]:
                                    current_candle["high"] = price
                                if current_candle["low"] is None or price < current_candle["low"]:
                                    current_candle["low"] = price

                            current_candle["volume"] = volume

                            if candle_time != last_broadcast["time"] or price != last_broadcast["price"] or volume != last_broadcast["volume"]:
                                last_broadcast["time"] = candle_time
                                last_broadcast["price"] = price
                                last_broadcast["volume"] = volume
                                callback({
                                    "time": candle_time,
                                    "open": current_candle["open"],
                                    "high": current_candle["high"],
                                    "low": current_candle["low"],
                                    "close": price,
                                    "volume": current_candle["volume"],
                                })
                                print(f"[MOEX] {ticker}: {price} @ {candle_time} (H={current_candle['high']} L={current_candle['low']})")
                            else:
                                print(f"[MOEX] {ticker}: no change, last={price}")
                        else:
                            print(f"[MOEX] {ticker}: price data unavailable (market closed?)")
                    else:
                        print(f"[MOEX] {ticker}: no market data returned")
                except Exception as e:
                    print(f"[MOEX] Poll error for {ticker}: {e}")

                stop_event.wait(3)

        threading.Thread(target=stream, daemon=True).start()
        return True

    def get_prices(self, symbols):
        tickers = [self._resolve_ticker(s) for s in symbols]
        url = (
            f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/"
            f"securities.json?iss.meta=off&iss.json=extended"
            f"&securities={','.join(tickers)}"
        )
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        md_list = data[1].get("marketdata", [])
        result = {}
        for row in md_list:
            ticker = row.get("SECID")
            price = row.get("LAST")
            if not ticker or price is None:
                continue
            result[ticker] = {
                "price": float(price),
                "change": float(row["LASTCHANGE"]) if row.get("LASTCHANGE") is not None else None,
                "changePct": float(row["LASTTOPREVPRICE"]) if row.get("LASTTOPREVPRICE") is not None else None,
            }
        return result

    def unsubscribe_realtime(self, symbol, timeframe):
        key = (symbol, timeframe)
        event = self._stop_events.pop(key, None)
        if event:
            event.set()
        return True


ModuleRegistry.register_data_source(MoexSource)
