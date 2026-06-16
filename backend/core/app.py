import os
import sys
import logging
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

active_streams = {}


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


@app.route("/api/history", methods=["POST"])
def history():
    try:
        req = request.json
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


@socketio.on("connect")
def on_connect():
    logger.info(f"Client connected: {request.sid}")
    emit("status", {"msg": "Connected"})


@socketio.on("disconnect")
def on_disconnect():
    logger.info(f"Client disconnected: {request.sid}")


@socketio.on("subscribe")
def on_subscribe(data):
    try:
        symbol = data["symbol"]
        timeframe = data["timeframe"]
        source_name = data.get("source", "moex")
        room = f"{symbol}_{timeframe}"

        logger.info(f"[WS] Subscribe request: symbol={symbol} tf={timeframe} source={source_name} room={room}")

        join_room(room)
        logger.info(f"[WS] Client {request.sid} joined room {room}")

        if room not in active_streams:
            active_streams[room] = True
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
        logger.info(f"Client {request.sid} unsubscribed from {room}")
    except Exception as e:
        emit("error", {"msg": str(e)})


if __name__ == "__main__":
    ModuleRegistry.auto_load(os.path.join(BACKEND_DIR, "data_sources"), "data_sources")
    ModuleRegistry.auto_load(os.path.join(BACKEND_DIR, "indicators"), "indicators")
    logger.info(f"Loaded sources: {ModuleRegistry.list_data_sources()}")
    logger.info(f"Loaded indicators: {ModuleRegistry.list_indicators()}")
    logger.info("=== Open http://localhost:5000 in browser ===")
    socketio.run(app, host="localhost", port=5000, debug=True)
