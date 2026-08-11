import os
import sys
import time
import json
import logging
import threading
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.registry import ModuleRegistry
from core.database import init_db
from core.tls import ensure_bundle

ensure_bundle()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(BASE_DIR)
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

active_streams = set()
_streams_lock = threading.Lock()
SETTINGS_FILE = os.path.join(PROJECT_ROOT, "settings.json")

DEFAULT_SOURCE = "tinkoff"

TF_SECONDS = {
    "1m": 60, "5m": 300, "10m": 600, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
}


def floor_ts(ts, tf_seconds):
    return ts - (ts % tf_seconds)


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
        "indicators": ModuleRegistry.list_indicators()
    })


@app.route("/api/sources")
def list_sources():
    return jsonify({"sources": ModuleRegistry.list_data_sources()})


@app.route("/api/indicators")
def list_indicators():
    result = {}
    for name in ModuleRegistry.list_indicators():
        ind = ModuleRegistry.get_indicator(name)
        result[name] = {"parameters": ind.parameters, "output": ind.output_schema}
    return jsonify(result)


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

                indicators = {}
                for ind_name, params in req.get("indicators", {}).items():
                    ind = ModuleRegistry.get_indicator(ind_name)
                    indicators.update(ind.calculate(candles, params))

                return jsonify({
                    "symbol": req["symbol"],
                    "timeframe": req["timeframe"],
                    "source": name,
                    "candles": candles,
                    "indicators": indicators
                })
            except Exception as e:
                logger.error(f"History API error ({name}): {e}")
                last_err = e
        return jsonify({"error": str(last_err)}), 500
    except Exception as e:
        logger.error(f"History API error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/prices")
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


client_rooms = {}


def _unsubscribe_room(symbol, timeframe):
    for name in get_source_chain(DEFAULT_SOURCE):
        try:
            ModuleRegistry.get_data_source(name).unsubscribe_realtime(symbol, timeframe)
        except Exception as e:
            logger.error(f"[WS] unsubscribe {name} error for {symbol}_{timeframe}: {e}")


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
    with _streams_lock:
        rooms = client_rooms.pop(request.sid, set())
        rooms_to_unsub = [
            r for r in rooms
            if r in active_streams and not _room_wanted_by_others(r)
        ]
        for room in rooms_to_unsub:
            active_streams.discard(room)
    for room in rooms_to_unsub:
        parts = room.rsplit("_", 1)
        if len(parts) == 2:
            _unsubscribe_room(parts[0], parts[1])
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


if __name__ == "__main__":
    init_db()
    ModuleRegistry.auto_load(os.path.join(BACKEND_DIR, "data_sources"), "data_sources")
    logger.info(f"Loaded sources: {ModuleRegistry.list_data_sources()}")
    logger.info(f"Loaded indicators: {ModuleRegistry.list_indicators()}")
    logger.info("=== Open http://localhost:5000 in browser ===")
    socketio.run(
        app,
        host="localhost",
        port=5000,
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
        allow_unsafe_werkzeug=True,
    )
