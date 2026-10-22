import { ChartManager } from "./chart-manager.js";
import { WSClient } from "./ws-client.js";
import { LayoutManager } from "./layout-manager.js";
import { generateId, log, cssVar } from "./utils.js";
import { calcIndicator, mergeIndicators, loadCustomIndicators } from "./indicators.js";
import { loadTickers, saveTickers, addTicker, removeTicker, toggleFlag, getTickerFlag, loadFlags, saveFlags, refreshAllSymbolDropdowns } from "./tickers.js";
import { loadFromServer, flushNow } from "./storage.js";
import { initScanner } from "./scanner.js";
import { api } from "./api.js";
import { store } from "./store.js";
import { attachSocket, attachLayout, bindServerEvents, waitForSocket, getMismatchReason, commands } from "./commands.js";
import { getTool } from "./drawings/tools/registry.js";

let selectedTimeframe = "1h";
let isLoading = false;
const activeFetchControllers = new Map();

mergeIndicators();
// Защита от эха: пока применяем чужое изменение с сервера, отправлять
// команду обратно нельзя, иначе две вкладки будут бесконечно гонять команду.
let applyingRemote = 0;
const isApplyingRemote = () => applyingRemote > 0;

function remoteApply(fn) {
  applyingRemote++;
  try {
    fn();
  } finally {
    applyingRemote--;
  }
}

/**
 * Пользовательское изменение графика идёт через шину команд:
 * сервер становится источником истины. Другие вкладки об изменении
 * не узнают — у них своя независимая копия состояния.
 */
async function onChartChange(chartId, symbol, timeframe, source, chartType) {
  await loadHistory(chartId, symbol, timeframe, source, chartType);
  if (isApplyingRemote() || !store.layoutId) return;

  const index = chartManager.getAllChartIds().indexOf(chartId);
  if (index < 0) return;
  const current = store.chart(index);

  try {
    // Сервер не рассылает событие обратно отправителю, поэтому своё же
    // изменение применяем локально: иначе вкладка осталась бы
    // с прежним значением, пока не перезагрузишь страницу.
    if (symbol && current.symbol !== symbol) {
      await commands.setSymbol(store.layoutId, index, symbol);
      store.setChartField(index, "symbol", symbol);
    } else if (timeframe && current.timeframe !== timeframe) {
      await commands.setTimeframe(store.layoutId, index, timeframe);
      store.setChartField(index, "timeframe", timeframe);
    } else if (chartType && (current.chart_type || current.chartType) !== chartType) {
      await commands.setChartType(store.layoutId, index, chartType);
      store.setChartField(index, "chart_type", chartType);
    }
  } catch (err) {
    log("Не удалось отправить изменение графика:", err);
  }
}

/**
 * Применяем изменения раскладки, пришедшие с сервера, к открытым графикам.
 *
 * Только снимок с сервера: свои изменения вкладка применяет сама, и реакция
 * на них замыкалась в кольцо — панель расходилась с записью в пуле,
 * обработчик звал changeSymbol, тот менял все панели разом (так работает
 * синхронизация), и расхождение возникало снова.
 */
function bindServerUi() {
  // Снимок с сервера: к нему применяем состояние к графикам.
  store.on("stateCharts", (charts) => {
    const ids = chartManager.getAllChartIds();
    charts.forEach((cfg, i) => {
      const chartId = ids[i];
      const chartObj = chartManager.charts.get(chartId);
      if (!chartId || !chartObj) return;
      const symbol = cfg.symbol;
      const timeframe = cfg.timeframe;
      const type = cfg.chart_type || cfg.chartType;
      const current = chartObj.config;

      remoteApply(() => {
        if (symbol && current.symbol && symbol !== current.symbol) {
          chartManager.changeSymbol(symbol, cfg.source || undefined, chartId);
        } else if (timeframe && current.timeframe && timeframe !== current.timeframe) {
          chartManager.changeTimeframe(timeframe, chartId);
        } else if (type && current.chartType && type !== current.chartType) {
          chartManager.changeChartType(chartId, type);
        }
      });
    });
  });

  // Панель инструментов повторяет состояние активного графика: и своё
  // изменение, и снимок с сервера.
  store.on("charts", (charts) => syncToolbarFromStore(charts));
  store.on("stateCharts", (charts) => syncToolbarFromStore(charts));

  // Геометрия панелей — часть состояния раскладки. Число панелей
  // изменилось (отмена, другая вкладка) — перестраиваем их; вариант
  // сетки — просто применяем.
  store.on("layout", (layout) => {
    const grid = layout?.state?.layout;
    if (!grid) return;
    const current = chartManager.getAllChartIds().length;
    if (grid.count !== current) {
      currentLayoutCount = grid.count;
      currentLayoutOption = layoutManager.optionForGrid(grid);
      layoutTriggerText.textContent = grid.count;
      rebuildPanels(grid.count, grid, panelConfigs(grid.count));
    } else {
      layoutManager.applyGrid(grid);
    }
  });
}

/**
 * Панель инструментов повторяет состояние активного графика.
 *
 * После отмены график возвращается к прежнему виду — значит и поле символа
 * обязано показывать прежнее значение, а не то, что было введено руками.
 */
function syncToolbarFromStore(charts) {
  const ids = chartManager.getAllChartIds();
  let index = ids.indexOf(chartManager.activeChartId);
  if (index < 0) index = 0;
  const cfg = (charts || [])[index] || {};
  if (cfg.symbol) symbolInput.value = cfg.symbol;
  if (cfg.timeframe) selectedTimeframe = cfg.timeframe;
  sourceSelect.value = normalizeSource(cfg.source);
}

const chartManager = new ChartManager("charts-grid", onChartChange);
chartManager.onActiveChartChange = syncWatchlistLiveStatus;
const wsClient = new WSClient();
const layoutManager = new LayoutManager(document.getElementById("charts-grid"));

// ------------------------------------------------ server-side POC
chartManager.onPocNeeds = (needs) => {
  if (!needs || needs.length === 0) return;
  for (const n of needs) {
    const { symbol, windowMin, leave } = n;
    if (!symbol) continue;
    if (leave) {
      wsClient.unsubscribePoc(symbol, windowMin);
    } else {
      wsClient.subscribePoc(symbol, windowMin);
    }
  }
};

wsClient.on("pocSnapshot", (data) => {
  chartManager.applyPocSnapshot(data);
});

wsClient.on("pocUpdate", (data) => {
  chartManager.applyPocUpdate(data);
});
// ----------------------------------------------------------------

const sourceSelect = document.getElementById("source-select");
const symbolInput = document.getElementById("symbol-input");
const statusText = document.getElementById("status-text");
const connectionStatus = document.getElementById("status-connection");
const currentTimeEl = document.getElementById("current-time");

// Auto-connect on startup
wsClient.on("statusChange", (status) => {
  if (status === "connected") {
    connectionStatus.textContent = "Connected";
    connectionStatus.className = "status-connected";
  } else {
    connectionStatus.textContent = "Disconnected";
    connectionStatus.className = "status-disconnected";
  }
});

wsClient.on("candleUpdate", (symbol, timeframe, candle) => {
  let consumed = false;
  for (const [id, chartObj] of chartManager.charts) {
    if (chartObj.config.symbol === symbol && chartObj.config.timeframe === timeframe) {
      chartManager.updateCandle(id, candle);
      consumed = true;
    }
  }
  // Алерты проверяет сервер на каждой свече — клиенту смотреть тут нечего.
});

wsClient.on("tickerError", (info) => {
  if (!info || !info.symbol) return;
  log("Ticker error:", info);
  statusText.textContent = `${info.symbol}: ${info.msg || "ошибка подписки"}`;
  setTickerStatus(info.symbol, "error");
});

wsClient.on("subscribed", (data) => {
  if (!data || !data.symbol) return;
  const item = document.querySelector(`.watchlist-item[data-symbol="${CSS.escape(data.symbol)}"]`);
  if (item) {
    const src = item.dataset.source || "tinkoff";
    if (!src || data.source === src || data.source === "tinkoff") {
      setTickerStatus(data.symbol, "live");
    }
  }
});

wsClient.on("alertFired", (data) => onAlertFired(data));

const TICKER_STATUS_LABEL = {
  loading: "Загрузка",
  live: "Live",
  error: "Ошибка",
  idle: "Готов",
};

function setTickerStatus(symbol, status) {
  const item = document.querySelector(`.watchlist-item[data-symbol="${CSS.escape(symbol)}"]`);
  if (item) {
    item.classList.toggle("wl-loading", status === "loading");
    item.classList.toggle("wl-error", status === "error");
    item.title = TICKER_STATUS_LABEL[status] || status;
  }
}

function isActiveChartSymbol(symbol) {
  const chartObj = chartManager.activeChartId ? chartManager.charts.get(chartManager.activeChartId) : null;
  return !!chartObj && chartObj.config.symbol === symbol;
}

