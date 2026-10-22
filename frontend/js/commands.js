// Отправка команд на сервер и разруливание подтверждений.
//
// Модель: вкладка — самостоятельный клиент. Сервер — источник истины,
// но другие вкладки об изменениях не узнают: они перечитывают общее
// состояние раскладки только при подключении. Так же устроен источник,
// откуда взяты наблюдения (docs/observations/05-two-tabs-and-layout-sync.md).
//
// Клиент отправляет команду и ждёт command_result с тем же req_id.
// Разбирать применение команд на клиенте не нужно: своё изменение
// вкладка применяет по ответу на команду.

import { store } from "./store.js";

let socket = null;
let protocolVersion = null;
let mismatchReason = null;

const pending = new Map();
let seq = 0;

/**
 * Идентификатор вкладки — ключ журнала отмены.
 *
 * Журнал на сервере общий для раскладки, но отменяет вкладка только свои
 * действия: у источника Ctrl+Z действует на вкладку, а не на раскладку.
 * Идентификатор живёт только в памяти страницы: после перезагрузки история
 * отмены не сохраняется, как и у источника.
 */
function makeTabId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (err) {
    /* генератор недоступен — берём запасной */
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const tabId = makeTabId();

export function attachSocket(io) {
  socket = io;
}

/**
 * Дождаться готовности сокета.
 *
 * Socket.IO подключается асинхронно, поэтому команду нельзя отправлять сразу
 * после connect(): на тот момент соединения ещё нет и сервер команду не увидит.
 */
export function waitForSocket(timeoutMs = 8000) {
  if (socket && socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    if (!socket) return resolve(false);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.off("connect", onOk);
      clearTimeout(timer);
      resolve(value);
    };
    const onOk = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", onOk);
    if (socket.connected) finish(true);
  });
}

export function getProtocolVersion() {
  return protocolVersion;
}

export function getMismatchReason() {
  return mismatchReason;
}

function request(kind, payload) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(new Error("Нет соединения с сервером"));
      return;
    }
    const reqId = `c${++seq}-${Date.now().toString(36)}`;
    pending.set(reqId, { resolve, reject, kind });
    socket.emit("command", { req_id: reqId, kind, payload, tab_id: tabId });
  });
}

/**
 * Результат собственной команды применяем у себя.
 *
 * Сервер не рассылает событие обратно отправителю (иначе он получил бы
 * команду дважды), поэтому без этого шага вкладка, нажавшая кнопку,
 * осталась бы со старым состоянием до перезагрузки.
 */
function applyOwnResult(kind, data) {
  if (!data) return;
  // Массовые команды возвращают удалённое: без этого вкладка, где
  // нажали «Очистить», продолжала бы показывать стёртые линии.
  if (Array.isArray(data.removed_objects)) {
    data.removed_objects.forEach((o) => store.dropObject(o.id));
  }
  if (Array.isArray(data.removed_alerts)) {
    data.removed_alerts.forEach((a) => store.dropAlert(a.id));
  }
  if (Array.isArray(data.created_alerts)) {
    data.created_alerts.forEach((a) => store.putAlert(a));
  }
  if (Array.isArray(data.objects)) {
    data.objects.forEach((o) => store.putObject(o));
  } else if (data.object) {
    store.putObject(data.object);
  } else if (data.alert) {
    store.putAlert(data.alert);
  } else if (kind === "object.delete" && data.deleted) {
    store.dropObject(data.deleted);
  } else if (kind === "alert.delete" && data.deleted) {
    store.dropAlert(data.deleted);
  }

  // Переименование раскладки: сервер вернул обновлённую запись, а другой
  // вкладке о ней не сообщают — применяем у себя.
  if (data.layout && (!store.layoutId || data.layout.id === store.layoutId)) {
    store.layout = data.layout;
    store.emit("layout", data.layout);
  }
  if (kind === "layout.delete" && data.deleted) {
    store.emit("layouts", { removed: data.deleted });
  }
}

export function onCommandResult(data) {
  const entry = pending.get(data.req_id);
  if (!entry) return;
  pending.delete(data.req_id);
  if (data.ok) {
    if (data.kind && data.kind !== "undo" && data.kind !== "redo") {
      applyOwnResult(data.kind, data.data);
    }
    entry.resolve(data);
  } else entry.reject(Object.assign(new Error(data.error || "Команда отклонена"), { code: data.code }));
}

export function onHello(data) {
  protocolVersion = data.protocol_version ?? null;
  mismatchReason = null;
}

export function onProtocolMismatch(data) {
  mismatchReason = data.message || "Несовместимые версии клиента и сервера";
  store.setOnline(false);
}

