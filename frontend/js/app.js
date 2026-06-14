import { ChartManager } from "./chart-manager.js";
import { WSClient } from "./ws-client.js";
import { LayoutManager } from "./layout-manager.js";
import { generateId, log } from "./utils.js";

let selectedTimeframe = "4h";
let isLoading = false;

function loadChartData(chartId, symbol, timeframe, source, chartType) {
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

// Symbol Search
const symbolSearch = document.getElementById("symbol-search");
const symbolSearchTrigger = document.getElementById("symbol-search-trigger");
const symbolSearchDropdown = document.getElementById("symbol-search-dropdown");
const symbolSearchInput = document.getElementById("symbol-search-input");
const symbolSearchList = document.getElementById("symbol-search-list");
const symbolSearchValue = document.getElementById("symbol-search-value");

function openSymbolSearch() {
  symbolSearchDropdown.classList.remove("hidden");
  symbolSearchInput.value = "";
  symbolSearchInput.focus();
  filterSymbolList("");
}

function closeSymbolSearch() {
  symbolSearchDropdown.classList.add("hidden");
}

function filterSymbolList(query) {
  const items = symbolSearchList.querySelectorAll(".symbol-search-item");
  const groups = symbolSearchList.querySelectorAll(".symbol-search-group");
  const q = query.toUpperCase();

  items.forEach(item => {
    const symbol = item.dataset.symbol.toUpperCase();
    const name = item.querySelector(".ss-name").textContent.toUpperCase();
    const match = !q || symbol.includes(q) || name.includes(q);
    item.style.display = match ? "flex" : "none";
  });

  groups.forEach(group => {
    const visibleItems = group.querySelectorAll(".symbol-search-item:not([style*='display: none'])");
    group.style.display = visibleItems.length > 0 ? "block" : "none";
  });
}

function selectSymbol(item) {
  const symbol = item.dataset.symbol;
  const source = item.dataset.source || "mock";

  symbolInput.value = symbol;
  sourceSelect.value = source;
  symbolSearchValue.textContent = symbol;

  symbolSearchList.querySelectorAll(".symbol-search-item").forEach(i => i.classList.remove("selected"));
  item.classList.add("selected");

  closeSymbolSearch();
  autoLoad();
}

symbolSearchTrigger.addEventListener("click", (e) => {
  e.stopPropagation();
  if (symbolSearchDropdown.classList.contains("hidden")) {
    openSymbolSearch();
  } else {
    closeSymbolSearch();
  }
});

symbolSearchInput.addEventListener("input", (e) => {
  filterSymbolList(e.target.value);
});

symbolSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSymbolSearch();
  } else if (e.key === "Enter") {
    const firstVisible = symbolSearchList.querySelector(".symbol-search-item:not([style*='display: none'])");
    if (firstVisible) selectSymbol(firstVisible);
  }
});

symbolSearchList.querySelectorAll(".symbol-search-item").forEach(item => {
  item.addEventListener("click", () => selectSymbol(item));
});

document.addEventListener("click", (e) => {
  if (!symbolSearch.contains(e.target)) {
    closeSymbolSearch();
  }
});
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
    chartManager.updateCandle(id, candle);
  }
});

wsClient.connect();

// Watchlist items
document.querySelectorAll(".watchlist-item").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".watchlist-item").forEach(i => i.classList.remove("selected"));
    item.classList.add("selected");
    symbolInput.value = item.dataset.symbol;
    if (item.dataset.source) {
      sourceSelect.value = item.dataset.source;
    }
    autoLoad();
  });
});



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
    document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    chartManager._activeTool = btn.dataset.tool;
  });
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
  const timeframe = selectedTimeframe;
  const chartType = "candlestick";

  if (!symbol) return;

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

    let chartId = forceChartId;
    if (!chartId && chartManager.charts.size > 0) {
      chartId = chartManager.getAllChartIds()[0];
    }

    if (chartId) {
      const chartObj = chartManager.charts.get(chartId);
      if (chartObj && chartObj.chartType !== chartType) {
        chartManager.changeChartType(chartId, chartType);
      }
      chartObj.config._lastCandles = data.candles;
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
  6: [{ rows: 2, cols: 3 }],
  9: [{ rows: 3, cols: 3 }],
  12: [{ rows: 4, cols: 3 }],
};

let currentLayoutCount = 1;
let currentLayoutOption = 0;

function renderLayoutGrid() {
  layoutGrid.innerHTML = "";

  const counts = [1, 2, 3, 6, 9, 12];

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
      symbol: chartObj.config.symbol || "BTCUSDT",
      source: chartObj.config.source || "mock",
      timeframe: chartObj.config.timeframe || "4h",
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
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    log("Failed to load state:", e);
    return null;
  }
}

function restoreState(state) {
  if (!state || !state.charts || state.charts.length === 0) return false;

  currentLayoutCount = state.layoutCount || 1;
  currentLayoutOption = state.layoutOption || 0;
  selectedTimeframe = state.timeframe || "4h";

  symbolInput.value = state.symbol || "BTCUSDT";
  sourceSelect.value = state.source || "mock";
  symbolSearchValue.textContent = state.symbol || "BTCUSDT";

  layoutManager.setLayoutByCount(currentLayoutCount, currentLayoutOption);
  layoutTriggerText.textContent = currentLayoutCount;

  requestAnimationFrame(() => {
    setTimeout(() => {
      state.charts.forEach(chartCfg => {
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
          }, 300);
        }
      });
      layoutManager.applyLayout();
    }, 50);
  });

  return true;
}

window.addEventListener("beforeunload", saveState);

loadSources().then(() => {
  const savedState = loadState();
  if (savedState && restoreState(savedState)) {
    log("State restored from localStorage");
  } else {
    autoLoad();
  }
});

log("App initialized");