function syncWatchlistLiveStatus() {
  // зелёный = символ активного графика, и только он; раньше селектор .wl-live
  // не давал включить подсветку на тикере, который её ещё не имел
  document.querySelectorAll(".watchlist-item").forEach(item => {
    item.classList.toggle("wl-live", isActiveChartSymbol(item.dataset.symbol));
  });
}

function syncTickerSubscriptions() {
  const rooms = new Set();
  for (const [, chartObj] of chartManager.charts) {
    if (!chartObj.config.symbol || !chartObj.config.timeframe) continue;
    rooms.add(`${chartObj.config.symbol}_${chartObj.config.timeframe}`);
  }
  // символы с алертами, но без открытого графика: держим live-подписку 1m,
  // чтобы алерты ловили пересечение уровня по полной свече (high/low)
  for (const a of chartManager.alerts) {
    const sym = String(a.symbol || "").toUpperCase();
    if (!sym) continue;
    const onChart = [...chartManager.charts.values()].some(c => c.config.symbol === sym);
    if (!onChart) rooms.add(`${sym}_1m`);
  }
  for (const [room, sub] of wsClient.subscriptions) {
    if (!rooms.has(room)) {
      wsClient.unsubscribe(sub.symbol, sub.timeframe, sub.source);
      setTickerStatus(sub.symbol, "idle");
    }
  }
  for (const room of rooms) {
    if (wsClient.subscriptions.has(room)) continue;
    if (!wsClient.connected) continue;
    const i = room.lastIndexOf("_");
    if (i <= 0) continue;
    const symbol = room.slice(0, i);
    const timeframe = room.slice(i + 1);
    wsClient.subscribe(symbol, timeframe);
  }
}

function syncPocSubscriptions() {
  const wanted = new Map(); // "SYM:win" -> {symbol, windowMin}
  for (const [, chartObj] of chartManager.charts) {
    const symbol = chartObj.config.symbol;
    if (!symbol) continue;
    for (const indId of Object.keys(chartObj.indicators)) {
      if (!chartManager.isPoc(indId)) continue;
      const windowMin = chartManager._pocWindow(chartObj, indId);
      const key = `${symbol}:${windowMin}`;
      if (!wanted.has(key)) wanted.set(key, { symbol, windowMin });
    }
  }
  for (const [key, sub] of wsClient.pocSubscriptions) {
    if (!wanted.has(key)) {
      wsClient.unsubscribePoc(sub.symbol, sub.windowMin);
    }
  }
  for (const [, sub] of wanted) {
    wsClient.subscribePoc(sub.symbol, sub.windowMin);
  }
}

wsClient.connect();

// Watchlist
let currentFilter = "all";

let activeFlagColor = null;
const FLAG_COLORS = {
  red: cssVar("--accent-red"),
  green: cssVar("--accent-green"),
  yellow: cssVar("--accent-yellow"),
};

function createWatchlistItemEl(ticker, source) {
  const div = document.createElement("div");
  div.className = "watchlist-item";
  div.dataset.symbol = ticker;
  div.dataset.source = source;
  const flag = getTickerFlag(ticker);
  div.dataset.flag = flag || "";
  const flagStyle = flag ? ` style="background:${FLAG_COLORS[flag]}"` : "";
  div.innerHTML = `<div class="wl-col wl-col-symbol"><span class="wl-flag-left"${flagStyle}></span><div class="wl-icon">${ticker.charAt(0)}</div><span class="wl-symbol">${ticker}</span></div><div class="wl-col wl-col-change"><span class="wl-change">—</span></div><div class="wl-col wl-col-volume"><span class="wl-price">—</span></div>`;
  setupWatchlistItem(div);
  const flagEl = div.querySelector(".wl-flag-left");
  flagEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (flagEl.style.background) {
      toggleFlag(ticker, div.dataset.flag);
      flagEl.style.background = "";
      div.dataset.flag = "";
    } else if (activeFlagColor) {
      toggleFlag(ticker, activeFlagColor);
      flagEl.style.background = FLAG_COLORS[activeFlagColor];
      div.dataset.flag = activeFlagColor;
    }
    if (currentFilter !== "all") renderWatchlist();
  });
  return div;
}

const BOARD_LABELS = { TQBR: "Акции", FORTS: "Фьючерсы", INDEX: "Индексы" };

function renderWatchlist() {
  const container = document.getElementById("watchlist-items");
  container.innerHTML = "";
  const list = loadTickers();
  const groups = {};
  for (const t of list) {
    const board = t.board || "TQBR";
    if (currentFilter !== "all" && getTickerFlag(t.ticker) !== currentFilter) continue;
    (groups[board] || (groups[board] = [])).push(t);
  }
  for (const board of ["TQBR", "FORTS", "INDEX"]) {
    const items = groups[board];
    if (!items || items.length === 0) continue;
    const header = document.createElement("div");
    header.className = "wl-group-header";
    header.textContent = BOARD_LABELS[board] || board;
    container.appendChild(header);
    items.forEach(t => container.appendChild(createWatchlistItemEl(t.ticker, normalizeSource(t.source || "tinkoff"))));
  }
  refreshAllSymbolDropdowns();
  applyColumnWidths(loadColumnWidths());
  updateWatchlistPrices();
}

function setupWatchlistItem(item) {
  item.addEventListener("click", (e) => {
    if (e.target.closest(".wl-delete")) return;
    document.querySelectorAll(".watchlist-item").forEach(i => i.classList.remove("selected"));
    item.classList.add("selected");
    const symbol = item.dataset.symbol;
    const source = normalizeSource(item.dataset.source || "tinkoff");
    if (chartManager.charts.size === 0) {
      loadHistory(null, symbol, null, source);
    } else {
      // Активная панель берётся только если она ещё есть: после смены
      // сетки идентификатор мог остаться от снятой панели, и клик по
      // тикеру молча ничего не делал.
      let activeId = chartManager.activeChartId;
      if (!activeId || !chartManager.charts.has(activeId)) {
        activeId = chartManager.getAllChartIds()[0] || null;
        if (activeId) chartManager.setActiveChart(activeId);
      }
      if (!activeId) {
        loadHistory(null, symbol, null, source);
        return;
      }
      chartManager.changeSymbol(symbol, source, activeId);
    }
    symbolInput.value = symbol;
    sourceSelect.value = source;
  });

  if (!item.querySelector(".wl-delete")) {
    const del = document.createElement("button");
    del.className = "wl-delete";
    del.innerHTML = "🗑";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const ticker = item.dataset.symbol;
      const source = item.dataset.source || "tinkoff";
      for (const [id, chartObj] of [...chartManager.charts]) {
        if (chartObj.config.symbol === ticker) {
          wsClient.unsubscribe(ticker, chartObj.config.timeframe || selectedTimeframe, source);
          chartManager.removeChart(id);
        }
      }
      item.remove();
      removeTicker(ticker);
      refreshAllSymbolDropdowns();
      syncTickerSubscriptions();
      syncPocSubscriptions();
    });
    item.appendChild(del);
  }
}

// Отрисовка вочлиста выполняется в boot() ниже.
// Раньше она шла на верхнем уровне модуля, то есть ДО loadFromServer(),
// из-за чего тикеры с сервера затирались дефолтами при первом же сохранении.

// "+" button in watchlist
const addTickerBtn = document.querySelector(".watchlist-header .icon-btn-sm");
if (addTickerBtn) {
  addTickerBtn.addEventListener("click", async () => {
    const input = prompt("Введите тикер (например TATN, ROSN, BANE):");
    if (!input) return;
    const ticker = input.toUpperCase().trim();
    if (!ticker) return;
    try {
      const data = await api.lookup(ticker);
      if (!addTicker(data.ticker || ticker, data.name || ticker)) {
        alert(`Тикер ${ticker} уже есть в вочлисте`);
        return;
      }
      renderWatchlist();
    } catch (e) {
      log("Ticker lookup error:", e);
      // 404 — тикера нет у брокера, остальное — сбой связи или сервера.
      if (e.status === 404) alert(`Тикер ${ticker} не найден на бирже`);
      else if (e.status) alert(`Не удалось проверить тикер ${ticker}. Попробуйте ещё раз.`);
      else alert(`Не удалось проверить тикер ${ticker}`);
    }
  });
}

// Watchlist filter dropdown
const wlFilterTrigger = document.getElementById("wl-filter-trigger");
const wlFilterDropdown = document.getElementById("wl-filter-dropdown");

if (wlFilterTrigger && wlFilterDropdown) {
  wlFilterTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    wlFilterDropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!wlFilterTrigger.contains(e.target) && !wlFilterDropdown.contains(e.target)) {
      wlFilterDropdown.classList.add("hidden");
    }
  });

  wlFilterDropdown.querySelectorAll(".wl-filter-item").forEach(item => {
    item.addEventListener("click", () => {
      wlFilterDropdown.querySelectorAll(".wl-filter-item").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      currentFilter = item.dataset.filter;
      renderWatchlist();
      wlFilterDropdown.classList.add("hidden");
    });
  });
}

