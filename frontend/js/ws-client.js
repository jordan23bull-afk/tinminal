import { log } from "./utils.js";

export class WSClient {
  constructor(url = "http://localhost:5000") {
    this.url = url;
    this.socket = null;
    this.subscriptions = new Map();
    this.handlers = {
      candleUpdate: null,
      statusChange: null
    };
    this.connected = false;
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
      this._emit("candleUpdate", data.symbol, data.timeframe, data.candle);
    });

    this.socket.on("subscribed", (data) => {
      log("Subscribed to", data.room);
    });

    this.socket.on("error", (data) => {
      log("Server error:", data.msg);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.subscriptions.clear();
  }

  subscribe(symbol, timeframe, source = "mock") {
    const room = `${symbol}_${timeframe}`;
    this.subscriptions.set(room, { symbol, timeframe, source });
    if (this.connected) {
      this.socket.emit("subscribe", { symbol, timeframe, source });
    }
  }

  unsubscribe(symbol, timeframe) {
    const room = `${symbol}_${timeframe}`;
    this.subscriptions.delete(room);
    if (this.connected) {
      this.socket.emit("unsubscribe", { symbol, timeframe });
    }
  }

  on(event, callback) {
    this.handlers[event] = callback;
  }

  _emit(event, ...args) {
    if (this.handlers[event]) {
      this.handlers[event](...args);
    }
  }

  _resubscribeAll() {
    for (const [room, data] of this.subscriptions) {
      this.socket.emit("subscribe", data);
    }
  }
}
