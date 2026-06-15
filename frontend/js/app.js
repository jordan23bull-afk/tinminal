import { ChartManager, addSymbolToList, removeSymbolFromAll, refreshAllSymbolDropdowns } from "./chart-manager.js";
import { WSClient } from "./ws-client.js";
import { LayoutManager } from "./layout-manager.js";
import { generateId, log } from "./utils.js";

let selectedTimeframe = "1h";
let isLoading = false;

function loadChartData(chartId, symbol, timeframe, source, chartType) {
  if (wsClient.connected) {
    wsClient.subscribe(symbol, timeframe, source);
  }
  fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, symbol, timeframe, limit: 500, indicators: {} })
  })
    .then(res => res.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      const chartObj = chartManager.charts.get(chartId);
      if (chartObj) {
        if (chartObj.chartType !== chartType) {
          chartManager.changeChartType(chartId, chartType);
        }
        chartObj.config._lastCandles = data.candles;

        const indicatorData = {};
        for (const indId of Object.keys(chartObj.indicators)) {
          const calcData = chartManager._calcIndicator(indId, data.candles);
          if (calcData) indicatorData[indId] = calcData;
        }

        chartManager.updateData(chartId, data.candles, indicatorData);
        if (data.candles.length > 0) {
          chartManager.checkAlerts(data.candles[data.candles.length - 1]);
        }
      }
    })
    .catch(e => log("Load chart data error:", e));
}

const chartManager = new ChartManager("charts-grid", loadChartData);
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
    const symbol = symbolInput.value.trim().toUpperCase();
    const source = sourceSelect.value;
    wsClient.subscribe(symbol, selectedTimeframe, source);
  } else {
    connectionStatus.textContent = "Disconnected";
    connectionStatus.className = "status-disconnected";
  }
});

wsClient.on("candleUpdate", (symbol, timeframe, candle) => {
  for (const id of chartManager.getAllChartIds()) {
    const chartObj = chartManager.charts.get(id);
    if (chartObj && chartObj.config.symbol === symbol && chartObj.config.timeframe === timeframe) {
      chartManager.updateCandle(id, candle);
    }
  }
});

wsClient.connect();

// Watchlist items
function setupWatchlistItem(item) {
  item.addEventListener("click", (e) => {
    if (e.target.closest(".wl-delete")) return;
    document.querySelectorAll(".watchlist-item").forEach(i => i.classList.remove("selected"));
    item.classList.add("selected");
    const symbol = item.dataset.symbol;
    const source = item.dataset.source || "moex";
    const activeId = chartManager.activeChartId;
    if (activeId) {
      const chartObj = chartManager.charts.get(activeId);
      if (chartObj) {
        chartObj.config.symbol = symbol;
        chartObj.config.source = source;
        const btn = chartObj.container.querySelector(".ch-symbol-btn");
        if (btn) btn.textContent = symbol;
        loadChartData(activeId, symbol, chartObj.config.timeframe, source, chartObj.chartType);
      }
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
      item.remove();
      removeSymbolFromAll(ticker);
    });
    item.appendChild(del);
  }
}

document.querySelectorAll(".watchlist-item").forEach(setupWatchlistItem);

// Custom tickers
const CUSTOM_TICKERS_KEY = "trading-dashboard-custom-tickers";

