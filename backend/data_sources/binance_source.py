import time
import json
import threading
import requests
import websocket
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.interfaces import IDataSource
from core.registry import ModuleRegistry


class BinanceDataSource(IDataSource):
    @property
    def name(self):
        return "binance"

    @property
    def supported_timeframes(self):
        return ["1m", "5m", "15m", "1h", "4h", "1d"]

    def get_historical_data(self, symbol, timeframe, limit=500):
        url = "https://api.binance.com/api/v3/klines"
        res = requests.get(url, params={"symbol": symbol.upper(), "interval": timeframe, "limit": limit})
        res.raise_for_status()
        return [
            {
                "time": int(k[0] / 1000),
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "volume": float(k[5])
            }
            for k in res.json()
        ]

    def subscribe_realtime(self, symbol, timeframe, callback):
        def ws_thread():
            stream = f"{symbol.lower()}@kline_{timeframe}"

            def on_message(ws, msg):
                data = json.loads(msg)
                if "k" in data:
                    k = data["k"]
                    callback({
                        "time": int(k["t"] / 1000),
                        "open": float(k["o"]),
                        "high": float(k["h"]),
                        "low": float(k["l"]),
                        "close": float(k["c"]),
                        "volume": float(k["v"])
                    })

            ws = websocket.WebSocketApp(
                f"wss://stream.binance.com:9443/ws/{stream}",
                on_message=on_message
            )
            ws.run_forever(ping_interval=20, ping_timeout=10)

        threading.Thread(target=ws_thread, daemon=True).start()
        return True

    def unsubscribe_realtime(self, s, t):
        return True


ModuleRegistry.register_data_source(BinanceDataSource)