// Flag mode buttons
document.querySelectorAll(".wl-flag-mode").forEach(btn => {
  btn.addEventListener("click", () => {
    const color = btn.dataset.color;
    if (activeFlagColor === color) {
      activeFlagColor = null;
      btn.classList.remove("active");
    } else {
      activeFlagColor = color;
      document.querySelectorAll(".wl-flag-mode").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    }
  });
});

// Sidebar resize
const sidebarResize = document.getElementById("sidebar-resize");
const sidebarRight = document.querySelector(".sidebar-right");
if (sidebarResize && sidebarRight) {
  let startX, startW;
  sidebarResize.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebarRight.offsetWidth;
    sidebarResize.classList.add("active");
    const onMove = (e) => {
      const w = startW - (e.clientX - startX);
      sidebarRight.style.width = Math.max(120, Math.min(w, 500)) + "px";
    };
    const onUp = () => {
      sidebarResize.classList.remove("active");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// Watchlist column resize
const WL_COLS_KEY = "trading-dashboard-wl-columns";

function loadColumnWidths() {
  try {
    const raw = localStorage.getItem(WL_COLS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveColumnWidths(widths) {
  localStorage.setItem(WL_COLS_KEY, JSON.stringify(widths));
}

function applyColumnWidths(widths) {
  if (!widths) return;
  const header = document.getElementById("wl-columns-header");
  const items = document.querySelectorAll(".watchlist-items .watchlist-item");
  for (const [colName, w] of Object.entries(widths)) {
    const colEl = header?.querySelector(`.wl-col-${colName}`);
    if (colEl) { colEl.style.width = w + "px"; colEl.style.flex = "0 0 " + w + "px"; }
    items.forEach(item => {
      const col = item.querySelector(`.wl-col-${colName}`);
      if (col) { col.style.width = w + "px"; col.style.flex = "0 0 " + w + "px"; }
    });
  }
}

function getColumnWidths() {
  const header = document.getElementById("wl-columns-header");
  if (!header) return {};
  const widths = {};
  header.querySelectorAll(".wl-col").forEach(col => {
    const name = [...col.classList].find(c => c.startsWith("wl-col-") && c !== "wl-col-resize")?.replace("wl-col-", "");
    if (name) widths[name] = col.offsetWidth;
  });
  return widths;
}

function setupColumnResize() {
  const header = document.getElementById("wl-columns-header");
  if (!header) return;

  applyColumnWidths(loadColumnWidths());

  const resizeHandles = header.querySelectorAll(".wl-col-resize");

  resizeHandles.forEach(handle => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const colName = handle.dataset.col;
      const colEl = header.querySelector(`.wl-col-${colName}`);
      const startX = e.clientX;
      const startW = colEl.offsetWidth;

      const headerCols = header.querySelectorAll(".wl-col");
      const items = document.querySelectorAll(".watchlist-items .watchlist-item");

      const onMove = (e) => {
        const diff = e.clientX - startX;
        const newW = Math.max(40, startW + diff);
        colEl.style.width = newW + "px";
        colEl.style.flex = "0 0 " + newW + "px";
        items.forEach(item => {
          const col = item.querySelector(`.wl-col-${colName}`);
          if (col) {
            col.style.width = newW + "px";
            col.style.flex = "0 0 " + newW + "px";
          }
        });
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        saveColumnWidths(getColumnWidths());
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}
setupColumnResize();

// Sort by change % on column header click
let priceChanges = {};
let sortMode = null;
let symbolSortMode = null;

const symbolCol = document.querySelector(".wl-columns-header .wl-col-symbol");
if (symbolCol) {
  symbolCol.style.cursor = "pointer";
  symbolCol.addEventListener("click", () => {
    const list = loadTickers();
    if (list.length === 0) return;

    if (symbolSortMode === "asc") {
      symbolSortMode = "desc";
    } else {
      symbolSortMode = "asc";
    }

    const groups = {};
    list.forEach(t => {
      const b = t.board || "TQBR";
      (groups[b] || (groups[b] = [])).push(t);
    });
    list.length = 0;
    for (const board of ["TQBR", "FORTS", "INDEX"]) {
      const g = groups[board];
      if (!g) continue;
      g.sort((a, b) => {
        const cmp = String(a.ticker).localeCompare(String(b.ticker));
        return symbolSortMode === "asc" ? cmp : -cmp;
      });
      list.push(...g);
    }

    saveTickers();
    renderWatchlist();
  });
}

const changeCol = document.querySelector(".wl-columns-header .wl-col-change");
if (changeCol) {
  changeCol.style.cursor = "pointer";
  changeCol.addEventListener("click", () => {
    const list = loadTickers();
    if (list.length === 0) return;

    if (sortMode === "asc") {
      sortMode = "desc";
    } else {
      sortMode = "asc";
    }

    const groups = {};
    list.forEach(t => {
      const b = t.board || "TQBR";
      (groups[b] || (groups[b] = [])).push(t);
    });
    list.length = 0;
  for (const board of ["TQBR", "FORTS", "INDEX"]) {
      const g = groups[board];
      if (!g) continue;
      g.sort((a, b) => {
        const aVal = priceChanges[a.ticker] ?? -Infinity;
        const bVal = priceChanges[b.ticker] ?? -Infinity;
        return sortMode === "asc" ? aVal - bVal : bVal - aVal;
      });
      list.push(...g);
    }

    saveTickers();
    renderWatchlist();
  });
}

// Update clock
function updateClock() {
  currentTimeEl.textContent = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    timeZone: "Europe/Moscow",
  }) + " MSK";
}
setInterval(updateClock, 1000);
updateClock();

// Tools
// Линия одноразовая: выбрал, поставил — режим выключился сам.
// Стиралка и магнит, наоборот, залипают намеренно: ими удобно работать
// несколькими кликами подряд.
const CROSSHAIR_TOOL = "crosshair";

function selectTool(name) {
  document.querySelectorAll(".tool-btn[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === name);
  });
  chartManager._activeTool = name;
}

chartManager.onToolReset = () => selectTool(CROSSHAIR_TOOL);

document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tool;
    if (name === CROSSHAIR_TOOL) {
      selectTool(CROSSHAIR_TOOL);
      return;
    }
    // Незаконченные инструменты не включаем: иначе кнопка горела бы
    // активной, а по графику ничего бы не происходило.
    if (!getTool(name)) {
      log(`Инструмент «${btn.title || name}» пока не реализован`);
      return;
    }
    selectTool(name);
  });
});

// Magnet toggle
document.getElementById("magnet-btn").addEventListener("click", function() {
  chartManager._magnetOn = !chartManager._magnetOn;
  this.classList.toggle("active", chartManager._magnetOn);
});

// Clear drawings for active chart's symbol.
// Идёт одной командой object.clear_symbol: иначе отмена восстановила бы
// не только линии, а всё состояние раскладки целиком.
document.getElementById("clear-drawings-btn").addEventListener("click", () => {
  const activeId = chartManager.activeChartId;
  if (!activeId) return;
  const chartObj = chartManager.charts.get(activeId);
  if (!chartObj) return;
  const symbol = chartObj.config.symbol;
  if (!store.layoutId) {
    log("Очистка рисунков недоступна: раскладка не подключена");
    return;
  }
  // Команда удаляет и линии, и уровни сканера с их алертами.
  commands.objectClearSymbol(store.layoutId, symbol).catch((err) => {
    log("Не удалось очистить рисунки:", err.message);
  });
});

document.getElementById("clear-all-btn").addEventListener("click", () => {
  if (!confirm("Удалить все рисунки и алерты во всех раскладках?")) return;
  if (!store.layoutId) {
    log("Очистка недоступна: раскладка не подключена");
    return;
  }
  // Очищаем раскладку одной командой: линии, уровни и алерты.
  commands.objectClearSymbol(store.layoutId, null).catch((err) => {
    log("Не удалось очистить:", err.message);
  });
  // Флажки сканера остаются в браузере: они не серверные объекты.
  saveFlags({});
  try { localStorage.setItem("trading-scan-flags", "{}"); } catch {}
  renderWatchlist();
  flushNow();
});

// Undo / Redo
// Журнал команд лежит на сервере, но принадлежит вкладке: Ctrl+Z отменяет
// то, что сделала эта вкладка. Как у источника, где отмена действует
// на вкладку, а не на раскладку.
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");

async function doUndo() {
  if (!store.layoutId || !store.canUndo) return;
  try {
    await commands.undo(store.layoutId);
  } catch (err) {
    log("Отмена не удалась:", err.message);
  }
}

