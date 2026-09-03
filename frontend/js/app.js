import { ChartManager } from "./chart-manager.js";
import { WSClient } from "./ws-client.js";
import { LayoutManager } from "./layout-manager.js";
import { generateId, log } from "./utils.js";
import { calcIndicator, mergeIndicators, loadCustomIndicators } from "./indicators.js";
import { loadTickers, saveTickers, addTicker, removeTicker, toggleFlag, getTickerFlag, loadFlags, saveFlags, refreshAllSymbolDropdowns } from "./tickers.js";
import { loadFromServer, flushNow } from "./storage.js";

let selectedTimeframe = "1h";
let isLoading = false;
const activeFetchControllers = new Map();

mergeIndicators();
const chartManager = new ChartManager("charts-grid", loadHistory);
const wsClient = new WSClient();
const layoutManager = new LayoutManager(document.getElementById("charts-grid"));

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
  for (const [id, chartObj] of chartManager.charts) {
    if (chartObj.config.symbol === symbol && chartObj.config.timeframe === timeframe) {
      chartManager.updateCandle(id, candle);
    }
  }
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
    item.classList.toggle("wl-live", status === "live");
    item.title = TICKER_STATUS_LABEL[status] || status;
  }
}

function syncTickerSubscriptions() {
  const rooms = new Set();
  for (const [, chartObj] of chartManager.charts) {
    if (!chartObj.config.symbol || !chartObj.config.timeframe) continue;
    rooms.add(`${chartObj.config.symbol}_${chartObj.config.timeframe}`);
  }
  for (const [room, sub] of wsClient.subscriptions) {
    if (!rooms.has(room)) {
      wsClient.unsubscribe(sub.symbol, sub.timeframe, sub.source);
      setTickerStatus(sub.symbol, "idle");
    }
  }
}

wsClient.connect();

// Watchlist
let currentFilter = "all";

let activeFlagColor = null;

function createWatchlistItemEl(ticker, source) {
  const div = document.createElement("div");
  div.className = "watchlist-item";
  div.dataset.symbol = ticker;
  div.dataset.source = source;
  const flag = getTickerFlag(ticker);
  div.dataset.flag = flag || "";
  const flagStyle = flag ? ` style="background:${flag === "red" ? "#ef5350" : flag === "green" ? "#26a69a" : "#ffb300"}"` : "";
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
      flagEl.style.background = activeFlagColor === "red" ? "#ef5350" : activeFlagColor === "green" ? "#26a69a" : "#ffb300";
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
    let activeId = chartManager.activeChartId;
    if (!activeId && chartManager.charts.size > 0) {
      activeId = chartManager.getAllChartIds()[0];
      chartManager.setActiveChart(activeId);
    }
    chartManager.changeSymbol(symbol, source, activeId);
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
    });
    item.appendChild(del);
  }
}

renderWatchlist();

// "+" button in watchlist
const addTickerBtn = document.querySelector(".watchlist-header .icon-btn-sm");
if (addTickerBtn) {
  addTickerBtn.addEventListener("click", () => {
    const input = prompt("Введите тикер (например TATN, ROSN, BANE):");
    if (!input) return;
    const ticker = input.toUpperCase().trim();
    if (!ticker) return;
    if (addTicker(ticker, ticker)) {
      renderWatchlist();
    } else {
      alert(`Тикер ${ticker} уже есть в вочлисте`);
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
document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    const sameTool = btn.classList.contains("active");
    document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
    if (sameTool) {
      document.querySelector('.tool-btn[data-tool="crosshair"]')?.classList.add("active");
      chartManager._activeTool = "crosshair";
    } else {
      btn.classList.add("active");
      chartManager._activeTool = btn.dataset.tool;
    }
  });
});

// Magnet toggle
document.getElementById("magnet-btn").addEventListener("click", function() {
  chartManager._magnetOn = !chartManager._magnetOn;
  this.classList.toggle("active", chartManager._magnetOn);
});

// Clear drawings for active chart's symbol
document.getElementById("clear-drawings-btn").addEventListener("click", () => {
  const activeId = chartManager.activeChartId;
  if (!activeId) return;
  const chartObj = chartManager.charts.get(activeId);
  if (!chartObj) return;
  const symbol = chartObj.config.symbol;
  chartManager.clearAllForSymbol(symbol);
});

