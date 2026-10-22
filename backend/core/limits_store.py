"""Хранилище счётчиков лимитера запросов в файле.

По умолчанию flask-limiter держит счётчики в памяти процесса: они
сбрасываются при перезапуске сервера, и при нескольких процессах
лимит считается для каждого отдельно. Полноценные бэкенды требуют
Redis или MongoDB, а здесь нужен только локальный сервер.

Поэтому берём штатное хранилище в памяти и сохраняем его состояние
в файл: счётчики и сроки их действия. Счётчики устаревших ключей
в файл не попадают.
"""

import json
import os
import threading
import time

from limits.storage.memory import MemoryStorage

FILE_SCHEME = "file"


class FileStorage(MemoryStorage):
    """Счётчики лимита, которые переживают перезапуск сервера."""

    STORAGE_SCHEME = [FILE_SCHEME]

    def __init__(self, uri=None, wrap_exceptions=False, **kwargs):
        super().__init__(uri=uri, wrap_exceptions=wrap_exceptions, **kwargs)
        self._path = self._path_from_uri(uri)
        self._file_lock = threading.RLock()
        self._dirty = False
        self._load()

    @staticmethod
    def _path_from_uri(uri):
        if not uri:
            return None
        # file:///C:/path/db.json и file:///home/user/db.json
        raw = str(uri)
        if raw.startswith(FILE_SCHEME + "://"):
            raw = raw[len(FILE_SCHEME) + 3:]
        elif raw.startswith(FILE_SCHEME + ":///"):
            raw = raw[len(FILE_SCHEME) + 3:]
        return raw or None

    def _load(self):
        if not self._path or not os.path.exists(self._path):
            return
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return
        now = time.time()
        with self._file_lock:
            for key, item in (data.get("counters") or {}).items():
                expires = item.get("expires", 0)
                if expires <= now:
                    continue
                count = int(item.get("count", 0))
                if count <= 0:
                    continue
                self.storage[key] = count
                self.expirations[key] = expires

    def _flush(self):
        if not self._path or not self._dirty:
            return
        now = time.time()
        counters = {
            key: {"count": int(self.storage[key]), "expires": self.expirations.get(key, 0)}
            for key in list(self.storage.keys())
            if self.expirations.get(key, 0) > now and self.storage.get(key, 0) > 0
        }
        tmp = self._path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"counters": counters}, f)
            os.replace(tmp, self._path)
            self._dirty = False
        except Exception:
            # Лимитер не должен ронять запросы из-за файла счётчиков.
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass

    def incr(self, key, expiry, amount=1):
        value = super().incr(key, expiry, amount)
        with self._file_lock:
            self._dirty = True
        self._flush()
        return value

    def decr(self, key, amount=1):
        value = super().decr(key, amount)
        with self._file_lock:
            self._dirty = True
        self._flush()
        return value

    def clear(self, key):
        super().clear(key)
        with self._file_lock:
            self._dirty = True
        self._flush()

    def reset(self):
        count = super().reset()
        with self._file_lock:
            self._dirty = True
        self._flush()
        return count