async function doRedo() {
  if (!store.layoutId || !store.canRedo) return;
  try {
    await commands.redo(store.layoutId);
  } catch (err) {
    log("Повтор не удался:", err.message);
  }
}

function refreshHistoryButtons() {
  if (undoBtn) undoBtn.disabled = !store.canUndo;
  if (redoBtn) redoBtn.disabled = !store.canRedo;
}

undoBtn?.addEventListener("click", doUndo);
redoBtn?.addEventListener("click", doRedo);

document.addEventListener("keydown", (e) => {
  // В полях ввода сочетание должно печататься, а не отменять действие.
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;

  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    doUndo();
  } else if ((key === "z" && e.shiftKey) || key === "y") {
    e.preventDefault();
    doRedo();
  }
});

store.on("history", refreshHistoryButtons);
refreshHistoryButtons();

// Watchlist toggle
document.getElementById("watchlist-toggle").addEventListener("click", () => {
  document.querySelector(".sidebar-right").classList.toggle("hidden");
});

async function loadSources() {
  try {
    const data = await api.sources();
    if (data.sources && data.sources.length > 0) {
      sourceSelect.value = data.sources[0];
    }
  } catch (e) {
    log("Failed to load sources:", e);
  }
}

function autoLoad() {
  if (isLoading) return;
  loadHistory();
}

async function loadHistory(forceChartId = null, symbol = null, timeframe = null, source = null, chartType = null) {
  source = normalizeSource(source || sourceSelect.value);
  symbol = (symbol || symbolInput.value).trim().toUpperCase();
  chartType = chartType || "candlestick";

  if (!symbol) return;

  let chartId = forceChartId;
  if (!chartId && chartManager.charts.size > 0) {
    chartId = chartManager.getAllChartIds()[0];
  }

  if (!timeframe) {
    timeframe = selectedTimeframe;
    if (chartId) {
      const firstChart = chartManager.charts.get(chartId);
      if (firstChart && firstChart.config.timeframe) {
        timeframe = firstChart.config.timeframe;
      }
    }
  }

  if (!forceChartId) {
    isLoading = true;
    statusText.textContent = "Loading...";
  }
  setTickerStatus(symbol, "loading");

  if (chartId) {
    const prev = activeFetchControllers.get(chartId);
    if (prev) prev.abort();
  }
  const controller = new AbortController();
  if (chartId) activeFetchControllers.set(chartId, controller);

  try {
    // signal обязателен: без него старый запрос истории догоняет новый
    // и перерисовывает график уже по устаревшим данным.
    const data = await api.history(symbol, timeframe, 3000, controller.signal);

    if (data.error) throw new Error(data.error);

    const indicatorData = { ...data.indicators };
    if (chartId) {
      const chartObj = chartManager.charts.get(chartId);
      if (chartObj) {
        if (chartType && chartObj.chartType !== chartType) {
          chartManager.changeChartType(chartId, chartType);
        }
        chartObj.config.symbol = symbol;
        chartObj.config.source = source;
        chartObj.config.timeframe = timeframe;
        chartObj.config._lastCandles = data.candles;
        // тик всегда с нового символа: null → дефолтный допуск 0.01, но не чужой тик
        chartObj.config.tick = data.tick || null;
        const symbolBtn = chartObj.container.querySelector(".ch-symbol-btn");
        if (symbolBtn) symbolBtn.textContent = symbol;

        for (const indId of Object.keys(chartObj.indicators)) {
          if (chartManager.isPoc(indId)) continue; // серверный POC — данные идут через WS
          if (!(indId in indicatorData)) {
            const calcData = calcIndicator(indId, data.candles, chartManager.calcOpts(chartObj, indId));
            if (calcData) indicatorData[indId] = calcData;
          }
        }

        chartManager.updateData(chartId, data.candles, indicatorData);
        chartManager.restoreAlertColors();
        // Линии и уровни нового символа рисуются из серверных объектов,
        // а не из локального кэша: после загрузки данных подтягиваем их заново.
        chartManager.onDrawingsChanged?.();
      }
    } else {
      chartId = generateId();
      chartManager.createChart(chartId, { symbol, timeframe, source, chartType });
      const chartObj = chartManager.charts.get(chartId);
      chartObj.config._lastCandles = data.candles;
      if (data.tick) chartObj.config.tick = data.tick;
      chartManager.updateData(chartId, data.candles, indicatorData);
      chartManager.restoreAlertColors();
      chartManager.onDrawingsChanged?.();
    }

    statusText.textContent = `${symbol} ${timeframe} | ${data.candles.length} candles`;
    if (!forceChartId) {
      layoutManager.autoLayout(chartManager.charts.size);
    }

    wsClient.subscribe(symbol, timeframe, source);
    setTickerStatus(symbol, "live");
    syncTickerSubscriptions();

    // POC-индикаторы активны — пере-подписаться на серверный POC для нового символа
    syncPocSubscriptions();
  } catch (e) {
    if (e.name === "AbortError") return;
    log("Load history error:", e);
    if (!forceChartId) statusText.textContent = `Error: ${e.message}`;
    setTickerStatus(symbol, "error");
  } finally {
    if (!forceChartId) isLoading = false;
  }
}

// Layout Selector
const layoutTrigger = document.getElementById("layout-trigger");
const layoutDropdown = document.getElementById("layout-dropdown");
const layoutGrid = document.getElementById("layout-grid");
const layoutTriggerText = document.getElementById("layout-trigger-text");

const LAYOUT_ICONS = {
  1: [{ rows: 1, cols: 1 }],
  2: [{ rows: 1, cols: 2 }, { rows: 2, cols: 1 }],
  3: [{ rows: 1, cols: 3 }, { rows: 2, cols: 2 }, { rows: 2, cols: 2 }],
  4: [{ rows: 2, cols: 2 }],
  6: [{ rows: 2, cols: 3 }],
  9: [{ rows: 3, cols: 3 }],
  12: [{ rows: 4, cols: 3 }],
};

let currentLayoutCount = 1;
let currentLayoutOption = 0;
let layoutVersion = 0;

function renderLayoutGrid() {
  layoutGrid.innerHTML = "";

  const counts = [1, 2, 3, 4, 6, 9, 12];

  counts.forEach(count => {
    const icons = LAYOUT_ICONS[count];
    if (!icons) return;

    const row = document.createElement("div");
    row.className = "layout-row";

    const num = document.createElement("span");
    num.className = "layout-row-num";
    num.textContent = count;
    row.appendChild(num);

    const options = document.createElement("div");
    options.className = "layout-row-options";

    icons.forEach((icon, idx) => {
      const btn = document.createElement("button");
      btn.className = "layout-option";
      if (count === currentLayoutCount && idx === currentLayoutOption) {
        btn.classList.add("active");
      }
      btn.dataset.count = count;
      btn.dataset.option = idx;

      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.width = "100%";
      grid.style.height = "100%";
      grid.style.gap = "1px";

      const layouts = layoutManager.getLayouts();
      const layout = layouts[count]?.[idx];
      if (layout) {
        grid.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
        grid.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;

        let cellCount = 0;
        for (const [rowSpan, colSpan] of layout.cells) {
          if (cellCount >= count) break;
          const cell = document.createElement("div");
          cell.className = "cell";
          cell.style.gridRow = `span ${rowSpan}`;
          cell.style.gridColumn = `span ${colSpan}`;
          grid.appendChild(cell);
          cellCount++;
        }
      }

      btn.appendChild(grid);
      btn.addEventListener("click", () => {
        selectLayout(count, idx);
      });
      options.appendChild(btn);
    });

    row.appendChild(options);
    layoutGrid.appendChild(row);
  });
}

/**
 * Конфиги видимых панелей: из пула раскладки, недостающие — текущий символ.
 *
 * Пул — это все панели, которые раскладка знала: убранные панели помнят
 * свой символ и вернутся, когда их снова покажут.
 */
function panelConfigs(count) {
  const pool = (store.layout?.state?.charts) || [];
  const fallbackSymbol = symbolInput.value.trim().toUpperCase();
  const out = [];
  for (let i = 0; i < count; i++) {
    const cfg = pool[i] || {};
    out.push({
      symbol: cfg.symbol || fallbackSymbol,
      timeframe: cfg.timeframe || selectedTimeframe,
      chart_type: cfg.chart_type || cfg.chartType || "candlestick",
    });
  }
  return out;
}

/**
 * Перестроить панели: снять линии, создать графики заново, вернуть линии.
 *
 * Общая часть для выбора сетки пользователем и для отмены: обе смены
 * перестраивают панели, но по-разному объясняют серверу, что получилось.
 */