function loadCustomTickers() {
  try {
    const raw = localStorage.getItem(CUSTOM_TICKERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCustomTickers(tickers) {
  localStorage.setItem(CUSTOM_TICKERS_KEY, JSON.stringify(tickers));
}

function addCustomTicker(ticker, name) {
  ticker = ticker.toUpperCase().trim();
  if (!ticker) return;
  name = name || ticker;
  addSymbolToList(ticker, name);
  refreshAllSymbolDropdowns();

  const wlItems = document.querySelector(".watchlist-items");
  const div = document.createElement("div");
  div.className = "watchlist-item";
  div.dataset.symbol = ticker;
  div.dataset.source = "moex";
  div.innerHTML = `<div class="wl-icon moex">${name.charAt(0)}</div><div class="wl-info"><span class="wl-symbol">${ticker}</span><span class="wl-price">—</span></div><span class="wl-change">—</span>`;
  setupWatchlistItem(div);
  wlItems.appendChild(div);

  const tickers = loadCustomTickers();
  if (!tickers.find(t => t.ticker === ticker)) {
    tickers.push({ ticker, name });
    saveCustomTickers(tickers);
  }
}

// Restore custom tickers from localStorage
loadCustomTickers().forEach(t => addCustomTicker(t.ticker, t.name));

// "+" button in watchlist
const addTickerBtn = document.querySelector(".watchlist-header .icon-btn-sm");
if (addTickerBtn) {
  addTickerBtn.addEventListener("click", () => {
    const input = prompt("Введите тикер MOEX (например TATN, ROSN, BANE):");
    if (!input) return;
    const ticker = input.toUpperCase().trim();
    if (!ticker) return;
    addCustomTicker(ticker, ticker);
  });
}

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

// Update clock
function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const offset = -now.getTimezoneOffset() / 60;
  currentTimeEl.textContent = `${h}:${m}:${s} UTC${offset >= 0 ? "+" : ""}${offset}`;
}
setInterval(updateClock, 1000);
updateClock();

// Tools
document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    chartManager._activeTool = btn.dataset.tool;
  });
});

// Magnet toggle
document.getElementById("magnet-btn").addEventListener("click", function() {
  chartManager._magnetOn = !chartManager._magnetOn;
  this.classList.toggle("active", chartManager._magnetOn);
});

// Watchlist toggle
document.getElementById("watchlist-toggle").addEventListener("click", () => {
  document.querySelector(".sidebar-right").classList.toggle("hidden");
});

async function loadSources() {
  try {
    const res = await fetch("/api/sources");
    const data = await res.json();
    if (data.sources && data.sources.includes("moex")) {
      sourceSelect.value = "moex";
    } else if (data.sources && data.sources.length > 0) {
      sourceSelect.value = data.sources[0];
    }
  } catch (e) {
    log("Failed to load sources:", e);
  }
}

function autoLoad(indicatorName = null) {
  if (isLoading) return;
  loadHistory(null, indicatorName);
}

