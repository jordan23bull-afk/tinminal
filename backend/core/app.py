import os
import sys
import time
import json
import logging
import threading
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.registry import ModuleRegistry
from core.database import init_db, prune_candles
from core.tls import ensure_bundle
from core.times import TF_SECONDS, floor_ts
from scan.atr_scanner import scan_atr, get_last_trading_day

ensure_bundle()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(BASE_DIR)
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# Rate limiting: 10 requests per second per IP for API endpoints
# No global default_limits - each endpoint has its own specific limit
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    storage_uri="memory://",
)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

active_streams = set()
_streams_lock = threading.Lock()
SETTINGS_FILE = os.path.join(PROJECT_ROOT, "settings.json")

DEFAULT_SOURCE = "tinkoff"


class PocAggregator:
    """Point-of-Control from raw trades, the way the reference rosn/Qwen model does it:
    every trade lands in exactly one price bin k = round(price/tick), the bin's
    level is k*tick, and the window is a wall-clock bucket (window_sec) aligned
    to offset_sec so a day window starts at the trading-day boundary (07:00 MSK).

    Renders as a step-after series built from the snapshot:
      - finals: frozen previous buckets, one shelf each from bucketStart onward
      - live: first POC at bucketStart, then a step on every POC change
        (when the max-volume bin flips), the client extends the right edge to now

    Trades fed in chronological order (prefill sorts them) so the step history
    is not a lie.
    """

    def __init__(self, tick, window_sec, offset_sec=0):
        self.tick = tick
        self.window_sec = window_sec
        self.offset_sec = offset_sec
        self.final_buckets = []   # {start, end, value} frozen buckets
        self._volumes = {}        # bin -> accumulated volume in live bucket
        self._best_volume = 0
        self.poc_price = None
        self._current_bucket_start = None
        self.history = []         # [{time, value}] POC changes inside live bucket
        self.first_value_time = None
        self.last_update_time = None

    def _bucket(self, ts):
        return int((ts - self.offset_sec) // self.window_sec) * self.window_sec + self.offset_sec

    def _roll(self, new_start):
        # the bucket is over: freeze it as a shelf
        if self._current_bucket_start is not None and self.poc_price is not None:
            self.final_buckets.append({
                "start": self._current_bucket_start,
                "end": new_start,
                "value": self.poc_price,
            })
        self._volumes = {}
        self._best_volume = 0
        self.poc_price = None
        self.history = []
        self.first_value_time = None
        self._current_bucket_start = new_start

    def feed(self, ts, price, volume):
        """Feeds one trade; returns True if the live POC changed."""
        b = self._bucket(ts)
        if b != self._current_bucket_start:
            self._roll(b)
        k = round(price / self.tick)
        v = self._volumes.get(k, 0.0) + volume
        self._volumes[k] = v
        self.last_update_time = ts
        old = self.poc_price
        if self.poc_price is None or v > self._best_volume:
            self._best_volume = v
            self.poc_price = k * self.tick
        if self.poc_price is not None and self.first_value_time is None:
            self.first_value_time = ts
        if self.poc_price != old:
            self.history.append({"time": ts, "value": self.poc_price})
        return self.poc_price != old

    def feed_candle(self, ts, open_, high_, low_, volume):
        """Feeds one M1 candle, spreading its volume across the price bins that
        its high-low range covers (ProfitChart-style approximation, same as the
        frontend calcPocBins). Tinkoff's GetLastTrades only exposes ~1h of raw
        trades, so day-window prefill is built from the M1 candles instead.
        ponytail: uniform spread, not a price-profile shape — the day POC is a
        good approximation but not trade-exact until the live stream resumes."""
        b = self._bucket(ts)
        if b != self._current_bucket_start:
            self._roll(b)
        self.last_update_time = ts
        k_lo = round(low_ / self.tick)
        k_hi = round(high_ / self.tick)
        if k_hi < k_lo:
            k_hi = k_lo
        old = self.poc_price
        span = max(1, k_hi - k_lo + 1)
        per_bin = volume / span
        for k in range(k_lo, k_hi + 1):
            v = self._volumes.get(k, 0.0) + per_bin
            self._volumes[k] = v
            if self.poc_price is None or v > self._best_volume:
                self._best_volume = v
                self.poc_price = k * self.tick
        if self.poc_price is not None and self.first_value_time is None:
            self.first_value_time = ts
        if self.poc_price != old:
            self.history.append({"time": ts, "value": self.poc_price})

    def snapshot(self, now=None):
        live = None
        if self.poc_price is not None:
            live = {
                "bucketStart": self._current_bucket_start,
                "firstValueTime": self.first_value_time,
                "asOf": self.last_update_time or now,
                "value": self.poc_price,
                "history": list(self.history),
            }
        return {
            "finals": self.final_buckets[-100:],  # полки истории (для дня хватит ~2, для 30м — 5ч)
            "live": live,
        }


def _quotation_to_float(q):
    return q.units + q.nano / 1e9


def get_source_chain(source_name):
    name = source_name or DEFAULT_SOURCE
    yield name


_last_broadcast = {}
_last_broadcast_lock = threading.Lock()


def broadcast_candle(symbol, timeframe, candle):
    room = f"{symbol}_{timeframe}"
    tf_seconds = TF_SECONDS.get(timeframe, 60)
    now = int(time.time())

    # guard: никогда не слать свечу из «будущего» (time > начала текущего интервала)
    if candle.get("time", 0) > floor_ts(now, tf_seconds):
        logger.debug(f"[WS] Dropping future candle time={candle.get('time')} for {room} (now={now})")
        return

    with _last_broadcast_lock:
        cur = (
            candle.get("time"),
            candle.get("open"),
            candle.get("high"),
            candle.get("low"),
            candle.get("close"),
            candle.get("volume"),
        )
        last = _last_broadcast.get(room)
        # троттлинг: не слать, если свеча не изменилась на том же time
        if last and last == cur:
            return
        _last_broadcast[room] = cur

    logger.info(f"[WS] Broadcasting to room={room}: close={candle.get('close')} time={candle.get('time')}")
    socketio.emit("candle_update", {
        "symbol": symbol,
        "timeframe": timeframe,
        "candle": candle
    }, room=room)


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def serve_static(path):
    return send_from_directory(FRONTEND_DIR, path)


@app.route("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "sources": ModuleRegistry.list_data_sources(),
    })


