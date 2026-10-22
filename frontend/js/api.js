// REST-клиент к серверу состояния.
// Единая точка, где живёт адрес сервера и единая обработка ошибок.

import { apiUrl } from "./config.js";

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Единая точка HTTP-обмена с сервером.
 *
 * Адрес берётся из config.js — фронтенд можно вынести на другой хост
 * без правок кода. Пятый аргумент opts позволяет передать signal:
 * без него нельзя отменить устаревший запрос истории.
 */
async function request(method, path, body, opts = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  if (opts.signal) options.signal = opts.signal;
  let res;
  try {
    res = await fetch(apiUrl(path), options);
  } catch (err) {
    throw new ApiError(`Сервер недоступен: ${err.message}`, 0, null);
  }
  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const msg = (payload && payload.error) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, payload);
  }
  return payload;
}

export const api = {
  health: () => request("GET", "/api/health"),
  sources: () => request("GET", "/api/sources"),

  listLayouts: () => request("GET", "/api/layouts"),
  createLayout: (payload) => request("POST", "/api/layouts", payload),
  getLayout: (id) => request("GET", `/api/layout/${encodeURIComponent(id)}`),
  saveLayoutState: (id, state, version) =>
    request("PUT", `/api/layout/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`, { state }),
  deleteLayout: (id) => request("DELETE", `/api/layout/${encodeURIComponent(id)}`),

  sendCommand: (id, kind, payload) =>
    request("POST", `/api/layout/${encodeURIComponent(id)}/command`, { kind, payload }),
  undo: (id) => request("POST", `/api/layout/${encodeURIComponent(id)}/undo`),
  redo: (id) => request("POST", `/api/layout/${encodeURIComponent(id)}/redo`),

  history: (symbol, timeframe, limit = 3000, signal) =>
    request("POST", "/api/history", { source: "tinkoff", symbol, timeframe, limit }, { signal }),
  lookup: (symbol) => request("GET", `/api/lookup?symbol=${encodeURIComponent(symbol)}`),
  prices: (symbols) => request("GET", `/api/prices?symbols=${symbols.join(",")}`),
  scanAtr: (threshold, date) => request("POST", "/api/scan/atr", { atr_threshold: threshold, date }),
  lastTradingDay: () => request("GET", "/api/scan/last-trading-day"),

  // Настройки — плоский словарь «ключ → строка»: в них лежит всё,
  // что раньше хранилось в localStorage.
  getSettings: () => request("GET", "/api/settings"),
  saveSettings: (settings) => request("POST", "/api/settings", settings),
};