function rebuildPanels(count, grid, panels) {
  const myVersion = ++layoutVersion;

  const savedLinesPerSymbol = {};
  for (const [id, chartObj] of chartManager.charts) {
    const symbol = chartObj.config.symbol;
    if (symbol && chartObj._horizontalLines.length > 0) {
      if (!savedLinesPerSymbol[symbol]) savedLinesPerSymbol[symbol] = [];
      savedLinesPerSymbol[symbol].push(...chartObj._horizontalLines.map(l => ({
        price: l.options().price,
        color: l.options().color,
        lineWidth: l.options().lineWidth,
        lineStyle: l.options().lineStyle,
        ownerSymbol: (l._opts && l._opts.ownerSymbol) || symbol,
      })));
    }
  }
  const savedAlerts = [...chartManager.alerts];

  const ids = chartManager.getAllChartIds();
  while (ids.length > 0) {
    chartManager.removeChart(ids.pop());
  }
  syncTickerSubscriptions();
  syncPocSubscriptions();

  if (grid) {
    layoutManager.applyGrid(grid);
  } else {
    layoutManager.setLayoutByCount(count, currentLayoutOption);
  }

  const newCharts = [];
  for (let i = 0; i < count; i++) {
    const id = generateId();
    const cfg = panels[i] || {};
    chartManager.createChart(id, {
      symbol: cfg.symbol,
      timeframe: cfg.timeframe,
      source: sourceSelect.value,
      chartType: cfg.chart_type || "candlestick",
    });
    newCharts.push({ id, cfg });
  }
  layoutManager.applyLayout();

  // Активной становится первая видимая панель: после перестроения
  // идентификатор активной панели мог остаться от снятой, и всё, что
  // берёт активную панель (вочлист, «Очистить рисунки»), работало бы
  // вхолостую.
  if (newCharts.length > 0) chartManager.setActiveChart(newCharts[0].id);

  const symbolToChartIds = {};
  for (const { id, cfg } of newCharts) {
    if (!symbolToChartIds[cfg.symbol]) symbolToChartIds[cfg.symbol] = [];
    symbolToChartIds[cfg.symbol].push(id);
  }

  // Историю грузим с символом и таймфреймом своей панели: без них
  // loadHistory берёт символ из поля ввода и пишет его всем панелям
  // подряд — панели теряют свои символы и расходятся с пулом.
  const fetches = newCharts.map(({ id, cfg }) =>
    loadHistory(id, cfg.symbol, cfg.timeframe, sourceSelect.value, cfg.chart_type || "candlestick")
  );
  Promise.all(fetches).then(() => {
    if (myVersion !== layoutVersion) return;
    for (const [symbol, lines] of Object.entries(savedLinesPerSymbol)) {
      const chartIds = symbolToChartIds[symbol] || [];
      chartIds.forEach(chartId => {
        lines.forEach(line => {
          if (typeof line === "number") {
            chartManager.addHorizontalLine(chartId, line);
          } else {
            chartManager.addHorizontalLine(chartId, line.price, { color: line.color, lineWidth: line.lineWidth, lineStyle: line.lineStyle, ownerSymbol: line.ownerSymbol || symbol });
          }
        });
      });
    }
    chartManager.alerts = savedAlerts.map(a => {
      const chartIds = symbolToChartIds[a.symbol];
      const newId = chartIds && chartIds[0];
      return newId ? { ...a, chartId: newId } : a;
    });
    chartManager._saveAlerts();
    chartManager.restoreAlertColors();
  });
}

function selectLayout(count, optionIndex) {
  currentLayoutCount = count;
  currentLayoutOption = optionIndex;
  layoutTriggerText.textContent = count;

  document.querySelectorAll(".layout-option").forEach(btn => {
    btn.classList.toggle("active",
      parseInt(btn.dataset.count) === count && parseInt(btn.dataset.option) === optionIndex
    );
  });

  const grid = layoutManager.gridFor(count, optionIndex);
  const panels = panelConfigs(count);
  rebuildPanels(count, grid, panels);

  // Геометрия — часть состояния раскладки: без этого она не пережила бы
  // перезагрузку и разошлась бы у вкладок, открывших одну раскладку.
  if (store.layoutId && grid) {
    commands.setGrid(store.layoutId, { ...grid, charts: panels }).catch((err) => {
      log("Не удалось сохранить сетку:", err.message);
    });
  }

  layoutDropdown.classList.add("hidden");
}

layoutTrigger.addEventListener("click", (e) => {
  e.stopPropagation();
  layoutDropdown.classList.toggle("hidden");
  if (!layoutDropdown.classList.contains("hidden")) {
    renderLayoutGrid();
  }
});

const SYNC_KEYS = ["symbol", "timeframe", "crosshair", "time", "dateRange"];
document.querySelectorAll(".layout-sync-item input[type=checkbox]").forEach((cb, i) => {
  const key = SYNC_KEYS[i];
  if (key) cb.addEventListener("change", () => { chartManager.sync[key] = cb.checked; });
});

document.addEventListener("click", (e) => {
  if (!layoutTrigger.contains(e.target) && !layoutDropdown.contains(e.target)) {
    layoutDropdown.classList.add("hidden");
  }
  if (!e.target.closest(".ch-symbol-btn") && !e.target.closest(".ch-symbol-dropdown")) {
    document.querySelectorAll(".ch-symbol-dropdown").forEach(d => d.classList.add("hidden"));
  }
  if (!e.target.closest(".ch-ind-btn") && !e.target.closest(".ch-ind-dropdown")) {
    document.querySelectorAll(".ch-ind-dropdown").forEach(d => d.classList.add("hidden"));
  }
});

const STORAGE_KEY = "trading-dashboard-state";

function saveState() {
  const charts = [];
  for (const [id, chartObj] of chartManager.charts) {
    charts.push({
      symbol: chartObj.config.symbol || "",
      source: chartObj.config.source || "tinkoff",
      timeframe: chartObj.config.timeframe || "1h",
      chartType: chartObj.chartType || "candlestick",
      indicators: Object.keys(chartObj.indicators),
      horizontalLines: chartObj._horizontalLines.map(l => ({
        price: l.options().price,
        color: l.options().color,
        lineWidth: l.options().lineWidth,
        lineStyle: l.options().lineStyle,
        ownerSymbol: l._opts && l._opts.ownerSymbol,
      }))
    });
  }
  const state = {
    layoutCount: currentLayoutCount,
    layoutOption: currentLayoutOption,
    symbol: symbolInput.value,
    source: sourceSelect.value,
    timeframe: selectedTimeframe,
    // Галочки синхронизации не сохраняем: при новом запуске они выключены.
    charts
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    log("Failed to save state:", e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state;
  } catch (e) {
    log("Failed to load state:", e);
    return null;
  }
}

// Единственный источник live-данных — tinkoff; legacy moex больше не используется.
function normalizeSource() {
  return "tinkoff";
}

function restoreState(state) {
  if (!state || !state.charts || state.charts.length === 0) return false;

  currentLayoutCount = state.layoutCount || 1;
  currentLayoutOption = state.layoutOption || 0;
  selectedTimeframe = state.timeframe || "1h";

  symbolInput.value = state.symbol || "";
  sourceSelect.value = normalizeSource(state.source);

  // Галочки синхронизации из состояния не восстанавливаем: при новом
  // запуске они всегда выключены. Иначе сохранённое состояние возвращало
  // бы включённую синхронизацию, а с ней и прежнее поведение панелей.
  document.querySelectorAll("[data-btf]").forEach(b => {
    b.classList.toggle("active", b.dataset.btf === selectedTimeframe);
  });

  // Геометрия приходит из состояния раскладки: сервер — источник истины.
  if (state.layout) {
    layoutManager.applyGrid(state.layout);
  } else {
    layoutManager.setLayoutByCount(currentLayoutCount, currentLayoutOption);
  }
  layoutTriggerText.textContent = currentLayoutCount;

  const chartIds = [];
  // Видимы только первые панели: в пуле раскладки лежат и убранные,
  // их символы помнятся, но панелей на экране столько, сколько в сетке.
  const visible = state.charts.slice(0, currentLayoutCount);
  for (const chartCfg of visible) {
    const id = generateId();
    chartManager.createChart(id, {
      symbol: chartCfg.symbol,
      source: normalizeSource(chartCfg.source),
      timeframe: chartCfg.timeframe,
      chartType: chartCfg.chartType,
      _activeIndicators: chartCfg.indicators || []
    });

    const chartObj = chartManager.charts.get(id);
    if (chartObj && chartCfg.indicators && chartCfg.indicators.length > 0) {
      chartCfg.indicators.forEach(indId => {
        const customInd = loadCustomIndicators().find(c => c.id === indId);
        const color = (customInd && customInd.extra && customInd.extra.color) || chartManager.indicatorColors[indId] || "#787B86";
        const lineWidth = (customInd && customInd.extra && customInd.extra.lineWidth) || 2;
        const isPocType = chartManager.isPoc(indId) || (customInd && chartManager.isPoc(customInd.type));
        const series = chartObj.chart.addSeries(LightweightCharts.LineSeries, {
          color, lineWidth,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: false,
          ...(isPocType ? {
            lineType: LightweightCharts.LineType.WithSteps,
            pointMarkersVisible: false,
            lastValueVisible: false,
          } : {}),
        });
        chartObj.indicators[indId] = series;
        if (chartManager.isPoc(indId)) chartManager._joinPoc(id, indId);
      });
    }

    chartIds.push({ id, chartCfg });
  }
  layoutManager.applyLayout();

  const fetches = chartIds.map(({ id, chartCfg }) =>
    loadHistory(id, chartCfg.symbol, chartCfg.timeframe, chartCfg.source, chartCfg.chartType)
  );
  Promise.all(fetches).then(() => {
    // Линии сюда больше не восстанавливаются: они живут на сервере как
    // объекты и приезжают через store (см. syncDrawingsFromStore).
    // Старое состояние из localStorage используется только один раз —
    // при переносе, см. migrateLocalDrawings.
    chartManager.restoreAlertColors();
  });

  return true;
}

window.addEventListener("beforeunload", saveState);

document.querySelectorAll("[data-btf]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-btf]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const range = btn.dataset.btf;
    const now = Math.floor(Date.now() / 1000);
    let from;
    switch (range) {
      case "1D": from = now - 86400; break;
      case "5D": from = now - 86400 * 5; break;
      case "1M": from = now - 86400 * 30; break;
      case "3M": from = now - 86400 * 90; break;
      case "6M": from = now - 86400 * 180; break;
      case "YTD": {
        const d = new Date();
        from = Math.floor(new Date(d.getFullYear(), 0, 1).getTime() / 1000);
        break;
      }
      case "1Y": from = now - 86400 * 365; break;
      case "5Y": from = now - 86400 * 365 * 5; break;
      case "ALL": from = 0; break;
      default: from = now - 86400 * 30;
    }
    for (const [, chartObj] of chartManager.charts) {
      if (chartObj.chart) {
        chartObj.chart.timeScale().setVisibleRange({ from, to: now });
      }
    }
  });
});

