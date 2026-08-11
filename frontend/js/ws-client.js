import { log } from "./utils.js";

const TF_SECONDS = {
  "1m": 60, "5m": 300, "10m": 600, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
};

function floorTs(ts, tfSeconds) {
  return ts - (ts % tfSeconds);
}

export class WSClient {
  constructor(url = (location.protocol === "http:" || location.protocol === "https:") ? location.origin : "http://localhost:5000") {
    this.url = url;
    this.socket = null;
    this.subscriptions = new Map();
    this.handlers = {
      candleUpdate: [],
      statusChange: [],
      subscribed: [],
      tickerError: []
    };
    this.connected = false;
    this._pendingUpdates = new Map();
    this._flushTimer = null;
  }

  connect() {
    if (this.socket && this.connected) return;

    this.socket = io(this.url, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    this.socket.on("connect", () => {
      log("Socket.IO connected, id=" + this.socket.id);
      this.connected = true;
      this._resubscribeAll();
      this._emit("statusChange", "connected");
    });

    this.socket.on("disconnect", (reason) => {
      log("Socket.IO disconnected:", reason);
      this.connected = false;
      this._emit("statusChange", "disconnected");
    });

    this.socket.on("connect_error", (err) => {
      log("Socket.IO error:", err.message);
    });

    this.socket.on("candle_update", (data) => {
      const key = `${data.symbol}_${data.timeframe}`;
      this._pendingUpdates.set(key, data);
      if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => this._flushUpdates(), 16);
      }
    });

    this.socket.on("subscribed", (data) => {
      log("Subscribed to", data.room);
      this._emit("subscribed", data);
    });

    this.socket.on("error", (data) => {
      log("Server error:", data.msg);
    });

    this.socket.on("ticker_error", (data) => {
      this._emit("tickerError", data);
    });
  }

  subscribe(symbol, timeframe, source = "tinkoff") {
    const room = `${symbol}_${timeframe}`;
    this.subscriptions.set(room, { symbol, timeframe, source });
    if (this.connected) {
      this.socket.emit("subscribe", { symbol, timeframe, source });
    }
  }

  unsubscribe(symbol, timeframe, source = "tinkoff") {
    const room = `${symbol}_${timeframe}`;
    this.subscriptions.delete(room);
    if (this.connected) {
      this.socket.emit("unsubscribe", { symbol, timeframe, source });
    }
  }

  on(event, callback) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(callback);
  }

  _emit(event, ...args) {
    const list = this.handlers[event];
    if (list) list.forEach(cb => cb(...args));
  }

  _flushUpdates() {
    this._flushTimer = null;
    const now = Math.floor(Date.now() / 1000);
    for (const [key, data] of this._pendingUpdates) {
      const tfSeconds = TF_SECONDS[data.timeframe] || 60;
      if (data.candle && data.candle.time > floorTs(now, tfSeconds)) {
        log(`Ignoring future candle time=${data.candle.time} for ${key}`);
        continue;
      }
      this._emit("candleUpdate", data.symbol, data.timeframe, data.candle);
    }
    this._pendingUpdates.clear();
  }

  _resubscribeAll() {
    if (!this.connected) return;
    for (const [room, data] of this.subscriptions) {
      this.socket.emit("subscribe", data);
    }
  }
}
