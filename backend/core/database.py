import sqlite3
import os
import time
import logging
import threading

logger = logging.getLogger(__name__)

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "candles.db")

_local = threading.local()


def _get_conn():
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn.execute("""
            CREATE TABLE IF NOT EXISTS candles (
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                time INTEGER NOT NULL,
                open REAL, high REAL, low REAL, close REAL, volume INTEGER,
                PRIMARY KEY (symbol, timeframe, time)
            )
        """)
        _local.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_candles_lookup
            ON candles (symbol, timeframe, time)
        """)
        _local.conn.commit()
    return _local.conn


def save_candles(symbol, timeframe, candles):
    if not candles:
        return
    conn = _get_conn()
    conn.executemany(
        "INSERT OR REPLACE INTO candles (symbol, timeframe, time, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?)",
        [(symbol, timeframe, c["time"], c["open"], c["high"], c["low"], c["close"], c["volume"]) for c in candles]
    )
    conn.commit()
    logger.debug(f"[DB] Saved {len(candles)} candles for {symbol} {timeframe}")


def load_candles(symbol, timeframe, from_time=0, to_time=float("inf"), limit=1000):
    conn = _get_conn()
    query = "SELECT time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? AND time>=? AND time<=? ORDER BY time"
    rows = conn.execute(query, (symbol, timeframe, from_time, to_time)).fetchall()
    if limit and len(rows) > limit:
        rows = rows[-limit:]
    return [{"time": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]} for r in rows]


def get_latest_time(symbol, timeframe):
    conn = _get_conn()
    row = conn.execute("SELECT MAX(time) FROM candles WHERE symbol=? AND timeframe=?", (symbol, timeframe)).fetchone()
    return row[0] if row and row[0] else None


def get_prev_session_close(symbol):
    conn = _get_conn()
    now = int(time.time())
    start_of_day = now - (now % 86400)
    row = conn.execute(
        "SELECT close FROM candles WHERE symbol=? AND time<? ORDER BY time DESC LIMIT 1",
        (symbol, start_of_day),
    ).fetchone()
    return row[0] if row and row[0] is not None else None


def init_db():
    _get_conn()
    logger.info(f"[DB] Initialized at {DB_PATH}")
