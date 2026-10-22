"""Слой доступа к состоянию пользователя: раскладки, объекты, алерты, команды.

Всё, что меняет состояние, проходит только через `commands.apply_command`.
Эта гарантия нужна для двух вещей: синхронизация между машинами и стек отмены.

База — тот же файл `candles.db`, что и для свечей, но своё соединение:
модуль свечей отвечает за котировки, этот — за состояние.
"""

import json
import logging
import sqlite3
import threading
import time
import uuid

from core.config import DB_PATH, ensure_dirs

logger = logging.getLogger(__name__)

_local = threading.local()
_write_lock = threading.RLock()


def _conn():
    if not hasattr(_local, "conn") or _local.conn is None:
        ensure_dirs()
        conn = sqlite3.connect(str(DB_PATH), timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return _local.conn


def write_lock():
    """Сериализует запись внутри процесса.

    Межпроцессную сериализацию обеспечивает сам SQLite (WAL + busy_timeout),
    этот лок нужен чтобы два потока не получили одно и то же состояние
    версии при вычислении следующей версии.
    """
    return _write_lock


def new_id():
    return uuid.uuid4().hex


def now():
    return int(time.time())


def _json_loads(value, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _dumps(value):
    return json.dumps(value or {}, ensure_ascii=False, sort_keys=True)


SCHEMA = """
CREATE TABLE IF NOT EXISTS layouts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS objects (
    id          TEXT PRIMARY KEY,
    layout_id   TEXT,
    chart_index INTEGER NOT NULL DEFAULT 0,
    kind        TEXT NOT NULL,
    symbol      TEXT,
    timeframe   TEXT,
    data        TEXT NOT NULL DEFAULT '{}',
    style       TEXT NOT NULL DEFAULT '{}',
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (layout_id) REFERENCES layouts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_objects_layout ON objects(layout_id, chart_index);
CREATE INDEX IF NOT EXISTS idx_objects_symbol  ON objects(symbol, kind);

CREATE TABLE IF NOT EXISTS alerts (
    id          TEXT PRIMARY KEY,
    object_id   TEXT,
    layout_id   TEXT,
    symbol      TEXT NOT NULL,
    timeframe   TEXT NOT NULL DEFAULT '1m',
    condition   TEXT NOT NULL,
    price       REAL,
    price_high  REAL,
    expires_at  INTEGER,
    channels    TEXT NOT NULL DEFAULT '["sound","browser"]',
    repeat_mode TEXT NOT NULL DEFAULT 'once',
    status      TEXT NOT NULL DEFAULT 'armed',
    fired_at    INTEGER,
    fired_count INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol, status);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);

CREATE TABLE IF NOT EXISTS commands (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    layout_id  TEXT,
    client_id  TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    inverse    TEXT,
    undone     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_commands_layout ON commands(layout_id, id DESC);
"""


def init_schema():
    """Создать таблицы состояния. Идемпотентно."""
    conn = _conn()
    conn.executescript(SCHEMA)
    # База могла быть создана прошлой версией схемы без столбца state.
    # Добавляем недостающие столбцы, чтобы не требовать ручной чистки.
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(layouts)")}
    if "state" not in existing:
        logger.info("[Store] Добавляю отсутствующий столбец layouts.state")
        conn.execute("ALTER TABLE layouts ADD COLUMN state TEXT NOT NULL DEFAULT '{}'")
    conn.commit()
    logger.info("[Store] Схема состояния готова")


# --- раскладки ---------------------------------------------------------------

def _layout_row_to_dict(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "version": row["version"],
        "state": _json_loads(row["state"], {}) if "state" in row.keys() else {},
    }


def create_layout(name="Раскладка", layout_id=None, state=None):
    lid = layout_id or new_id()
    ts = now()
    conn = _conn()
    conn.execute(
        "INSERT OR REPLACE INTO layouts (id, name, state, created_at, updated_at, version) "
        "VALUES (?,?,?,?,?,1)",
        (lid, name or "Раскладка", _dumps(state), ts, ts),
    )
    conn.commit()
    return get_layout(lid)


def get_layout(layout_id):
    row = _conn().execute(
        "SELECT * FROM layouts WHERE id=?", (layout_id,)
    ).fetchone()
    return _layout_row_to_dict(row) if row else None


def list_layouts():
    rows = _conn().execute(
        "SELECT * FROM layouts ORDER BY updated_at DESC"
    ).fetchall()
    return [_layout_row_to_dict(r) for r in rows]


def rename_layout(layout_id, name):
    conn = _conn()
    cur = conn.execute(
        "UPDATE layouts SET name=?, updated_at=?, version=version+1 WHERE id=?",
        (name, now(), layout_id),
    )
    conn.commit()
    return get_layout(layout_id) if cur.rowcount else None


def save_layout_state(layout_id, state, expected_version=None):
    """Сохранить состояние с проверкой версии.

    Возвращает (layout, conflict). conflict=True означает, что состояние на
    сервере меняли после того, как клиент его прочитал: клиент должен перезагрузить.
    """
    conn = _conn()
    row = conn.execute(
        "SELECT version FROM layouts WHERE id=?", (layout_id,)
    ).fetchone()
    if not row:
        return None, False
    current = row["version"]
    if expected_version is not None and int(expected_version) != current:
        return get_layout(layout_id), True
    ts = now()
    conn.execute(
        "UPDATE layouts SET state=?, updated_at=?, version=version+1 WHERE id=?",
        (_dumps(state), ts, layout_id),
    )
    conn.commit()
    return get_layout(layout_id), False


def get_version(layout_id):
    conn = _conn()
    row = conn.execute("SELECT version FROM layouts WHERE id=?", (layout_id,)).fetchone()
    return row["version"] if row else None


def bump_version(layout_id):
    conn = _conn()
    conn.execute(
        "UPDATE layouts SET updated_at=?, version=version+1 WHERE id=?",
        (now(), layout_id),
    )
    conn.commit()
    row = conn.execute("SELECT version FROM layouts WHERE id=?", (layout_id,)).fetchone()
    return row["version"] if row else None


def delete_layout(layout_id):
    conn = _conn()
    conn.execute("DELETE FROM commands WHERE layout_id=?", (layout_id,))
    conn.execute("DELETE FROM alerts   WHERE layout_id=?", (layout_id,))
    conn.execute("DELETE FROM objects   WHERE layout_id=?", (layout_id,))
    cur = conn.execute("DELETE FROM layouts WHERE id=?", (layout_id,))
    conn.commit()
    return cur.rowcount > 0


# --- объекты -----------------------------------------------------------------

def _object_row_to_dict(row):
    if row is None:
        return None
    return {
        "id": row["id"],
        "layout_id": row["layout_id"],
        "chart_index": row["chart_index"],
        "kind": row["kind"],
        "symbol": row["symbol"],
        "timeframe": row["timeframe"],
        "data": _json_loads(row["data"], {}),
        "style": _json_loads(row["style"], {}),
        "version": row["version"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def create_object(layout_id, kind, symbol=None, timeframe=None,
                  chart_index=0, data=None, style=None, object_id=None):
    oid = object_id or new_id()
    ts = now()
    conn = _conn()
    conn.execute(
        "INSERT INTO objects (id, layout_id, chart_index, kind, symbol, timeframe, "
        "data, style, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
        (oid, layout_id, int(chart_index), kind, symbol, timeframe,
         _dumps(data), _dumps(style), ts, ts),
    )
    conn.commit()
    return get_object(oid)


def get_object(object_id):
    row = _conn().execute("SELECT * FROM objects WHERE id=?", (object_id,)).fetchone()
    return _object_row_to_dict(row)


def list_objects(layout_id):
    rows = _conn().execute(
        "SELECT * FROM objects WHERE layout_id=? ORDER BY created_at", (layout_id,)
    ).fetchall()
    return [_object_row_to_dict(r) for r in rows]


def list_objects_by_symbol(layout_id, symbol):
    rows = _conn().execute(
        "SELECT * FROM objects WHERE layout_id=? AND symbol=? ORDER BY created_at",
        (layout_id, symbol),
    ).fetchall()
    return [_object_row_to_dict(r) for r in rows]


def update_object(object_id, data=None, style=None):
    current = get_object(object_id)
    if not current:
        return None
    new_data = current["data"] if data is None else data
    new_style = current["style"] if style is None else style
    conn = _conn()
    conn.execute(
        "UPDATE objects SET data=?, style=?, version=version+1, updated_at=? WHERE id=?",
        (_dumps(new_data), _dumps(new_style), now(), object_id),
    )
    conn.commit()
    return get_object(object_id)


def set_object_chart_index(object_id, chart_index):
    """Привязать объект к панели.

    Индекс панели меняется, когда раскладку перестроили: панель с тем же
    символом может оказаться на другом месте.
    """
    conn = _conn()
    cur = conn.execute(
        "UPDATE objects SET chart_index=?, version=version+1, updated_at=? WHERE id=?",
        (int(chart_index), now(), object_id),
    )
    conn.commit()
    return cur.rowcount > 0


def delete_object(object_id):
    conn = _conn()
    conn.execute("DELETE FROM alerts WHERE object_id=?", (object_id,))
    cur = conn.execute("DELETE FROM objects WHERE id=?", (object_id,))
    conn.commit()
    return cur.rowcount > 0


# --- алерты ------------------------------------------------------------------

CONDITIONS = ("above", "below", "cross", "inside")
STATUSES = ("armed", "fired", "expired", "disabled")


def _alert_row_to_dict(row):
    if row is None:
        return None
    return {
        "id": row["id"],
        "object_id": row["object_id"],
        "layout_id": row["layout_id"],
        "symbol": row["symbol"],
        "timeframe": row["timeframe"],
        "condition": row["condition"],
        "price": row["price"],
        "price_high": row["price_high"],
        "expires_at": row["expires_at"],
        "channels": _json_loads(row["channels"], ["sound", "browser"]),
        "repeat_mode": row["repeat_mode"],
        "status": row["status"],
        "fired_at": row["fired_at"],
        "fired_count": row["fired_count"],
        "created_at": row["created_at"],
    }


def create_alert(layout_id, symbol, condition, price=None, price_high=None,
                 timeframe="1m", object_id=None, channels=None,
                 expires_at=None, repeat_mode="once", alert_id=None):
    aid = alert_id or new_id()
    conn = _conn()
    conn.execute(
        "INSERT INTO alerts (id, object_id, layout_id, symbol, timeframe, condition, "
        "price, price_high, expires_at, channels, repeat_mode, status, fired_count, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,'armed',0,?)",
        (aid, object_id, layout_id, symbol, timeframe, condition, price, price_high,
         expires_at, _dumps(channels or ["sound", "browser"]), repeat_mode, now()),
    )
    conn.commit()
    return get_alert(aid)


def get_alert(alert_id):
    row = _conn().execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
    return _alert_row_to_dict(row)


def list_alerts(layout_id=None):
    if layout_id:
        rows = _conn().execute(
            "SELECT * FROM alerts WHERE layout_id=? ORDER BY created_at DESC", (layout_id,)
        ).fetchall()
    else:
        rows = _conn().execute(
            "SELECT * FROM alerts ORDER BY created_at DESC"
        ).fetchall()
    return [_alert_row_to_dict(r) for r in rows]


def list_alerts_by_object(object_id):
    rows = _conn().execute(
        "SELECT * FROM alerts WHERE object_id=? ORDER BY created_at DESC", (object_id,)
    ).fetchall()
    return [_alert_row_to_dict(r) for r in rows]


def list_armed_alerts(symbol=None):
    if symbol:
        rows = _conn().execute(
            "SELECT * FROM alerts WHERE status='armed' AND symbol=?", (symbol,)
        ).fetchall()
    else:
        rows = _conn().execute(
            "SELECT * FROM alerts WHERE status='armed'"
        ).fetchall()
    return [_alert_row_to_dict(r) for r in rows]


def update_alert(alert_id, **fields):
    allowed = ("symbol", "timeframe", "condition", "price", "price_high",
               "expires_at", "channels", "repeat_mode", "status", "object_id")
    sets, values = [], []
    for key, value in fields.items():
        if key not in allowed:
            continue
        sets.append(f"{key}=?")
        values.append(_dumps(value) if key == "channels" else value)
    if not sets:
        return get_alert(alert_id)
    values.append(alert_id)
    conn = _conn()
    conn.execute(f"UPDATE alerts SET {', '.join(sets)} WHERE id=?", values)
    conn.commit()
    return get_alert(alert_id)


def delete_alert(alert_id):
    conn = _conn()
    cur = conn.execute("DELETE FROM alerts WHERE id=?", (alert_id,))
    conn.commit()
    return cur.rowcount > 0


def mark_alert_fired(alert_id):
    conn = _conn()
    conn.execute(
        "UPDATE alerts SET status=?, fired_at=?, fired_count=fired_count+1 WHERE id=?",
        ("fired", now(), alert_id),
    )
    conn.commit()
    return get_alert(alert_id)


# --- журнал команд -----------------------------------------------------------

def clear_redo(layout_id, client_id=None):
    """Забыть отменённые команды: после нового действия повторять их нельзя.

    Иначеredo переиграл бы старое действие поверх только что сделанного
    и вернул состояние, которого пользователь уже не ожидал.

    client_id — вкладка. Журнал у каждой вкладки свой, поэтому новое
    действие в одной вкладке не стирает ветку повторов в других.
    None — общий журнал раскладки (старый режим, HTTP-путь и самотесты).
    """
    conn = _conn()
    if client_id is None:
        cur = conn.execute(
            "DELETE FROM commands WHERE layout_id=? AND undone=1", (layout_id,)
        )
    else:
        cur = conn.execute(
            "DELETE FROM commands WHERE layout_id=? AND undone=1 AND client_id=?",
            (layout_id, client_id),
        )
    conn.commit()
    return cur.rowcount


def log_command(layout_id, client_id, kind, payload, inverse):
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO commands (layout_id, client_id, ts, kind, payload, inverse, undone) "
        "VALUES (?,?,?,?,?,?,0)",
        (layout_id, client_id or "?", now(), kind, _dumps(payload), _dumps(inverse)),
    )
    conn.commit()
    return cur.lastrowid


def _command_row_to_dict(row):
    return {
        "id": row["id"],
        "layout_id": row["layout_id"],
        "client_id": row["client_id"],
        "ts": row["ts"],
        "kind": row["kind"],
        "payload": _json_loads(row["payload"], {}),
        "inverse": _json_loads(row["inverse"], None),
        "undone": bool(row["undone"]),
    }


def list_commands(layout_id, limit=200):
    rows = _conn().execute(
        "SELECT * FROM commands WHERE layout_id=? ORDER BY id DESC LIMIT ?",
        (layout_id, int(limit)),
    ).fetchall()
    return [_command_row_to_dict(r) for r in rows]


def last_command(layout_id, undone, client_id=None):
    """Последняя команда для отмены или повтора.

    client_id — вкладка: вкладка отменяет только свои действия, как это
    устроено у источника (журнал там клиентский). None — общий журнал
    раскладки (старый режим, HTTP-путь и самотесты).
    """
    if client_id is None:
        row = _conn().execute(
            "SELECT * FROM commands WHERE layout_id=? AND undone=? ORDER BY id DESC LIMIT 1",
            (layout_id, 1 if undone else 0),
        ).fetchone()
    else:
        row = _conn().execute(
            "SELECT * FROM commands WHERE layout_id=? AND undone=? AND client_id=? "
            "ORDER BY id DESC LIMIT 1",
            (layout_id, 1 if undone else 0, client_id),
        ).fetchone()
    return _command_row_to_dict(row) if row else None


def set_command_undone(command_id, undone):
    conn = _conn()
    conn.execute(
        "UPDATE commands SET undone=? WHERE id=?", (1 if undone else 0, command_id)
    )
    conn.commit()


def trim_commands(layout_id, keep=500):
    """Ограничить журнал, чтобы он не рос бесконечно."""
    conn = _conn()
    conn.execute(
        "DELETE FROM commands WHERE layout_id=? AND id NOT IN "
        "(SELECT id FROM commands WHERE layout_id=? ORDER BY id DESC LIMIT ?)",
        (layout_id, layout_id, int(keep)),
    )
    conn.commit()


def stats():
    conn = _conn()
    return {
        "layouts": conn.execute("SELECT COUNT(*) FROM layouts").fetchone()[0],
        "objects": conn.execute("SELECT COUNT(*) FROM objects").fetchone()[0],
        "alerts": conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0],
        "commands": conn.execute("SELECT COUNT(*) FROM commands").fetchone()[0],
    }