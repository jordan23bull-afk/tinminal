const SAVE_DEBOUNCE = 2500;
let _timer = null;
let _loading = false;
let _lastSent = null;

const LEGACY_KEY_PREFIXES = ["trading-dashboard-candles-"];

function _isLegacyKey(key) {
  return LEGACY_KEY_PREFIXES.some(p => key.startsWith(p));
}

function _purgeLegacyKeys() {
  const toDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (_isLegacyKey(key)) toDelete.push(key);
  }
  toDelete.forEach(key => localStorage.removeItem(key));
}

function _getAll() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (_isLegacyKey(key)) continue;
    data[key] = localStorage.getItem(key);
  }
  return data;
}

function _flush(force = false) {
  _timer = null;
  const body = JSON.stringify(_getAll());
  if (!force && body === _lastSent) return;
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
    .then((res) => {
      if (res.ok) _lastSent = body;
      return res.json().catch(() => ({}));
    })
    .catch(() => {});
}

function _save() {
  if (_loading) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_flush, SAVE_DEBOUNCE);
}

// одноразовая миграция старых дефолтных цветов графиков на палитру rosn
const CHART_COLOR_MIGRATION = {
  "#26a69a": "#089982",
  "#ef5350": "#f23645",
  "#131722": "#0b0d10",
  "#242832": "#151a20",
};

function _migrateChartSettings() {
  let changed = false;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("chart-settings-")) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      let dirty = false;
      for (const [from, to] of Object.entries(CHART_COLOR_MIGRATION)) {
        for (const v of Object.values(obj)) {
          if (v === from) { dirty = true; break; }
        }
        if (!dirty) continue;
        for (const k of Object.keys(obj)) {
          if (obj[k] === from) obj[k] = to;
        }
      }
      if (dirty) {
        _origSetItem(key, JSON.stringify(obj));
        changed = true;
      }
    } catch { /* не валидный JSON — не трогаем */ }
  }
  return changed;
}

export async function loadFromServer() {  _loading = true;
  try {
    _purgeLegacyKeys();
    const res = await fetch("/api/settings");
    const data = await res.json();
    if (data && typeof data === "object") {
      for (const [key, val] of Object.entries(data)) {
        if (_isLegacyKey(key)) continue;
        if (localStorage.getItem(key) === null) {
          _origSetItem(key, val);
        }
      }
    }
  } catch (e) {
    console.warn("Could not load settings from server:", e);
  } finally {
    const migrated = _migrateChartSettings();
    _loading = false;
    if (migrated) _save();
  }
}

const _origSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function (key, value) {
  _origSetItem(key, value);
  _save();
};

export function flushNow() {
  _flush(true);
}