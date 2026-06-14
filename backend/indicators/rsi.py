import pandas as pd
import numpy as np
import sys
import os
from typing import List, Dict, Any, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.interfaces import IIndicator
from core.registry import ModuleRegistry


class RSIIndicator(IIndicator):
    @property
    def name(self):
        return "rsi"

    @property
    def parameters(self):
        return {"period": 14, "source": "close"}

    @property
    def output_schema(self):
        return {"rsi": "float"}

    def calculate(self, candles: List[Dict[str, Any]], params: Optional[Dict[str, Any]] = None) -> Dict[str, List[Dict[str, Any]]]:
        cfg = {**self.parameters, **(params or {})}
        period = int(cfg["period"])
        source = cfg["source"]

        df = pd.DataFrame(candles)
        delta = df[source].diff()

        gain = delta.where(delta > 0, 0.0)
        loss = -delta.where(delta < 0, 0.0)

        avg_gain = gain.ewm(alpha=1/period, min_periods=period).mean()
        avg_loss = loss.ewm(alpha=1/period, min_periods=period).mean()

        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))

        result = []
        for i, val in rsi.items():
            if pd.notna(val):
                result.append({"time": int(df.loc[i, "time"]), "value": round(val, 2)})

        return {"rsi": result}


ModuleRegistry.register_indicator(RSIIndicator)