// ------------------------------------------------ серверная модель состояния

function layoutIdFromUrl() {
  const m = location.pathname.match(/\/chart\/([A-Za-z0-9_-]{4,})\/?$/);
  return m ? m[1] : null;
}

function writeLayoutIdToUrl(layoutId) {
  if (!layoutId) return;
  const next = `/chart/${layoutId}/`;
  if (location.pathname !== next) history.replaceState({ layoutId }, "", next);
}

/**
 * Подключение к шине команд сервера.
 *
 * Состояние теперь живёт на сервере: клиент выбирает раскладку, получает её
 * целиком и дальше только отправляет команды. Идентификатор раскладки попадает
 * в адрес, поэтому ссылка открывает то же самое состояние на другой машине.
 */
async function bindServerState() {
// Подключение к сокету выполняется один раз в bindServerState(),
// после того как адрес сервера уже разобран. Здесь только напоминание.
  attachSocket(wsClient.socket);
  bindServerEvents();

  const ready = await waitForSocket();
  if (!ready) {
    log("Соединение с сервером не установлено — работаем на локальном состоянии");
    return;
  }

  // рукопожатие
  wsClient.socket.emit("hello", { protocol_version: 2 });

  let layoutId = layoutIdFromUrl();
  let layouts = [];
  try {
    layouts = (await api.listLayouts()).layouts || [];
  } catch (err) {
    log("Список раскладок недоступен:", err.message);
    return;
  }

  if (layoutId && !layouts.some((l) => l.id === layoutId)) {
    log(`Раскладка ${layoutId} не найдена на сервере, создаём новую`);
    layoutId = null;
  }
  if (!layoutId) {
    if (layouts.length > 0) {
      layoutId = layouts[0].id;
    } else {
      try {
        const saved = loadState();
        const created = await commands.layoutCreate({
          name: (saved && saved.symbol) ? `${saved.symbol}` : "Основная",
          state: { charts: savedToCharts(saved) },
        });
        layoutId = created.data.layout.id;
        log("Создана раскладка на сервере:", layoutId);
      } catch (err) {
        log("Не удалось создать раскладку:", err.message);
        return;
      }
    }
  }

  writeLayoutIdToUrl(layoutId);
  bindDrawings();
  try {
    await attachLayout(layoutId);
    log(`Раскладка подключена: ${layoutId}, объектов ${store.objects.size}`);
    bindServerUi();
    syncAllDrawings();
    syncAlertsFromStore();
    await migrateLocalDrawings();
    await migrateLegacyAutoLevels();
    await migrateLegacyAlerts();
  } catch (err) {
    log("Не удалось подключить раскладку:", err.message);
  }
}

/* --- Рисовалки: серверные объекты вместо локальных массивов --- */

/**
 * Инструменты шлют рисовалки через ChartManager, а тот — сюда.
 * Команда уходит на сервер, оттуда событие приходит обратно и уже
 * из него линии рисуются на графике.
 */
function sendDrawingCommand(payload) {
  if (!store.layoutId) {
    log("Рисование невозможно: раскладка не подключена");
    return null;
  }

  // Свой результат применяется в commands.js — там, где команда отправляется,
  // чтобы любой вызывающий получал одинаковое поведение.
  if (payload.kind === "object.delete") {
    return commands.objectDelete(payload.id);
  }
  if (payload.kind === "object.update") {
    return commands.objectUpdate(payload.id, {
      style: payload.style,
      data: payload.data,
      symbol: payload.symbol,
      timeframe: payload.timeframe
    });
  }
  if (payload.kind === "object.create_many") {
    return commands.objectCreateMany(store.layoutId, payload.objects);
  }
  if (payload.kind === "object.set_auto_levels") {
    return commands.setAutoLevels(
      store.layoutId, payload.symbol, payload.levels || {}, payload.timeframe
    );
  }
  return commands.objectCreate({
    layout_id: store.layoutId,
    kind: payload.kind,
    chart_index: payload.chart_index ?? 0,
    symbol: payload.symbol ?? null,
    timeframe: payload.timeframe ?? null,
    data: payload.data || {},
    style: payload.style || {}
  });
}

let drawingsBound = false;

/**
 * Перерисовать всё, что пришло с сервера: линии пользователя и уровни
 * сканера. Вызывается из трёх мест, поэтому собрана в одну функцию —
 * раньше уровни забывали перерисовать и они не появлялись до ручного
 * обновления.
 */
function syncAllDrawings() {
  syncDrawingsFromStore();
  syncAutoLevelsFromStore();
}

function bindDrawings() {
  chartManager._sendDrawingCommand = sendDrawingCommand;
  chartManager.onDrawingsChanged = syncAllDrawings;
  chartManager._createAlert = createServerAlert;
  chartManager._deleteAlert = deleteServerAlert;
  chartManager._setAutoLevels = setAutoLevels;
  if (drawingsBound) return;
  drawingsBound = true;
  // Изменения объектов приходят из ответа на команду: вкладка применяет
  // их у себя, а другие вкладки о них не узнают.
  store.on("objects", syncAllDrawings);
  store.on("alerts", syncAlertsFromStore);
}

/**
 * Уровни ATR-сканера.
 *
 * Раньше они жили в localStorage и рисовались вручную, из-за чего не
 * попадали ни в одну вкладку кроме своей, не отменялись и не удалялись
 * командой «Очистить». Теперь это серверные объекты вида auto_level,
 * а алерты на них ставит сервер вместе с уровнями.
 */
const AUTO_LEVEL_KIND = "auto_level";

function autoLevelSymbols() {
  return Array.from(store.objects.values()).filter((o) => o.kind === AUTO_LEVEL_KIND);
}

function setAutoLevels(symbol, dayHigh, dayLow, eveHigh, eveLow) {
  if (!store.layoutId) {
    log("Уровни недоступны: раскладка не подключена");
    return Promise.resolve(null);
  }
  const tf = selectedTimeframe || "1m";
  return commands.setAutoLevels(
    store.layoutId, symbol,
    { day_high: dayHigh, day_low: dayLow, eve_high: eveHigh, eve_low: eveLow },
    tf
  ).then((result) => {
    log(`Уровни обновлены: ${symbol}`);
    return result;
  }).catch((err) => {
    log("Не удалось обновить уровни:", err.message);
    return null;
  });
}