@app.route("/api/sources")
@limiter.limit("10/second")
def list_sources():
    return jsonify({"sources": ModuleRegistry.list_data_sources()})


@app.route("/api/settings", methods=["GET", "POST"])
def settings():
    if request.method == "GET":
        try:
            if os.path.exists(SETTINGS_FILE):
                with open(SETTINGS_FILE, "r", encoding="utf-8-sig") as f:
                    return jsonify(json.load(f))
        except Exception as e:
            logger.error(f"Settings load error: {e}")
        return jsonify({})
    else:
        try:
            body = request.json
            serialized = json.dumps(body, ensure_ascii=False, sort_keys=True)
            if len(serialized) > 10 * 1024 * 1024:
                return jsonify({"error": "Settings too large (max 10MB)"}), 400
            current = None
            if os.path.exists(SETTINGS_FILE):
                try:
                    with open(SETTINGS_FILE, "r", encoding="utf-8-sig") as f:
                        current = f.read()
                except Exception:
                    current = None
            if current == serialized:
                return jsonify({"ok": True, "status": "unchanged"})
            tmp_path = SETTINGS_FILE + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                f.write(serialized)
            os.replace(tmp_path, SETTINGS_FILE)
            return jsonify({"ok": True, "status": "saved"})
        except Exception as e:
            logger.error(f"Settings save error: {e}")
            return jsonify({"error": str(e)}), 500


class ServiceAccessFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        if "POST /api/settings" in msg or "GET /api/prices" in msg:
            return False
        return True


logging.getLogger("werkzeug").addFilter(ServiceAccessFilter())


