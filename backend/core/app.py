import os
import sys
import json
import logging
import threading
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.registry import ModuleRegistry

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


def broadcast_candle(symbol, timeframe, candle):
    room = f"{symbol}_{timeframe}"
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
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    return jsonify(json.load(f))
        except Exception as e:
            logger.error(f"Settings load error: {e}")
        return jsonify({})
    else:
        try:
            body = request.json
            serialized = json.dumps(body, ensure_ascii=False)
            if len(serialized) > 10 * 1024 * 1024:
                return jsonify({"error": "Settings too large (max 10MB)"}), 400
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                f.write(serialized)
            return jsonify({"ok": True})
        except Exception as e:
            logger.error(f"Settings save error: {e}")
            return jsonify({"error": str(e)}), 500


@app.route("/api/history", methods=["POST"])
def history():
    try:
        req = request.json
        for field in ("source", "symbol", "timeframe"):
            if field not in req:
                return jsonify({"error": f"Missing required field: {field}"}), 400
        source = ModuleRegistry.get_data_source(req["source"])
        candles = source.get_historical_data(req["symbol"], req["timeframe"], req.get("limit", 500))

        indicators = {}
        for ind_name, params in req.get("indicators", {}).items():
            ind = ModuleRegistry.get_indicator(ind_name)
            indicators.update(ind.calculate(candles, params))

        return jsonify({
            "symbol": req["symbol"],
            "timeframe": req["timeframe"],
            "candles": candles,
            "indicators": indicators
        })
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
        source = ModuleRegistry.get_data_source("moex")
        result = source.get_prices(symbols)
        return jsonify({"prices": result})
    except Exception as e:
        logger.error(f"Prices API error: {e}")
        return jsonify({"error": str(e)}), 500


client_rooms = {}


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
        rooms_to_unsub = [r for r in rooms if r in active_streams]
        for room in rooms_to_unsub:
            active_streams.discard(room)
        for room in rooms_to_unsub:
            parts = room.rsplit("_", 1)
            if len(parts) == 2:
                symbol, timeframe = parts
                source = ModuleRegistry.get_data_source("moex")
                source.unsubscribe_realtime(symbol, timeframe)
    logger.info(f"Client disconnected: {request.sid}, cleaned {len(rooms)} rooms")


@socketio.on("subscribe")
def on_subscribe(data):
    try:
        symbol = data["symbol"]
        timeframe = data["timeframe"]
        source_name = data.get("source", "moex")
        room = f"{symbol}_{timeframe}"

        logger.info(f"[WS] Subscribe request: symbol={symbol} tf={timeframe} source={source_name} room={room}")

        join_room(room)
        with _streams_lock:
            client_rooms.setdefault(request.sid, set()).add(room)
            is_new = room not in active_streams
            if is_new:
                active_streams.add(room)
        logger.info(f"[WS] Client {request.sid} joined room {room}")

        if is_new:
            logger.info(f"[WS] Starting new stream for {room}")

            source = ModuleRegistry.get_data_source(source_name)
            logger.info(f"[WS] Got source: {source_name}, calling subscribe_realtime...")

            def on_candle(candle, s=symbol, t=timeframe):
                broadcast_candle(s, t, candle)

            source.subscribe_realtime(symbol, timeframe, on_candle)
        else:
            logger.info(f"[WS] Stream already active for {room}")

        emit("subscribed", {"room": room})
    except Exception as e:
        logger.error(f"Subscribe error: {e}")
        emit("error", {"msg": str(e)})


@socketio.on("unsubscribe")
def on_unsubscribe(data):
    try:
        room = f"{data['symbol']}_{data['timeframe']}"
        leave_room(room)
        with _streams_lock:
            client_rooms.get(request.sid, set()).discard(room)
            is_last = room in active_streams
            if is_last:
                active_streams.discard(room)
        if is_last:
            source = ModuleRegistry.get_data_source(data.get("source", "moex"))
            source.unsubscribe_realtime(data["symbol"], data["timeframe"])
        logger.info(f"Client {request.sid} unsubscribed from {room}")
    except Exception as e:
        emit("error", {"msg": str(e)})


if __name__ == "__main__":
    ModuleRegistry.auto_load(os.path.join(BACKEND_DIR, "data_sources"), "data_sources")
    logger.info(f"Loaded sources: {ModuleRegistry.list_data_sources()}")
    logger.info(f"Loaded indicators: {ModuleRegistry.list_indicators()}")
    logger.info("=== Open http://localhost:5000 in browser ===")
    socketio.run(app, host="localhost", port=5000, debug=os.environ.get("FLASK_DEBUG", "0") == "1")