async function loadHistory(forceChartId = null, indicatorName = null) {
  const source = sourceSelect.value;
  const symbol = symbolInput.value.trim().toUpperCase();
  const chartType = "candlestick";

  if (!symbol) return;

  let chartId = forceChartId;
  if (!chartId && chartManager.charts.size > 0) {
    chartId = chartManager.getAllChartIds()[0];
  }

  let timeframe = selectedTimeframe;
  if (chartId) {
    const firstChart = chartManager.charts.get(chartId);
    if (firstChart && firstChart.config.timeframe) {
      timeframe = firstChart.config.timeframe;
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

  try {
    const res = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, symbol, timeframe, limit: 500, indicators })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (chartId) {
      const chartObj = chartManager.charts.get(chartId);
      if (chartObj && chartObj.chartType !== chartType) {
        chartManager.changeChartType(chartId, chartType);
      }
      chartObj.config.symbol = symbol;
      chartObj.config.source = source;
      chartObj.config.timeframe = timeframe;
      chartObj.config._lastCandles = data.candles;
      const symbolBtn = chartObj.container.querySelector(".ch-symbol-btn");
      if (symbolBtn) symbolBtn.textContent = symbol;
      chartManager.updateData(chartId, data.candles, data.indicators);
    } else {
      chartId = generateId();
      chartManager.createChart(chartId, { symbol, timeframe, source, chartType });
      const chartObj = chartManager.charts.get(chartId);
      chartObj.config._lastCandles = data.candles;
      chartManager.updateData(chartId, data.candles, data.indicators);
    }

    statusText.textContent = `${symbol} ${timeframe} | ${data.candles.length} candles`;
    if (!forceChartId) {
      layoutManager.autoLayout(chartManager.charts.size);
    }

    // Auto-subscribe to real-time updates
    if (wsClient.connected) {
      wsClient.subscribe(symbol, timeframe, source);
    }
  } catch (e) {
    log("Load history error:", e);
    if (!forceChartId) statusText.textContent = `Error: ${e.message}`;
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
  currentLayoutCount = count;
  currentLayoutOption = optionIndex;
  layoutTriggerText.textContent = count;

  document.querySelectorAll(".layout-option").forEach(btn => {
    btn.classList.toggle("active",
      parseInt(btn.dataset.count) === count && parseInt(btn.dataset.option) === optionIndex
    );
  });

  const ids = chartManager.getAllChartIds();
  while (ids.length > 0) {
    chartManager.removeChart(ids.pop());
  }

  layoutManager.setLayoutByCount(count, optionIndex);

  requestAnimationFrame(() => {
    setTimeout(() => {
      for (let i = 0; i < count; i++) {
        const id = generateId();
        const symbol = symbolInput.value.trim().toUpperCase();
        const timeframe = selectedTimeframe;
        const source = sourceSelect.value;
        const chartType = "candlestick";
        chartManager.createChart(id, { symbol, timeframe, source, chartType });
        loadHistory(id);
      }
      layoutManager.applyLayout();
    }, 50);
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
      symbol: chartObj.config.symbol || "SBER",
      source: chartObj.config.source || "moex",
      timeframe: chartObj.config.timeframe || "1h",
      chartType: chartObj.chartType || "candlestick",
      indicators: Object.keys(chartObj.indicators),
      horizontalLines: chartObj._horizontalLines.map(l => l.options().price)
    });
  }
  const state = {
    layoutCount: currentLayoutCount,
    layoutOption: currentLayoutOption,
    symbol: symbolInput.value,
    source: sourceSelect.value,
    timeframe: selectedTimeframe,
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
    if (state.charts) {
      state.charts.forEach(c => {
        if (!c.timeframe || c.timeframe === "4h") c.timeframe = "1h";
      });
    }
    if (state.timeframe === "4h") state.timeframe = "1h";
    return state;
  } catch (e) {
    log("Failed to load state:", e);
    return null;
  }
}

function restoreState(state) {
  if (!state || !state.charts || state.charts.length === 0) return false;

  currentLayoutCount = state.layoutCount || 1;
  currentLayoutOption = state.layoutOption || 0;
  selectedTimeframe = state.timeframe || "1h";

  symbolInput.value = state.symbol || "SBER";
  sourceSelect.value = state.source || "moex";

  layoutManager.setLayoutByCount(currentLayoutCount, currentLayoutOption);
  layoutTriggerText.textContent = currentLayoutCount;

  requestAnimationFrame(() => {
    setTimeout(() => {
      state.charts.forEach((chartCfg, index) => {
        setTimeout(() => {
          const id = generateId();
          chartManager.createChart(id, {
            symbol: chartCfg.symbol,
            source: chartCfg.source,
            timeframe: chartCfg.timeframe,
            chartType: chartCfg.chartType
          });

          const chartObj = chartManager.charts.get(id);
          if (chartObj && chartCfg.indicators && chartCfg.indicators.length > 0) {
            chartCfg.indicators.forEach(indId => {
              const color = chartManager.indicatorColors[indId] || "#787B86";
              const series = chartObj.chart.addLineSeries({
                color,
                lineWidth: 2,
                priceFormat: { type: "price", precision: 2, minMove: 0.01 }
              });
              chartObj.indicators[indId] = series;
            });
          }

          loadChartData(id, chartCfg.symbol, chartCfg.timeframe, chartCfg.source, chartCfg.chartType);

          if (chartCfg.horizontalLines && chartCfg.horizontalLines.length > 0) {
            setTimeout(() => {
              chartCfg.horizontalLines.forEach(price => {
                chartManager.addHorizontalLine(id, price);
              });
              chartManager.restoreAlertColors();
            }, 300);
          }
        }, index * 300);
      });
      layoutManager.applyLayout();
    }, 50);
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

loadSources().then(() => {
  const savedState = loadState();
  if (savedState && restoreState(savedState)) {
    log("State restored from localStorage");
  } else {
    autoLoad();
  }
});

log("App initialized");
