from abc import ABC, abstractmethod
from typing import List, Dict, Any, Callable


class IDataSource(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @property
    @abstractmethod
    def supported_timeframes(self) -> List[str]:
        pass

    @abstractmethod
    def get_historical_data(self, symbol: str, timeframe: str, limit: int = 500) -> List[Dict[str, Any]]:
        pass

    @abstractmethod
    def subscribe_realtime(self, symbol: str, timeframe: str, callback: Callable[[Dict], None]) -> bool:
        pass

    @abstractmethod
    def unsubscribe_realtime(self, symbol: str, timeframe: str) -> bool:
        pass