function syncAutoLevelsFromStore() {
  const levels = autoLevelSymbols();

  for (const chartId of chartManager.getAllChartIds()) {
    const chartObj = chartManager.charts.get(chartId);
    if (!chartObj || !chartObj.mainSeries) continue;
    const symbol = chartObj.config.symbol;
    const mine = levels.filter((o) => o.symbol === symbol);

    // Убираем линии уровней, которых больше нет: объект исчез, поле
    // уровня стёрли или цена изменилась.
    for (const line of chartObj._horizontalLines.slice()) {
      if (!line._autoLevel) continue;
      const obj = store.objects.get(line._autoLevel.objectId);
      const price = obj?.data?.[line._autoLevel.field];
      if (obj && price != null && Math.abs(price - line._autoLevel.price) < 1e-6) continue;
      try { chartObj.mainSeries.removePriceLine(line); } catch (e) {}
      chartObj._horizontalLines = chartObj._horizontalLines.filter((l) => l !== line);
    }

    for (const obj of mine) {
      for (const field of LEVEL_FIELDS) {
        const price = obj.data?.[field.key];
        if (price == null) continue;
        const exists = chartObj._horizontalLines.some(
          (l) => l._autoLevel && l._autoLevel.field === field.key &&
                 Math.abs(l._autoLevel.price - price) < 1e-6
        );
        if (exists) continue;
        // Вид линии уровня — по состоянию алерта на нём: вооружённый алерт
        // держит линию сплошной, сработавший переводит в штрихи.
        const style = alertLineStyle(symbol, price);
        const line = chartObj.mainSeries.createPriceLine({
          price,
          color: field.color,
          lineWidth: field.width,
          lineStyle: style,
          axisLabelVisible: false,
          title: ""
        });
        line._opts = { color: field.color, lineWidth: field.width, lineStyle: style, ownerSymbol: symbol };
        line._autoLevel = { objectId: obj.id, price, field: field.key };
        chartObj._horizontalLines.push(line);
      }
    }
  }
}

/** Поля уровня: ключ в объекте, цвет и толщина линии. */
const LEVEL_FIELDS = [
  { key: "day_low", color: "#e53935", width: 2 },
  { key: "day_high", color: "#e53935", width: 2 },
  { key: "eve_low", color: "#FFEB3B", width: 1 },
  { key: "eve_high", color: "#FFEB3B", width: 1 }
];

/**
 * Одноразовый перенос уровней сканера из localStorage на сервер.
 * После переноса старый кэш больше не нужен: уровни живут в objects.
 */
async function migrateLegacyAutoLevels() {
  const FLAG = "dash-auto-levels-migrated";
  try {
    if (localStorage.getItem(FLAG)) return;
    const raw = localStorage.getItem("trading-auto-levels");
    const legacy = raw ? JSON.parse(raw) : {};
    const entries = Object.entries(legacy || {});
    if (entries.length === 0) {
      localStorage.setItem(FLAG, "1");
      return;
    }
    let n = 0;
    for (const [symbol, lv] of entries) {
      if (!lv) continue;
      await setAutoLevels(symbol, lv.dayHigh ?? null, lv.dayLow ?? null,
                          lv.eveHigh ?? null, lv.eveLow ?? null);
      n++;
    }
    localStorage.setItem(FLAG, "1");
    log(`Перенесено наборов уровней на сервер: ${n}`);
  } catch (err) {
    log("Не удалось перенести уровни:", err.message);
  }
}

/**
 * Объект нарисованной линии по символу и цене.
 *
 * Алерт держится за объект, а не за цену: стёрли линию — ушёл и алерт,
 * а отмена стирания вернула линию вместе с алертом.
 */
function findLineObject(symbol, price) {
  if (!symbol || price == null) return null;
  const tol = chartManager._symbolTol(symbol);
  for (const obj of store.objects.values()) {
    if (obj.kind !== "hline" || obj.symbol !== symbol) continue;
    const p = obj.data?.price;
    if (p == null || Math.abs(p - price) > tol) continue;
    return obj;
  }
  return null;
}

function createServerAlert(payload) {
  if (!store.layoutId) {
    log("Алерт недоступен: раскладка не подключена");
    return null;
  }
  const object = findLineObject(payload.symbol, payload.price);
  return commands.alertCreate({
    layout_id: store.layoutId,
    symbol: payload.symbol,
    price: payload.price,
    condition: payload.condition || "cross",
    timeframe: payload.timeframe || "1m",
    channels: payload.channels || ["sound", "browser"],
    repeat_mode: payload.repeat_mode || "once",
    expires_at: payload.expires_at ?? null,
    object_id: object ? object.id : null
  }).then((result) => result?.data?.alert || null);
}

function deleteServerAlert(alertId) {
  if (!store.layoutId) return null;
  return commands.alertDelete(alertId);
}

/**
 * Стиль линии по состоянию алерта на этом уровне:
 * есть алерт — сплошная, сработал — штрихи, алерта нет — обычный вид.
 */
function alertLineStyle(symbol, price) {
  const tol = chartManager._symbolTol(symbol);
  const list = Array.from(store.alerts.values());
  const alert = list.find(
    (a) => a.symbol === symbol && a.price != null && Math.abs(a.price - price) <= tol
  );
  return alert ? (alert.status === "fired" ? 2 : 0) : 2;
}

function syncAlertsFromStore() {
  const list = Array.from(store.alerts.values());
  chartManager.alerts = list;

  for (const chartId of chartManager.getAllChartIds()) {
    const chartObj = chartManager.charts.get(chartId);
    if (!chartObj || !chartObj.mainSeries) continue;
    const symbol = chartObj.config.symbol;

    for (const line of chartObj._horizontalLines.slice()) {
      // И нарисованные линии, и автоуровни: у обоих есть алерт.
      if (!line._objectId && !line._autoLevel) continue;
      const price = line.options().price;
      if (price == null) continue;
      const wantStyle = alertLineStyle(symbol, price);
      if (line.options().lineStyle === wantStyle) continue;
      // Вид меняем на месте: пересоздание линии рвало её метки и оставляло
      // на графике вторую линию того же уровня.
      try {
        line.applyOptions({ lineStyle: wantStyle });
      } catch (e) {
        log("Не удалось изменить вид линии", e);
        continue;
      }
      if (line._opts) line._opts = { ...line._opts, lineStyle: wantStyle };
    }
  }
}

/** Сработавший алерт: уведомление и звук. */
function onAlertFired(data) {
  const alert = data?.alert;
  if (!alert) return;
  store.putAlert(alert);
  const channels = Array.isArray(alert.channels) ? alert.channels : [];
  const title = `${alert.symbol} @ ${alert.price}`;
  const close = alert.candle?.close;

  if (channels.includes("browser") && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body: `Цена: ${close ?? "—"}` });
      n.onclick = () => {
        n.close();
        const url = `${location.origin}${location.pathname}?symbol=${alert.symbol}`;
        window.open(url, "_blank");
      };
    } catch (e) {}
  }
  if (channels.includes("sound")) {
    try {
      const audio = new Audio("sounds/alert.wav");
      audio.volume = 0.5;
      const played = audio.play();
      if (played && played.catch) {
        played.catch((err) => log("Звук алерта не проигрался:", err && err.name));
      }
    } catch (e) {
      log("Звук алерта недоступен:", e);
    }
  }
  log(`Алерт сработал: ${title}`);
}

/**
 * Одноразовый перенос алертов из localStorage на сервер.
 */
async function migrateLegacyAlerts() {
  const FLAG = "dash-alerts-migrated";
  try {
    if (localStorage.getItem(FLAG)) return;
    const legacy = chartManager.loadLegacyAlerts() || [];
    if (legacy.length === 0) {
      localStorage.setItem(FLAG, "1");
      return;
    }
    let n = 0;
    for (const a of legacy) {
      if (a.price == null || !a.symbol) continue;
      if (a.auto) continue; // автоуровни — не алерты пользователя
      const created = await createServerAlert({
        symbol: a.symbol,
        price: a.price,
        condition: a.condition || "cross",
        timeframe: "1m",
        expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600
      });
      if (created) n++;
    }
    localStorage.setItem(FLAG, "1");
    log(`Перенесено алертов на сервер: ${n}`);
  } catch (err) {
    log("Не удалось перенести алерты:", err.message);
  }
}

/** Линии на графиках рисуются строго из store.objects. */
function syncDrawingsFromStore() {
  const hlines = Array.from(store.objects.values()).filter((o) => o.kind === "hline");

  for (const chartId of chartManager.getAllChartIds()) {
    const chartObj = chartManager.charts.get(chartId);
    if (!chartObj || !chartObj.mainSeries) continue;

    const mine = hlines.filter((o) => o.symbol === chartObj.config.symbol);
    // Управляем только линиями с идентификатором объекта. В _horizontalLines
    // попадают ещё автоуровни и линии алертов — их не трогаем.
    const managed = chartObj._horizontalLines.filter((l) => l._objectId);

    for (const line of managed) {
      if (mine.some((o) => o.id === line._objectId)) continue;
      try {
        chartObj.mainSeries.removePriceLine(line);
      } catch (e) {}
      chartObj._horizontalLines = chartObj._horizontalLines.filter((l) => l !== line);
    }

    for (const obj of mine) {
      const style = obj.style || {};
      const existing = managed.find((l) => l._objectId === obj.id);
      if (!existing) {
        chartManager.addObjectLine(chartObj, obj);
        continue;
      }
      const opts = existing.options();
      const same =
        opts.price === obj.data?.price &&
        opts.color === style.color &&
        opts.lineWidth === (style.lineWidth ?? 1) &&
        opts.lineStyle === (style.lineStyle ?? 2);
      if (same) continue;
      try {
        chartObj.mainSeries.removePriceLine(existing);
      } catch (e) {}
      chartObj._horizontalLines = chartObj._horizontalLines.filter((l) => l !== existing);
      chartManager.addObjectLine(chartObj, obj);
    }
  }
}