@app.route("/api/history", methods=["POST"])
@limiter.limit("10/second")
def history():
    try:
        req = request.json
        for field in ("source", "symbol", "timeframe"):
            if field not in req:
                return jsonify({"error": f"Missing required field: {field}"}), 400
        last_err = None
        for name in get_source_chain(req["source"]):
            try:
                source = ModuleRegistry.get_data_source(name)
                candles = source.get_historical_data(req["symbol"], req["timeframe"], req.get("limit", 1000))
                tick = None
                if hasattr(source, "get_tick"):
                    try:
                        tick = source.get_tick(req["symbol"])
                    except Exception as e:
                        logger.debug(f"Tick resolve error: {e}")

                return jsonify({
                    "symbol": req["symbol"],
                    "timeframe": req["timeframe"],
                    "source": name,
                    "candles": candles,
                    "tick": tick,
                })
            except Exception as e:
                logger.error(f"History API error ({name}): {e}")
                last_err = e
        return jsonify({"error": str(last_err)}), 500
    except Exception as e:
        logger.error(f"History API error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/history/compare", methods=["POST"])
@limiter.limit("5/second")
def history_compare():
    """Compare ready-made Tinkoff candles vs candles rebuilt from raw trades
    (ProfitChart-style aggregation). Returns both series + a per-bar diff."""
    try:
        req = request.json
        for field in ("source", "symbol", "timeframe"):
            if field not in req:
                return jsonify({"error": f"Missing required field: {field}"}), 400
        last_err = None
        for name in get_source_chain(req["source"]):
            try:
                source = ModuleRegistry.get_data_source(name)
                if not hasattr(source, "rebuild_candles_from_trades"):
                    return jsonify({"error": f"Source {name} does not support trade rebuild"}), 501
                ready = source.get_historical_data(req["symbol"], req["timeframe"], req.get("limit", 1000))
                rebuilt = source.rebuild_candles_from_trades(req["symbol"], req["timeframe"], req.get("limit", 1000))
                by_time = {c["time"]: c for c in ready}
                diff = []
                for r in rebuilt:
                    rtime = r["time"]
                    if rtime not in by_time:
                        diff.append({"time": rtime, "rebuilt": r, "ready": None})
                        continue
                    d = by_time[rtime]
                    diff.append({
                        "time": rtime,
                        "rebuilt": r,
                        "ready": d,
                        "o": r["open"] - d["open"],
                        "h": r["high"] - d["high"],
                        "l": r["low"] - d["low"],
                        "c": r["close"] - d["close"],
                        "volume": r["volume"] - d["volume"],
                    })
                return jsonify({
                    "symbol": req["symbol"],
                    "timeframe": req["timeframe"],
                    "source": name,
                    "rebuilt": rebuilt,
                    "ready": ready,
                    "diff": diff,
                })
            except Exception as e:
                logger.error(f"History compare error ({name}): {e}")
                last_err = e
        return jsonify({"error": str(last_err)}), 500
    except Exception as e:
        logger.error(f"History compare error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/prices")
@limiter.limit("20/second")
def prices():
    try:
        symbols = request.args.get("symbols", "").split(",")
        symbols = [s.strip().upper() for s in symbols if s.strip()]
        if not symbols:
            return jsonify({"prices": {}})
        source_name = request.args.get("source", DEFAULT_SOURCE)
        last_err = None
        fallback_result = {}
        for name in get_source_chain(source_name):
            try:
                source = ModuleRegistry.get_data_source(name)
                result = source.get_prices(symbols)
                if result:
                    return jsonify({"prices": result})
                fallback_result = result
            except Exception as e:
                logger.error(f"Prices API error ({name}): {e}")
                last_err = e
        if not fallback_result and last_err:
            return jsonify({"error": str(last_err)}), 500
        return jsonify({"prices": fallback_result})
    except Exception as e:
        logger.error(f"Prices API error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/scan/atr", methods=["POST"])
@limiter.limit("5/minute")
def scan_atr_route():
    try:
        body = request.json or {}
        threshold = body.get("atr_threshold", 0)
        date = body.get("date") or None
        result = scan_atr(threshold, date)
        if "error" in result:
            return jsonify(result), 400
        return jsonify(result)
    except Exception as e:
        logger.error(f"ATR scan error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/scan/last-trading-day")
def last_trading_day_route():
    try:
        date = get_last_trading_day()
        if not date:
            return jsonify({"error": "Не удалось определить последний торговый день"}), 400
        return jsonify({"date": date})
    except Exception as e:
        logger.error(f"Last trading day error: {e}")
        return jsonify({"error": str(e)}), 500


client_rooms = {}


