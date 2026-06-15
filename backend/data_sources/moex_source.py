import time
import threading
import requests
import sys
import os
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Callable

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.interfaces import IDataSource
from core.registry import ModuleRegistry

TF_MAP = {
    "1m": "1", "5m": "5", "15m": "15",
    "1h": "60", "4h": "240", "1d": "24",
}

TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}

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
        return ["1m", "5m", "15m", "1h", "4h", "1d"]

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

    def get_historical_data(self, symbol, timeframe, limit=500):
        ticker = self._resolve_ticker(symbol)
        interval = TF_MAP.get(timeframe, "60")
        tf_sec = TF_SECONDS.get(timeframe, 3600)

        now = datetime.now(timezone.utc)
        from_date = (now - timedelta(seconds=limit * tf_sec)).strftime("%Y-%m-%d")
        to_date = now.strftime("%Y-%m-%d")

        try:
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

            if not all_candles:
                return []

            result = []
            for row in all_candles:
                result.append({
                    "time": int(datetime.fromisoformat(row["begin"].replace("Z", "+00:00")).timestamp()),
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
        last_broadcast = {"time": 0, "close": 0, "volume": 0}

        def stream():
            while not stop_event.is_set():
                try:
                    now = datetime.now(timezone.utc)
                    from_time = now - timedelta(seconds=interval_sec * 2)

                    url = (
                        f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/"
                        f"securities/{ticker}/candles.json"
                        f"?from={from_time.strftime('%Y-%m-%d')}"
                        f"&till={now.strftime('%Y-%m-%d')}"
                        f"&interval={interval}&iss.meta=off&iss.json=extended"
                    )

                    resp = requests.get(url, timeout=10)
                    resp.raise_for_status()
                    data = resp.json()

                    if isinstance(data, list) and len(data) >= 2:
                        candles = data[1].get("candles", [])
                        if candles:
                            row = candles[-1]
                            candle_time = int(datetime.fromisoformat(row["begin"].replace("Z", "+00:00")).timestamp())
                            close = float(row["close"])
                            volume = int(row["volume"])
                            if candle_time != last_broadcast["time"] or close != last_broadcast["close"] or volume != last_broadcast["volume"]:
                                last_broadcast["time"] = candle_time
                                last_broadcast["close"] = close
                                last_broadcast["volume"] = volume
                                callback({
                                    "time": candle_time,
                                    "open": float(row["open"]),
                                    "high": float(row["high"]),
                                    "low": float(row["low"]),
                                    "close": close,
                                    "volume": volume,
                                })
                except Exception as e:
                    print(f"[MOEX] Poll error: {e}")

                stop_event.wait(5)

        threading.Thread(target=stream, daemon=True).start()
        return True

    def unsubscribe_realtime(self, symbol, timeframe):
        key = (symbol, timeframe)
        event = self._stop_events.pop(key, None)
        if event:
            event.set()
        return True


ModuleRegistry.register_data_source(MoexSource)