document.getElementById("clear-all-btn").addEventListener("click", () => {
  if (!confirm("Удалить все уровни, алерты и флажки на всех тикерах?")) return;
  chartManager.clearAllScannerData();
  saveFlags({});
  try { localStorage.setItem("trading-scan-flags", "{}"); } catch {}
  saveState();
  renderWatchlist();
  flushNow();
});

// Watchlist toggle
document.getElementById("watchlist-toggle").addEventListener("click", () => {
  document.querySelector(".sidebar-right").classList.toggle("hidden");
});

async function loadSources() {
  try {
    const res = await fetch("/api/sources");
    const data = await res.json();
    if (data.sources && data.sources.length > 0) {
      const preferred = ["tinkoff", "moex"];
      sourceSelect.value = preferred.find(s => data.sources.includes(s)) || data.sources[0];
    }
  } catch (e) {
    log("Failed to load sources:", e);
  }
}

function autoLoad(indicatorName = null) {
  if (isLoading) return;
  loadHistory(null, indicatorName);
}

async function loadHistory(forceChartId = null, indicatorName = null, symbol = null, timeframe = null, source = null, chartType = null) {
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

const indicators = {};
  if (indicatorName) {
    indicators[indicatorName] = {};
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
    const res = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, symbol, timeframe, limit: 3000, indicators }),
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
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
        const symbolBtn = chartObj.container.querySelector(".ch-symbol-btn");
        if (symbolBtn) symbolBtn.textContent = symbol;

        for (const indId of Object.keys(chartObj.indicators)) {
          if (!(indId in indicatorData)) {
            const calcData = calcIndicator(indId, data.candles);
            if (calcData) indicatorData[indId] = calcData;
          }
        }

        chartManager.updateData(chartId, data.candles, indicatorData);
        if (data.candles.length > 0) {
          chartManager.checkAlerts(data.candles[data.candles.length - 1], { historical: true });
        }
        chartManager.applyAutoLevelsForSymbol(symbol);
        chartManager.restoreAlertColors();
      }
    } else {
      chartId = generateId();
      chartManager.createChart(chartId, { symbol, timeframe, source, chartType });
      const chartObj = chartManager.charts.get(chartId);
      chartObj.config._lastCandles = data.candles;
      chartManager.updateData(chartId, data.candles, indicatorData);
      chartManager.applyAutoLevelsForSymbol(symbol);
      chartManager.restoreAlertColors();
    }

    statusText.textContent = `${symbol} ${timeframe} | ${data.candles.length} candles`;
    if (!forceChartId) {
      layoutManager.autoLayout(chartManager.charts.size);
    }

    wsClient.subscribe(symbol, timeframe, source);
    setTickerStatus(symbol, "live");
    syncTickerSubscriptions();
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

