import os
import sys
import time
import tempfile
import threading  # noqa: F401  (app.py импорт-сайд-эффект не нужен)

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import core.database as db


def fresh_db():
    tmp = tempfile.mkdtemp(prefix="candles_test_")
    db.DB_PATH = os.path.join(tmp, "candles.db")
    if hasattr(db._local, "conn"):
        db._local.conn = None
    db._get_conn()
    return tmp


def row(t, sym="TEST", tf="1m"):
    return (sym, tf, int(t), 1.0, 1.0, 1.0, 1.0, 1)


# 1) prune_candles
tmp = fresh_db()
now = time.time()
day = 86400
conn = db._get_conn()
conn.executemany(
    "INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?)",
    [
        row(now - 200 * day),                      # m1 old -> delete
        row(now - 95 * day),                       # m1 old -> delete
        row(now - 10 * day),                       # m1 fresh -> keep
        row(now - 500 * day, tf="1d"),             # 1d old -> delete
        row(now - 100 * day, tf="1d"),             # 1d keep
    ],
)
conn.commit()
deleted = db.prune_candles()
left = conn.execute("SELECT timeframe, COUNT(*) FROM candles GROUP BY timeframe").fetchall()
assert deleted == 3, f"prune deleted={deleted}, expected 3"
assert dict(left) == {"1m": 1, "1d": 1}, f"left={left}"
print("prune OK")

# 2) _market_open (МСК = UTC+3, без DST)
from data_sources import tinkoff_source as ts
import datetime as dt


def utc(y, mo, d, h, mi):
    return int(dt.datetime(y, mo, d, h, mi, tzinfo=dt.timezone.utc).timestamp())


# 2026-09-10 — четверг
assert ts._market_open(utc(2026, 9, 10, 9, 0)) is True        # 12:00 МСК сессия
assert ts._market_open(utc(2026, 9, 10, 4, 0)) is True        # 07:00 МСК начало
assert ts._market_open(utc(2026, 9, 10, 3, 59)) is False      # 06:59 МСК
assert ts._market_open(utc(2026, 9, 10, 20, 45)) is True      # 23:45 МСК вечерка
assert ts._market_open(utc(2026, 9, 10, 20, 55)) is False     # 23:55 МСК закрыто
assert ts._market_open(utc(2026, 9, 12, 9, 0)) is False       # суббота
assert ts._market_open(utc(2026, 9, 13, 9, 0)) is False       # воскресенье
print("_market_open OK")

# 3) политика кэша get_historical_data: ни одного сетевого вызова на fresh/closed
src = ts.TinkoffSource()


def no_net(*a, **k):
    raise AssertionError("network hit on cached path")


src._resolve = no_net
src._get_channel = no_net

conn.execute("DELETE FROM candles WHERE symbol='TEST'")
conn.commit()

# 3a) свежий M1 (gap 120с <= 300)
conn.execute("INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?)", row(now - 120))
conn.commit()
out = src.get_historical_data("TEST", "1m", limit=50)
assert len(out) == 1 and out[0]["close"] == 1.0, out
print("cache fresh OK")

# 3b) старый бар + закрытый рынок (gap 2d > 300) -> serving из DB
conn.execute("DELETE FROM candles WHERE symbol='TEST'")
conn.execute("INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?)", row(now - 2 * day + 300))
conn.commit()
orig_open = ts._market_open
ts._market_open = lambda ts_: False
try:
    out = src.get_historical_data("TEST", "1m", limit=50)
finally:
    ts._market_open = orig_open
assert out, "closed-market path must serve DB"
print("cache closed-market OK")

# 3c) анти-шторм: сразу после неудачного свежего фетча — не лезем в API повторно
src._hist_fetched_at[("TEST", "1m")] = int(time.time())
try:
    out = src.get_historical_data("TEST", "1m", limit=50)
    assert out, "throttled path must serve DB"
    print("cache throttle OK")
except AssertionError as e:
    if "network hit" in str(e):
        raise
    raise
print("ALL CHECKS OK")
