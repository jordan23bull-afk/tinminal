from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional


@dataclass
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    def to_dict(self):
        return {
            "time": self.time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume
        }


@dataclass
class HistoryRequest:
    source: str = "moex"
    symbol: str = "BTCUSDT"
    timeframe: str = "1h"
    limit: int = 500
    indicators: Dict[str, Any] = field(default_factory=dict)


@dataclass
class HistoryResponse:
    symbol: str
    timeframe: str
    candles: List[Dict[str, Any]]
    indicators: Dict[str, List[Dict[str, Any]]]

    def to_dict(self):
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "candles": self.candles,
            "indicators": self.indicators
        }