/**
 * Одноразовый перенос линий из старого localStorage в серверные объекты.
 * Ключ ставится после успеха: повторный запуск не создаёт дубли.
 */
async function migrateLocalDrawings() {
  const FLAG = "dash-drawings-migrated";
  try {
    if (localStorage.getItem(FLAG)) return;
    const saved = loadState();
    const lines = [];
    for (const c of saved?.charts || []) {
      for (const l of c.horizontalLines || []) {
        if (l?.price == null) continue;
        lines.push({
          kind: "hline",
          symbol: c.symbol,
          timeframe: c.timeframe,
          chart_index: 0,
          data: { price: l.price },
          style: { color: l.color, lineWidth: l.lineWidth, lineStyle: l.lineStyle }
        });
      }
    }
    if (lines.length === 0) {
      localStorage.setItem(FLAG, "1");
      return;
    }
    await sendDrawingCommand({ kind: "object.create_many", objects: lines });
    localStorage.setItem(FLAG, "1");
    log(`Перенесено линий с сервера: ${lines.length}`);
  } catch (err) {
    log("Не удалось перенести линии:", err.message);
  }
}

/** Старое состояние из localStorage в форму, которую понимает сервер. */
function savedToCharts(saved) {
  if (!saved || !Array.isArray(saved.charts) || saved.charts.length === 0) return [];
  return saved.charts.map((c) => ({
    symbol: c.symbol || null,
    timeframe: c.timeframe || null,
    chart_type: c.chartType || "candlestick",
    indicators: Array.isArray(c.indicators) ? c.indicators : [],
  }));
}

store.on("sync", () => {
  log(`Состояние с сервера: объектов ${store.objects.size}, алертов ${store.alerts.size}`);
});

/**
 * Состояние раскладки с сервера в формат, который понимает restoreState().
 * Сервер хранит поле chart_type, локальный код использовал chartType.
 */
function serverLayoutToLocalState(state) {
  const charts = (state.charts || []).map((c) => ({
    symbol: c.symbol || "",
    source: normalizeSource(c.source),
    timeframe: c.timeframe || "1h",
    chartType: c.chart_type || c.chartType || "candlestick",
    indicators: c.indicators || []
  }));
  const first = charts[0] || {};
  // Геометрия панелей лежит в состоянии раскладки: сервер — источник истины.
  const grid = state.layout || null;
  return {
    charts,
    symbol: first.symbol || "",
    source: normalizeSource(first.source || sourceSelect.value),
    timeframe: first.timeframe || selectedTimeframe,
    layout: grid,
    layoutCount: grid?.count || 1,
    layoutOption: grid ? layoutManager.optionForGrid(grid) : 0,
  };
}

async function boot() {
  // Отметка текущего шага: видна из консоли как __dash.bootStage.
  let stage = "start";
  window.__dashBootStage = () => stage;

  try {
    await loadFromServer();
    stage = "settings loaded";
    await loadSources();
    stage = "sources loaded";
  } catch (err) {
    log("Начальное состояние с сервера не получено:", err);
  }
  renderWatchlist();
  stage = "watchlist rendered";
  initScanner({ chartManager, renderWatchlist, syncTickerSubscriptions });
  stage = "scanner ready";

  try {
    await bindServerState();
  } catch (err) {
    log("Подключение к серверу состояния не удалось:", err);
  }
  stage = "server bound";

  const url = new URLSearchParams(location.search);
  const urlSymbol = (url.get("symbol") || "").trim().toUpperCase();
  const urlTf = (url.get("timeframe") || "5m").toLowerCase();

  try {
    if (urlSymbol) {
      selectedTimeframe = urlTf;
      stage = "loading by url symbol";
      // Адрес задаёт символ, но не панели: геометрия — из состояния
      // раскладки, иначе после перезагрузки панели рассыпались бы в одну.
      const fromServer = serverLayoutToLocalState(store.layout?.state || {});
      if (restoreState(fromServer)) {
        symbolInput.value = urlSymbol;
        const ids = chartManager.getAllChartIds();
        if (ids.length) {
          chartManager.changeSymbol(urlSymbol, sourceSelect.value, ids[0]);
        }
        syncAllDrawings();
        stage = "done (url symbol)";
        return;
      }
      symbolInput.value = urlSymbol;
      autoLoad();
      stage = "done (url symbol)";
      return;
    }
    stage = "reading local state";
    // Сервер — источник истины: сперва строим графики из раскладки,
    // локальный кэш используем только если сервер ничего не вернул.
    const serverCharts = store.charts();
    if (serverCharts.length > 0) {
      const fromServer = serverLayoutToLocalState(store.layout.state);
      if (restoreState(fromServer)) {
        log(`State restored from server: ${serverCharts.length} chart(s)`);
        // Ранний return ниже обходит общий шаг отрисовки, поэтому
        // линии и уровни подтягиваем здесь же.
        syncAllDrawings();
        stage = "done (server layout)";
        return;
      }
    }
    const savedState = loadState();
    stage = "local state read: " + (savedState ? (savedState.charts || []).length + " charts" : "нет");
if (savedState && restoreState(savedState)) {
        log("State restored from server/localStorage");
      } else {
        stage = "autoLoad: symbol=" + JSON.stringify(symbolInput.value);
        autoLoad();
      }
      // Графики создаются только сейчас — до этого линий на них нет,
      // поэтому рисовалки подтягиваем последним шагом.
      syncAllDrawings();
      stage = "done";
  } catch (err) {
    log("Не удалось восстановить состояние, грузим по умолчанию:", err);
    stage = "error: " + err.message;
    autoLoad();
  }
}

boot();

log("App initialized");

// Диагностический доступ из консоли браузера.
// Нужен, чтобы смотреть состояние сервера и шину команд без отладчика:
//   __dash.store.snapshot()
//   __dash.commands.setSymbol(__dash.store.layoutId, 0, "GAZP")
window.__dash = { store, commands, wsClient, chartManager, api };

async function updateWatchlistPrices() {
  const items = document.querySelectorAll(".watchlist-item[data-symbol]");
  const alertSyms = [...new Set(chartManager.alerts.map(a => String(a.symbol).toUpperCase()))];
  const symbols = [...new Set([...Array.from(items).map(el => el.dataset.symbol), ...alertSyms])];
  if (symbols.length === 0) return;
  try {
    const data = await api.prices(symbols);
    if (data.error) return;
    items.forEach(el => {
      const sym = el.dataset.symbol;
      const info = data.prices[sym];
      const priceEl = el.querySelector(".wl-price");
      const changeEl = el.querySelector(".wl-change");
      if (!info) {
        if (priceEl) priceEl.textContent = "—";
        if (changeEl) { changeEl.textContent = "—"; changeEl.className = "wl-change"; }
        priceChanges[sym] = null;
        return;
      }
      priceChanges[sym] = info.changePct;
      const priceStr = info.price >= 1000
        ? info.price.toLocaleString("ru-RU", { maximumFractionDigits: 0 })
        : info.price.toFixed(2);
      if (priceEl) priceEl.textContent = priceStr;
      if (changeEl) {
        if (info.changePct != null) {
          const pct = info.changePct.toFixed(2);
          changeEl.textContent = (info.changePct >= 0 ? "+" : "") + pct + "%";
          changeEl.className = "wl-change " + (info.changePct >= 0 ? "positive" : "negative");
        } else {
          changeEl.textContent = "—";
          changeEl.className = "wl-change";
        }
      }
    });
  } catch (e) {
    log("Failed to update watchlist prices:", e);
  }
}

updateWatchlistPrices();
let _pricesTimer = setInterval(updateWatchlistPrices, 5000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // ponytail: фоновые вкладки троттлят setInterval (~1 мин) — алерты приходят с задержкой, но приходят
    if (chartManager.alerts.length) return;
    if (_pricesTimer) {
      clearInterval(_pricesTimer);
      _pricesTimer = null;
    }
  } else {
    if (!_pricesTimer) _pricesTimer = setInterval(updateWatchlistPrices, 5000);
    updateWatchlistPrices();
  }
});

// === ATR Scanner (перемещён в scanner.js) ===