function selectLayout(count, optionIndex) {
  const myVersion = ++layoutVersion;
  currentLayoutCount = count;
  currentLayoutOption = optionIndex;
  layoutTriggerText.textContent = count;

  document.querySelectorAll(".layout-option").forEach(btn => {
    btn.classList.toggle("active",
      parseInt(btn.dataset.count) === count && parseInt(btn.dataset.option) === optionIndex
    );
  });

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
      })));
    }
  }
  const savedAlerts = [...chartManager.alerts];

  const ids = chartManager.getAllChartIds();
  while (ids.length > 0) {
    chartManager.removeChart(ids.pop());
  }
  syncTickerSubscriptions();

  layoutManager.setLayoutByCount(count, optionIndex);

  const newCharts = [];
  for (let i = 0; i < count; i++) {
    const id = generateId();
    const symbol = symbolInput.value.trim().toUpperCase();
    const timeframe = selectedTimeframe;
    const source = sourceSelect.value;
    const chartType = "candlestick";
    chartManager.createChart(id, { symbol, timeframe, source, chartType });
    newCharts.push({ id, symbol });
  }
  layoutManager.applyLayout();

  const symbolToChartIds = {};
  for (const { id, symbol } of newCharts) {
    if (!symbolToChartIds[symbol]) symbolToChartIds[symbol] = [];
    symbolToChartIds[symbol].push(id);
  }

  const fetches = newCharts.map(({ id }) => loadHistory(id));
  Promise.all(fetches).then(() => {
    if (myVersion !== layoutVersion) return;
    for (const [symbol, lines] of Object.entries(savedLinesPerSymbol)) {
      const chartIds = symbolToChartIds[symbol] || [];
      chartIds.forEach(chartId => {
        lines.forEach(line => {
          if (typeof line === "number") {
            chartManager.addHorizontalLine(chartId, line);
          } else {
            chartManager.addHorizontalLine(chartId, line.price, { color: line.color, lineWidth: line.lineWidth, lineStyle: line.lineStyle });
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
      }))
    });
  }
  const state = {
    layoutCount: currentLayoutCount,
    layoutOption: currentLayoutOption,
    symbol: symbolInput.value,
    source: sourceSelect.value,
    timeframe: selectedTimeframe,
    sync: { ...chartManager.sync },
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

  if (state.sync) {
    Object.assign(chartManager.sync, state.sync);
    document.querySelectorAll(".layout-sync-item input[type=checkbox]").forEach((cb, i) => {
      const key = SYNC_KEYS[i];
      if (key && key in state.sync) cb.checked = state.sync[key];
    });
  }

  document.querySelectorAll("[data-btf]").forEach(b => {
    b.classList.toggle("active", b.dataset.btf === selectedTimeframe);
  });

  layoutManager.setLayoutByCount(currentLayoutCount, currentLayoutOption);
  layoutTriggerText.textContent = currentLayoutCount;

  const chartIds = [];
  for (const chartCfg of state.charts) {
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
        const series = chartObj.chart.addLineSeries({
          color, lineWidth,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: true
        });
        chartObj.indicators[indId] = series;
      });
    }

    chartIds.push({ id, chartCfg });
  }
  layoutManager.applyLayout();

  const fetches = chartIds.map(({ id, chartCfg }) =>
    loadHistory(id, null, chartCfg.symbol, chartCfg.timeframe, chartCfg.source, chartCfg.chartType)
  );
  Promise.all(fetches).then(() => {
    for (const { id, chartCfg } of chartIds) {
      if (chartCfg.horizontalLines && chartCfg.horizontalLines.length > 0) {
        chartCfg.horizontalLines.forEach(line => {
          if (typeof line === "number") {
            chartManager.addHorizontalLine(id, line);
          } else {
            chartManager.addHorizontalLine(id, line.price, { color: line.color, lineWidth: line.lineWidth, lineStyle: line.lineStyle });
          }
        });
      }
    }
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

loadFromServer().then(() => loadSources()).then(() => {
  const url = new URLSearchParams(location.search);
  const urlSymbol = (url.get("symbol") || "").trim().toUpperCase();
  const urlTf = (url.get("timeframe") || "5m").toLowerCase();
  if (urlSymbol) {
    symbolInput.value = urlSymbol;
    selectedTimeframe = urlTf;
    autoLoad();
    return;
  }
  const savedState = loadState();
  if (savedState && restoreState(savedState)) {
    log("State restored from server/localStorage");
  } else {
    autoLoad();
  }
});

log("App initialized");

async function updateWatchlistPrices() {
  const items = document.querySelectorAll(".watchlist-item[data-symbol]");
  const symbols = Array.from(items).map(el => el.dataset.symbol);
  if (symbols.length === 0) return;
  try {
    const res = await fetch(`/api/prices?symbols=${symbols.join(",")}`);
    const data = await res.json();
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
    if (_pricesTimer) {
      clearInterval(_pricesTimer);
      _pricesTimer = null;
    }
  } else {
    if (!_pricesTimer) _pricesTimer = setInterval(updateWatchlistPrices, 5000);
    updateWatchlistPrices();
  }
});

// === ATR Scanner ===
(function() {
  const btn = document.getElementById("atr-scan-btn");
  if (!btn) return;

  function setFlagDirect(ticker, color) {
    const flags = loadFlags();
    flags[ticker] = color;
    saveFlags(flags);
  }

  const SCAN_FLAGS_KEY = "trading-scan-flags";
  function loadScanFlags() {
    try { return JSON.parse(localStorage.getItem(SCAN_FLAGS_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveScanFlags(flags) {
    try { localStorage.setItem(SCAN_FLAGS_KEY, JSON.stringify(flags)); }
    catch {}
  }
  function clearStaleScanFlags(nextScanFlags) {
    const old = loadScanFlags();
    const flags = loadFlags();
    for (const ticker of Object.keys(old)) {
      if (nextScanFlags[ticker]) continue;
      if (ticker in flags) {
        delete flags[ticker];
      }
    }
    saveFlags(flags);
    saveScanFlags(nextScanFlags);
  }

  function getWatchlistTickers() {
    return new Set(loadTickers().map(t => t.ticker));
  }

  btn.addEventListener("click", () => {
    if (document.querySelector("#atr-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "atr-overlay";
    overlay.className = "ind-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "ind-modal";
    modal.innerHTML = `
      <h3>ATR-сканер MOEX</h3>
      <label>Порог ATR (пункты)</label>
      <input type="number" id="atr-threshold" min="0" step="0.1" value="5" style="width:100%">
      <label>Дата торгов</label>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="date" id="atr-date" style="flex:1">
        <button type="button" class="tool-btn" id="atr-date-refresh" title="Обновить (последний торговый день)" style="padding:2px 8px;font-size:14px">🔄</button>
      </div>
      <div id="atr-result" style="margin-top:10px;font-size:12px;color:var(--text-secondary);min-height:18px"></div>
      <div class="ind-modal-btns">
        <button class="ind-cancel">Отмена</button>
        <button class="ind-save">Сканировать</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector(".ind-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    const dateInput = modal.querySelector("#atr-date");
    const refreshBtn = modal.querySelector("#atr-date-refresh");

    async function fillLastTradingDay() {
      try {
        const resp = await fetch("/api/scan/last-trading-day");
        const data = await resp.json();
        if (data.date) dateInput.value = data.date;
      } catch (e) { /* ignore */ }
    }
    fillLastTradingDay();
    refreshBtn.addEventListener("click", fillLastTradingDay);

    modal.querySelector(".ind-save").addEventListener("click", async () => {
      const threshold = parseFloat(modal.querySelector("#atr-threshold").value) || 0;
      const dateVal = dateInput.value || null;
      const resultEl = modal.querySelector("#atr-result");
      const scanBtn = modal.querySelector(".ind-save");
      scanBtn.disabled = true;
      scanBtn.textContent = "Загрузка...";
      resultEl.textContent = "";

      try {
        const resp = await fetch("/api/scan/atr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ atr_threshold: threshold, date: dateVal })
        });
        const data = await resp.json();
        if (data.error) {
          resultEl.textContent = data.error;
          resultEl.style.color = "#ef5350";
          scanBtn.disabled = false;
          scanBtn.textContent = "Сканировать";
          return;
        }

        const results = data.results || [];
        const wlTickers = getWatchlistTickers();
        let buyCount = 0, sellCount = 0, skipped = 0;
        const nextScanFlags = {};

        for (const r of results) {
          if (!r.direction) continue;
          if (!wlTickers.has(r.ticker)) { skipped++; continue; }
          const color = r.direction === "buy" ? "green" : "red";
          setFlagDirect(r.ticker, color);
          nextScanFlags[r.ticker] = color;
          if (r.high > 0 && r.low > 0) {
            chartManager.setAutoLevels(r.ticker, r.high, r.low, r.evening_high, r.evening_low);
          }
          if (r.direction === "buy") buyCount++;
          else sellCount++;
        }

        clearStaleScanFlags(nextScanFlags);
        renderWatchlist();

        const total = buyCount + sellCount;
        resultEl.style.color = "";
        resultEl.textContent = `Флаги проставлены: ${total} (${buyCount} покупка, ${sellCount} продажа) | линии+алерты мин/макс: ${total} | ${skipped} не в вочлисте | дата: ${data.date}`;
      } catch (e) {
        resultEl.textContent = "Ошибка: " + e.message;
        resultEl.style.color = "#ef5350";
      }
      scanBtn.disabled = false;
      scanBtn.textContent = "Сканировать";
    });
  });
})();
