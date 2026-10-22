import { api } from "./api.js";
import { CHART_SETTINGS_KEY, CHART_SETTINGS_DEFAULTS } from "./constants.js";

const SAVE_DEBOUNCE = 2500;
let _timer = null;
let _loading = false;
let _lastSent = null;
// Ключи, удалённые в браузере. Сервер их не убирает сам: он мержит и ждёт
// явного null, иначе мёртвая настройка висела бы в settings.json вечно.
const _removedKeys = new Set();

const LEGACY_KEY_PREFIXES = ["trading-dashboard-candles-"];

// Ключи, которые больше нигде не читаются: перенесённое на сервер, удалённые
// модули, мусор от проверок. Флаги миграций (dash-*-migrated) удалять нельзя —
// иначе перенос повторится.
const DEAD_KEYS = [
  "trading-alerts",
  "trading-auto-levels",
  "trading-dashboard-vpp-settings",
  "trading-dashboard-cleanup-done",
  "probe",
  "test_b",
  "test_merge_b",
  "test_merge_c",
];

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
  const payload = _getAll();
  // Удалённые в браузере ключи сервер снимет только по явному null.
  for (const key of _removedKeys) payload[key] = null;
  if (!force && JSON.stringify(payload) === _lastSent) return;
  // Адрес сервера берётся из config.js: иначе фронт, выложенный отдельно,
  // писал бы настройки самому себе вместо торгового сервера.
  _lastSent = JSON.stringify(payload);
  api.saveSettings(payload)
    .then(() => { _removedKeys.clear(); })
    .catch(() => {
      _lastSent = null;
    });
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

function _migrateChartColors() {
  let changed = false;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("chart-settings")) continue;
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

/**
 * Оформление графика: одна общая настройка вместо набора по символам.
 *
 * Раньше ключ строился по символу, и цвет фона одной панели не доходил
 * до остальных. Значения общей настройки берём у того ключа, который
 * отличается от умолчаний, — иначе пользователь потерял бы выбранные
 * цвета. Ключи прошлой схемы (по идентификатору графика) в кандидаты
 * не попадают: их суффикс не похож на тикер.
 */
function _migrateChartSettings() {
  const prefix = CHART_SETTINGS_KEY + "-";
  const oldKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) oldKeys.push(key);
  }
  if (!oldKeys.length) return false;

  let chosen = null;
  for (const key of oldKeys) {
    const suffix = key.slice(prefix.length);
    if (!/^[A-ZА-ЯЁ0-9.\-]{1,20}$/i.test(suffix)) continue;
    let obj = null;
    try { obj = JSON.parse(localStorage.getItem(key) || "null"); } catch { obj = null; }
    if (!obj || typeof obj !== "object") continue;
    if (!chosen) chosen = obj;
    const differs = Object.entries(CHART_SETTINGS_DEFAULTS)
      .some(([k, v]) => obj[k] && obj[k] !== v);
    if (differs) { chosen = obj; break; }
  }

  let changed = false;
  if (!localStorage.getItem(CHART_SETTINGS_KEY)) {
    _origSetItem(CHART_SETTINGS_KEY, JSON.stringify(chosen || {}));
    changed = true;
  }
  // Старые ключи — и по символам, и по идентификаторам графика — больше
  // не читает никто.
  for (const key of oldKeys) {
    localStorage.removeItem(key);
    changed = true;
  }
  return changed;
}

/** Разовая чистка ключей, которые больше нигде не нужны. */
function _cleanupDeadKeys() {
  let changed = false;
  for (const key of DEAD_KEYS) {
    if (localStorage.getItem(key) === null) continue;
    localStorage.removeItem(key);
    changed = true;
  }
  return changed;
}

export async function loadFromServer() {  _loading = true;
  try {
    _purgeLegacyKeys();
    const data = await api.getSettings();
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
    let changed = _migrateChartColors();
    if (_migrateChartSettings()) changed = true;
    if (_cleanupDeadKeys()) changed = true;
    _loading = false;
    if (changed) _save();
  }
}

const _origSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function (key, value) {
  _origSetItem(key, value);
  _save();
};

const _origRemoveItem = localStorage.removeItem.bind(localStorage);
localStorage.removeItem = function (key) {
  _origRemoveItem(key);
  // Ключ надо ещё снять с сервера: он мержит и сам мёртвые не убирает.
  _removedKeys.add(key);
  _save();
};

export function flushNow() {
  _flush(true);
}