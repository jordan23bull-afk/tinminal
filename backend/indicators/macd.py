import pandas as pd
import numpy as np
import sys
import os
from typing import List, Dict, Any, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.interfaces import IIndicator
from core.registry import ModuleRegistry


class MACDIndicator(IIndicator):
    @property
    def name(self):
        return "macd"

    @property
    def parameters(self):
        return {"fast": 12, "slow": 26, "signal": 9, "source": "close"}

    @property
    def output_schema(self):
        return {"macd": "float", "macd_signal": "float", "macd_hist": "float"}

    def calculate(self, candles: List[Dict[str, Any]], params: Optional[Dict[str, Any]] = None) -> Dict[str, List[Dict[str, Any]]]:
        cfg = {**self.parameters, **(params or {})}
        fast = int(cfg["fast"])
        slow = int(cfg["slow"])
        signal_period = int(cfg["signal"])
        source = cfg["source"]

        df = pd.DataFrame(candles)

        ema_fast = df[source].ewm(span=fast, adjust=False).mean()
        ema_slow = df[source].ewm(span=slow, adjust=False).mean()
        macd_line = ema_fast - ema_slow
        signal_line = macd_line.ewm(span=signal_period, adjust=False).mean()
        histogram = macd_line - signal_line

        macd_data = []
        signal_data = []
        hist_data = []

        for i in range(len(df)):
            if pd.notna(macd_line.iloc[i]):
                t = int(df.iloc[i]["time"])
                macd_data.append({"time": t, "value": round(macd_line.iloc[i], 4)})
                signal_data.append({"time": t, "value": round(signal_line.iloc[i], 4)})
                hist_data.append({"time": t, "value": round(histogram.iloc[i], 4)})

        return {"macd": macd_data, "macd_signal": signal_data, "macd_hist": hist_data}


ModuleRegistry.register_indicator(MACDIndicator)
