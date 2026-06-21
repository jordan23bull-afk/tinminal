import os
import importlib
import logging
import threading
from typing import Type, List

from core.interfaces import IDataSource, IIndicator

logger = logging.getLogger(__name__)


class ModuleRegistry:
    _data_sources = {}
    _indicators = {}
    _source_instances = {}
    _lock = threading.Lock()

    @classmethod
    def register_data_source(cls, cls_type: Type[IDataSource]):
        name = cls_type.name.fget(None) if isinstance(cls_type.name, property) else cls_type.name
        cls._data_sources[name] = cls_type
        logger.info(f"[Registry] Data source loaded: {name}")

    @classmethod
    def register_indicator(cls, cls_type: Type[IIndicator]):
        name = cls_type.name.fget(None) if isinstance(cls_type.name, property) else cls_type.name
        cls._indicators[name] = cls_type
        logger.info(f"[Registry] Indicator loaded: {name}")

    @classmethod
    def auto_load(cls, directory: str, prefix: str):
        if not os.path.isdir(directory):
            return
        for f in os.listdir(directory):
            if f.endswith(".py") and not f.startswith("_"):
                try:
                    full_module = f"{prefix}.{f[:-3]}"
                    mod = importlib.import_module(full_module)
                    for attr in dir(mod):
                        obj = getattr(mod, attr)
                        if isinstance(obj, type):
                            if issubclass(obj, IDataSource) and obj is not IDataSource:
                                cls.register_data_source(obj)
                            elif issubclass(obj, IIndicator) and obj is not IIndicator:
                                cls.register_indicator(obj)
                except Exception as e:
                    logger.error(f"Failed to load {f}: {e}")

    @classmethod
    def get_data_source(cls, name: str) -> IDataSource:
        if name not in cls._data_sources:
            raise ValueError(f"Unknown data source: {name}")
        with cls._lock:
            if name not in cls._source_instances:
                cls._source_instances[name] = cls._data_sources[name]()
            return cls._source_instances[name]

    @classmethod
    def get_indicator(cls, name: str) -> IIndicator:
        if name not in cls._indicators:
            raise ValueError(f"Unknown indicator: {name}")
        return cls._indicators[name]()

    @classmethod
    def list_data_sources(cls) -> List[str]:
        return list(cls._data_sources.keys())

    @classmethod
    def list_indicators(cls) -> List[str]:
        return list(cls._indicators.keys())