def _unsubscribe_room(symbol, timeframe):
    for name in get_source_chain(DEFAULT_SOURCE):
        try:
            ModuleRegistry.get_data_source(name).unsubscribe_realtime(symbol, timeframe)
        except Exception as e:
            logger.error(f"[WS] unsubscribe {name} error for {symbol}_{timeframe}: {e}")


# ------------------------------------------------------------------ #
# server-side POC (from raw trades, window in minutes)
# ------------------------------------------------------------------ #
POC_LOOKBACK_SEC = 5 * 3600  # min prefill history window (5h); grows to 2x of window when larger
_poc_state = {}               # (symbol, window_min) -> {"agg", "source", "subs", "tick"}
_poc_lock = threading.Lock()


def _poc_room(symbol, window_min):
    return f"poc:{symbol}:{window_min}"


def _poc_key(symbol, window_min):
    return (symbol.upper(), int(window_min))


def _poc_broadcast(room, msg):
    socketio.emit("poc_update", msg, room=room)


def _poc_on_trade(symbol, window_min, agg, trade, state=None):
    """stream trade callback → feed aggregator, broadcast the updated snapshot."""
    try:
        ts = trade.time.seconds or int(time.time())
        price = _quotation_to_float(trade.price)
        qty = int(trade.quantity or 0)
    except Exception as e:
        logger.error(f"[WS] poc trade parse error {symbol}: {e}")
        return
    changed = agg.feed(ts, price, qty)
    if changed:
        _poc_broadcast(_poc_room(symbol, window_min), {
            "symbol": symbol.upper(),
            "windowMin": window_min,
            "tick": agg.tick,
            "snap": agg.snapshot(int(time.time())),
        })


