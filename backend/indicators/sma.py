import pandas as pd
import sys
import os
from typing import List, Dict, Any, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.interfaces import IIndicator
from core.registry import ModuleRegistry


class SMAIndicator(IIndicator):
    @property
    def name(self):
        return "sma"

    @property
    def parameters(self):
        return {"period": 50, "source": "close"}

    @property
    def output_schema(self):
        return {"sma": "float"}

    def calculate(self, candles: List[Dict[str, Any]], params: Optional[Dict[str, Any]] = None) -> Dict[str, List[Dict[str, Any]]]:
        cfg = {**self.parameters, **(params or {})}
        period = int(cfg["period"])
        source = cfg["source"]

        df = pd.DataFrame(candles)
        df["sma"] = df[source].rolling(window=period).mean()

        result = []
        for _, row in df.dropna(subset=["sma"]).iterrows():
            result.append({"time": int(row["time"]), "value": round(row["sma"], 2)})

        return {"sma": result}


ModuleRegistry.register_indicator(SMAIndicator)
