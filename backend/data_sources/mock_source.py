import time
import random
import threading
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.interfaces import IDataSource
from core.registry import ModuleRegistry

TIMEFRAME_SECONDS = {
    "1m": 60, "5m": 300, "15m": 900,
    "1h": 3600, "2h": 7200, "3h": 10800,
    "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000
}


class MockDataSource(IDataSource):
    @property
    def name(self):
        return "mock"

    @property
    def supported_timeframes(self):
        return ["1m", "5m", "15m", "1h", "2h", "3h", "4h", "1d", "1w", "1M"]

    def get_historical_data(self, symbol, timeframe, limit=500):
        candles = []
        tf_seconds = TIMEFRAME_SECONDS.get(timeframe, 3600)
        t = int(time.time()) - limit * tf_seconds
        price = 40000.0

        for _ in range(limit):
            o = price
            c = price + random.uniform(-500, 500)
            h = max(o, c) + random.uniform(0, 100)
            l = min(o, c) - random.uniform(0, 100)
            candles.append({
                "time": t,
                "open": round(o, 2),
                "high": round(h, 2),
                "low": round(l, 2),
                "close": round(c, 2),
                "volume": round(random.uniform(10, 500), 2)
            })
            t += tf_seconds
            price = c
        return candles

    def subscribe_realtime(self, symbol, timeframe, callback):
        def stream():
            price = 40000.0
            interval = 2  # Update every 2 seconds for demo
            while True:
                time.sleep(interval)
                c = price + random.uniform(-200, 200)
                now = int(time.time())
                callback({
                    "time": now,
                    "open": round(price, 2),
                    "high": round(max(price, c) + random.uniform(0, 50), 2),
                    "low": round(min(price, c) - random.uniform(0, 50), 2),
                    "close": round(c, 2),
                    "volume": round(random.uniform(5, 100), 2)
                })
                price = c

        threading.Thread(target=stream, daemon=True).start()
        return True

    def unsubscribe_realtime(self, s, t):
        return True


ModuleRegistry.register_data_source(MockDataSource)