/** Команды, меняющие состояние. Все проходят через шину команд сервера. */
export const commands = {
  layoutCreate: (payload) => request("layout.create", payload),
  layoutRename: (layoutId, name) => request("layout.rename", { layout_id: layoutId, name }),
  layoutDelete: (layoutId) => request("layout.delete", { layout_id: layoutId }),

  // Геометрия панелей — часть состояния раскладки, поэтому меняется
  // командой: её можно отменить и она переживает перезагрузку.
  setGrid: (layoutId, grid) => request("layout.set_grid", { layout_id: layoutId, ...grid }),

  objectCreate: (payload) => request("object.create", payload),
  objectCreateMany: (layoutId, objects) =>
    request("object.create_many", { layout_id: layoutId, objects }),
  objectUpdate: (id, patch) => request("object.update", { id, ...patch }),
  objectDelete: (id) => request("object.delete", { id }),
  objectClearSymbol: (layoutId, symbol) =>
    request("object.clear_symbol", { layout_id: layoutId, symbol }),

  // Уровни ATR-сканера: одна команда ставит и линии, и алерты на них.
  setAutoLevels: (layoutId, symbol, levels, timeframe) =>
    request("object.set_auto_levels", {
      layout_id: layoutId, symbol, timeframe, ...levels
    }),

  alertCreate: (payload) => request("alert.create", payload),
  alertUpdate: (id, patch) => request("alert.update", { id, ...patch }),
  alertDelete: (id) => request("alert.delete", { id }),

  setSymbol: (layoutId, chartIndex, symbol) =>
    request("chart.set_symbol", { layout_id: layoutId, chart_index: chartIndex, symbol }),
  setTimeframe: (layoutId, chartIndex, timeframe) =>
    request("chart.set_timeframe", { layout_id: layoutId, chart_index: chartIndex, timeframe }),
  setChartType: (layoutId, chartIndex, chartType) =>
    request("chart.set_type", { layout_id: layoutId, chart_index: chartIndex, chart_type: chartType }),

  undo(layoutId) {
    return new Promise((resolve, reject) => {
      if (!socket || !socket.connected) return reject(new Error("Нет соединения с сервером"));
      const reqId = `u${++seq}`;
      pending.set(reqId, { resolve, reject, kind: "undo" });
      socket.emit("command_undo", { req_id: reqId, layout_id: layoutId, tab_id: tabId });
    });
  },

  redo(layoutId) {
    return new Promise((resolve, reject) => {
      if (!socket || !socket.connected) return reject(new Error("Нет соединения с сервером"));
      const reqId = `r${++seq}`;
      pending.set(reqId, { resolve, reject, kind: "redo" });
      socket.emit("command_redo", { req_id: reqId, layout_id: layoutId, tab_id: tabId });
    });
  },
};

/**
 * Привязка клиента к раскладке: сервер присылает полное состояние.
 *
 * Ответ приходит событием state_sync, а не command_result, поэтому
 * ожидание ведётся отдельной картой: иначе промис никогда не резолвится
 * и загрузка страницы встаёт.
 */
const pendingAttach = new Map();

export function attachLayout(layoutId) {
  store.layoutId = layoutId;
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) return reject(new Error("Нет соединения с сервером"));
    const reqId = `a${++seq}`;
    pendingAttach.set(reqId, { resolve, reject });
    socket.emit("layout_attach", { req_id: reqId, layout_id: layoutId, tab_id: tabId });
  });
}

export function onStateSync(payload) {
  store.applyStateSync(payload);
  // Резолвим последнее ожидание привязки, если оно есть.
  if (pendingAttach.size > 0) {
    const [reqId, entry] = pendingAttach.entries().next().value;
    pendingAttach.delete(reqId);
    entry.resolve(payload);
  }
}

/** Разбор событий сервера в зеркало состояния. */
export function bindServerEvents() {
  if (!socket) return;

  socket.on("connect", () => store.setOnline(true));
  socket.on("disconnect", () => store.setOnline(false));
  socket.on("hello", onHello);
  socket.on("protocol_mismatch", onProtocolMismatch);
  socket.on("command_result", onCommandResult);

  // Полное состояние раскладки: при подключении и после отмены/повтора.
  socket.on("state_sync", (payload) => onStateSync(payload));

  // Доступность отмены/повтора меняется после каждой команды вкладки.
  socket.on("history_changed", (d) => store.setHistoryState(d.can_undo, d.can_redo));

  // Событий object_added / object_updated / object_removed / alert_added /
  // chart_changed больше нет: вкладки не получают изменения друг друга.
  // Свои изменения вкладка применяет по ответу на команду.
  // Сработавший алерт приходит отдельно через ws-client: это уведомление,
  // а не изменение состояния раскладки, и оно адресное — всем вкладкам
  // раскладки, как у источника.
}