def _poc_ensure(symbol, window_min):
    """Start a POC aggregator + trade subscription if none exists. Returns key."""
    key = _poc_key(symbol, window_min)
    with _poc_lock:
        state = _poc_state.get(key)
        if state is not None:
            state["subs"] += 1
            return key
    source = ModuleRegistry.get_data_source(DEFAULT_SOURCE)
    tick = None
    if hasattr(source, "get_tick"):
        try:
            tick = source.get_tick(symbol)
        except Exception as e:
            logger.debug(f"[WS] poc tick resolve error {symbol}: {e}")
    if not tick:
        tick = 0.01
    # все POC-окна стартуют от начала торговой сессии 07:00 МСК = 04:00 UTC:
    # offset=4ч даёт бакет ровно в 04:00 для 30м/1ч/2ч/4ч/8ч (14400 кратно окну),
    # а для 8ч без него бакет выпадает на 00:00 UTC и линия начинается до сессии
    offset_sec = 4 * 3600
    agg = PocAggregator(tick, window_min * 60, offset_sec)
    state = {"agg": agg, "source": DEFAULT_SOURCE, "subs": 1, "tick": tick,
             "prefill_done": False, "pending": []}
    with _poc_lock:
        _poc_state[key] = state

    # prefill history: cover the whole current window (plus margin), min 5h,
    # always starting from the trading-day boundary (07:00 MSK = 04:00 UTC) so
    # the series begins at the start of the day for any window size.
    # Tinkoff's GetLastTrades only returns ~1h of raw trades, so the prefill is
    # built from M1 candles instead (available for the whole day); the live
    # trade stream keeps filling the same bins afterwards.
    def _prefill():
        try:
            now = int(time.time())
            day_sec = 86400
            day_aligned = int((now - 4 * 3600) // day_sec) * day_sec + 4 * 3600
            lookback = max(POC_LOOKBACK_SEC, window_min * 60, now - day_aligned)
            candles = source.get_historical_data(symbol, "1m",
                                                 max(2, int(lookback / 60)))
            flat_ts = now - (now % 60)  # skip the not-yet-flat M1 candle
            fed = 0
            for c in candles:
                if c["time"] >= flat_ts:
                    continue
                agg.feed_candle(c["time"], c["open"], c["high"], c["low"],
                                c.get("volume") or 0)
                fed += 1
            fills = f"{fed} M1 candles"
        except Exception as e:
            logger.error(f"[WS] POC prefill error {symbol}: {e}")
            fills = "error"
        finally:
            # live-сделки, пришедшие во время префилла, кормим после него:
            # иначе однопоточный агрегатор получает сделки-назад-во-времени и
            # замораживает неполные бакеты как finals (линия стартует не с дня)
            with _poc_lock:
                state["prefill_done"] = True
                pending = list(state["pending"])
                state["pending"] = []
            for t in pending:
                try:
                    agg.feed(int(t.time.seconds or time.time()),
                             _quotation_to_float(t.price),
                             int(t.quantity or 0))
                except Exception as e:
                    logger.error(f"[WS] poc pending trade error {symbol}: {e}")
        snap = agg.snapshot(int(time.time()))
        socketio.emit("poc_snapshot", {
            "symbol": symbol.upper(),
            "windowMin": window_min,
            "tick": agg.tick,
            "snap": snap,
        }, room=_poc_room(symbol, window_min))
        logger.info(f"[WS] POC prefill {symbol} {window_min}m: {len(snap['finals'])} finals, "
                    f"{len(snap['live']['history']) if snap['live'] else 0} live steps "
                    f"({fills})")

    threading.Thread(target=_prefill, name=f"poc-prefill-{symbol}-{window_min}", daemon=True).start()

    def on_trade(trade, s=symbol, w=window_min, a=agg):
        with _poc_lock:
            if not state["prefill_done"]:
                state["pending"].append(trade)
                return
        _poc_on_trade(s, w, a, trade)

    source.subscribe_trades(symbol, on_trade)
    with _poc_lock:
        cur = _poc_state.get(key)
        if cur is not None:
            cur["cb"] = on_trade
    logger.info(f"[WS] POC started {symbol} {window_min}m (tick={tick})")
    return key


def _poc_release(symbol, window_min):
    key = _poc_key(symbol, window_min)
    stop = False
    state = None
    with _poc_lock:
        state = _poc_state.get(key)
        if state:
            state["subs"] -= 1
            if state["subs"] <= 0:
                _poc_state.pop(key, None)
                stop = True
    if stop:
        try:
            ModuleRegistry.get_data_source(state["source"]).unsubscribe_trades(symbol, state.get("cb"))
        except Exception as e:
            logger.error(f"[WS] poc unsubscribe error {key}: {e}")
        logger.info(f"[WS] POC stopped {symbol} {window_min}m")


@socketio.on("poc_subscribe")
def on_poc_subscribe(data):
    try:
        symbol = str(data["symbol"]).upper()
        window_min = int(data.get("windowMin", 30))
        room = _poc_room(symbol, window_min)
        join_room(room)
        with _streams_lock:
            client_rooms.setdefault(request.sid, set()).add(room)
        key = _poc_ensure(symbol, window_min)
        state = _poc_state.get(key)
        snap = state["agg"].snapshot(int(time.time())) if state else {"finals": [], "live": None}
        emit("poc_snapshot", {
            "symbol": symbol,
            "windowMin": window_min,
            "tick": (state["tick"] if state else None),
            "snap": snap,
        })
        logger.info(f"[WS] POC subscribe {request.sid} {room} "
                    f"({len(snap.get('finals', []))} finals, live={'ok' if snap.get('live') else 'none'})")
    except Exception as e:
        logger.error(f"POC subscribe error: {e}")
        emit("error", {"msg": str(e)})


@socketio.on("poc_unsubscribe")
def on_poc_unsubscribe(data):
    try:
        symbol = str(data["symbol"]).upper()
        window_min = int(data.get("windowMin", 30))
        room = _poc_room(symbol, window_min)
        leave_room(room)
        with _streams_lock:
            client_rooms.get(request.sid, set()).discard(room)
        _poc_release(symbol, window_min)
        logger.info(f"[WS] POC unsubscribe {request.sid} {room}")
    except Exception as e:
        logger.error(f"POC unsubscribe error: {e}")


def _room_wanted_by_others(room):
    return any(room in sids for sids in client_rooms.values())


@socketio.on("connect")
def on_connect():
    logger.info(f"Client connected: {request.sid}")
    with _streams_lock:
        client_rooms[request.sid] = set()
    emit("status", {"msg": "Connected"})


@socketio.on("disconnect")
def on_disconnect():
    rooms_to_unsub = []
    poc_rooms_to_release = []
    with _streams_lock:
        rooms = client_rooms.pop(request.sid, set())
        rooms_to_unsub = [
            r for r in rooms
            if r in active_streams and not _room_wanted_by_others(r)
        ]
        for room in rooms_to_unsub:
            active_streams.discard(room)
        poc_rooms_to_release = [r for r in rooms if r.startswith("poc:")]
    for room in rooms_to_unsub:
        parts = room.rsplit("_", 1)
        if len(parts) == 2:
            _unsubscribe_room(parts[0], parts[1])
    for room in poc_rooms_to_release:
        rest = room[len("poc:"):]
        symbol, _, win = rest.rpartition(":")
        if symbol and win:
            _poc_release(symbol, win)
    logger.info(f"Client disconnected: {request.sid}, cleaned {len(rooms_to_unsub)} rooms")


@socketio.on("subscribe")
def on_subscribe(data):
    try:
        symbol = data["symbol"]
        timeframe = data["timeframe"]
        source_name = data.get("source", DEFAULT_SOURCE)
        room = f"{symbol}_{timeframe}"

        logger.info(f"[WS] Subscribe request: symbol={symbol} tf={timeframe} source={source_name} room={room}")

        join_room(room)
        with _streams_lock:
            client_rooms.setdefault(request.sid, set()).add(room)
            is_new = room not in active_streams
            if is_new:
                active_streams.add(room)
        logger.info(f"[WS] Client {request.sid} joined room {room}")

        used = None
        last_err = None
        if is_new:
            logger.info(f"[WS] Starting new stream for {room}")
            for name in get_source_chain(source_name):
                try:
                    source = ModuleRegistry.get_data_source(name)
                    logger.info(f"[WS] Got source: {name}, calling subscribe_realtime...")

                    def on_candle(candle, s=symbol, t=timeframe):
                        broadcast_candle(s, t, candle)

                    source.subscribe_realtime(symbol, timeframe, on_candle)
                    used = name
                    break
                except Exception as e:
                    logger.error(f"[WS] {name} subscribe failed for {room}: {e}")
                    last_err = e
            if used is None:
                with _streams_lock:
                    active_streams.discard(room)
                emit("error", {"msg": f"Subscribe failed: {last_err}"})
                return
            if used != source_name:
                emit("ticker_error", {"symbol": symbol, "msg": f"{source_name}: {last_err}"})
        else:
            logger.info(f"[WS] Stream already active for {room}")
            used = source_name

        emit("subscribed", {
            "room": room,
            "symbol": symbol,
            "timeframe": timeframe,
            "source": used or source_name,
        })
    except Exception as e:
        logger.error(f"Subscribe error: {e}")
        emit("error", {"msg": str(e)})
        emit("ticker_error", {"symbol": data.get("symbol"), "msg": str(e)})


@socketio.on("unsubscribe")
def on_unsubscribe(data):
    try:
        room = f"{data['symbol']}_{data['timeframe']}"
        leave_room(room)
        is_last = False
        with _streams_lock:
            client_rooms.get(request.sid, set()).discard(room)
            is_last = room in active_streams and not _room_wanted_by_others(room)
            if is_last:
                active_streams.discard(room)
        if is_last:
            _unsubscribe_room(data["symbol"], data["timeframe"])
        logger.info(f"Client {request.sid} unsubscribed from {room}" + (" (last, stream stopped)" if is_last else ""))
    except Exception as e:
        logger.error(f"Unsubscribe error: {e}")
        emit("error", {"msg": str(e)})


import atexit

if __name__ == "__main__":
    init_db()

    def _prune_loop():
        while True:
            try:
                prune_candles()
            except Exception as e:
                logger.error(f"DB prune error: {e}")
            time.sleep(6 * 3600)

    threading.Thread(target=_prune_loop, name="db-prune", daemon=True).start()

    ModuleRegistry.auto_load(os.path.join(BACKEND_DIR, "data_sources"), "data_sources")
    logger.info(f"Loaded sources: {ModuleRegistry.list_data_sources()}")
    
    # Register cleanup on exit
    atexit.register(ModuleRegistry.shutdown)
    
    logger.info("=== Open http://localhost:5000 in browser ===")
    socketio.run(
        app,
        host="localhost",
        port=5000,
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
        allow_unsafe_werkzeug=True,
        use_reloader=False,
    )
