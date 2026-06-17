import { log } from "./utils.js";

const SYMBOLS = [
  { ticker: "SBER", name: "Сбербанк", source: "moex", icon: "С" },
  { ticker: "GAZP", name: "Газпром", source: "moex", icon: "Г" },
  { ticker: "LKOH", name: "Лукойл", source: "moex", icon: "Л" },
  { ticker: "YDEX", name: "Яндекс", source: "moex", icon: "Я" },
  { ticker: "GMKN", name: "Норникель", source: "moex", icon: "Н" },
  { ticker: "ROSN", name: "Роснефть", source: "moex", icon: "Р" },
  { ticker: "SNGS", name: "Сургутнефтегаз", source: "moex", icon: "С" },
  { ticker: "VTBR", name: "ВТБ", source: "moex", icon: "В" },
  { ticker: "TCSG", name: "Т-Банк", source: "moex", icon: "Т" },
  { ticker: "PHOR", name: "Фосагро", source: "moex", icon: "Ф" },
  { ticker: "SBERP", name: "Сбербанк-П", source: "moex", icon: "С" },
  { ticker: "GMKNP", name: "Норникель-П", source: "moex", icon: "Н" },
];

function addSymbolToList(ticker, name) {
  if (SYMBOLS.find(s => s.ticker === ticker)) return false;
  const icon = name.charAt(0).toUpperCase();
  SYMBOLS.push({ ticker, name, source: "moex", icon });
  return true;
}

function removeSymbolFromAll(ticker) {
  const idx = SYMBOLS.findIndex(s => s.ticker === ticker);
  if (idx >= 0) SYMBOLS.splice(idx, 1);
  refreshAllSymbolDropdowns();
  try {
    const raw = localStorage.getItem("trading-dashboard-custom-tickers");
    const tickers = raw ? JSON.parse(raw) : [];
    const filtered = tickers.filter(t => t.ticker !== ticker);
    localStorage.setItem("trading-dashboard-custom-tickers", JSON.stringify(filtered));
  } catch {}
  try {
    const raw = localStorage.getItem("trading-dashboard-deleted-tickers");
    const deleted = raw ? JSON.parse(raw) : [];
    if (!deleted.includes(ticker)) {
      deleted.push(ticker);
      localStorage.setItem("trading-dashboard-deleted-tickers", JSON.stringify(deleted));
    }
  } catch {}
}

function getDeletedTickers() {
  try {
    const raw = localStorage.getItem("trading-dashboard-deleted-tickers");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function refreshAllSymbolDropdowns() {
  document.querySelectorAll(".ch-symbol-dropdown").forEach(dropdown => {
    const list = dropdown.querySelector(".ch-symbol-list");
    if (!list) return;
    list.innerHTML = "";
    SYMBOLS.forEach(s => {
      const item = document.createElement("div");
      item.className = "ch-symbol-item";
      item.dataset.ticker = s.ticker;
      item.dataset.source = s.source;
      item.innerHTML = `<span class="ch-si-icon">${s.icon}</span><span class="ch-si-name">${s.name}</span><span class="ch-si-ticker">${s.ticker}</span>`;
      list.appendChild(item);
    });
  });
}

const TIMEFRAMES = [
  { tf: "1m", label: "1m" },
  { tf: "10m", label: "10m" },
  { tf: "1h", label: "1ч" },
  { tf: "1d", label: "Д" },
];

const INDICATOR_TYPES = [
  { id: "sma", label: "SMA", params: [{ key: "period", label: "Период", default: 20 }] },
  { id: "ema", label: "EMA", params: [{ key: "period", label: "Период", default: 20 }] },
  { id: "rsi", label: "RSI", params: [{ key: "period", label: "Период", default: 14 }] },
  { id: "macd", label: "MACD", params: [
    { key: "fast", label: "Быстрый", default: 12 },
    { key: "slow", label: "Медленный", default: 26 },
    { key: "signal", label: "Сигнал", default: 9 }
  ]},
  { id: "bollinger", label: "Bollinger", params: [
    { key: "period", label: "Период", default: 20 },
    { key: "stddev", label: "Отклонение", default: 2 }
  ]},
  { id: "atr", label: "ATR", params: [{ key: "period", label: "Период", default: 14 }] },
  { id: "wma", label: "WMA", params: [{ key: "period", label: "Период", default: 20 }] },
  { id: "stoch", label: "Stochastic", params: [
    { key: "k", label: "%K", default: 14 },
    { key: "d", label: "%D", default: 3 }
  ]},
  { id: "poc", label: "POC", params: [
    { key: "period", label: "Период (0=авто)", default: 0 },
    { key: "bins", label: "Уровни", default: 30 }
  ], extra: [
    { key: "color", label: "Цвет", type: "color", default: "#FF5722" },
    { key: "lineWidth", label: "Толщина", type: "number", default: 2 },
    { key: "extendMode", label: "Режим", type: "select", options: [
      { value: "day", label: "Внутри дня" },
      { value: "cross", label: "До пересечения" }
    ]}
  ]},
];

const INDICATORS = [];

function loadCustomIndicators() {
  try {
    const raw = localStorage.getItem("trading-dashboard-custom-indicators");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCustomIndicators(list) {
  localStorage.setItem("trading-dashboard-custom-indicators", JSON.stringify(list));
}

function getDeletedIndicators() {
  try {
    const raw = localStorage.getItem("trading-dashboard-deleted-indicators");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function mergeIndicators() {
  const custom = loadCustomIndicators();
  const deleted = getDeletedIndicators();
  const builtins = [
    { id: "rsi", label: "RSI" },
    { id: "macd", label: "MACD" },
    { id: "sma", label: "SMA" },
  ];
  INDICATORS.length = 0;
  builtins.forEach(b => {
    if (!deleted.includes(b.id)) INDICATORS.push(b);
  });
  custom.forEach(c => {
    if (!INDICATORS.find(i => i.id === c.id)) {
      INDICATORS.push({ id: c.id, label: c.label, params: c.params });
    }
  });
}

const CUSTOM_INDICATORS_KEY = "trading-dashboard-custom-indicators";

export class ChartManager {
  constructor(containerId, onChartChange) {
    this.container = document.getElementById(containerId);
    this.charts = new Map();
    this.onChartChange = onChartChange || (() => {});
    this.indicatorColors = {
      rsi: "#2962FF",
      macd: "#FF6D00",
      macd_signal: "#9C27B0",
      macd_hist: "#787B86",
      sma: "#e91e63",
      poc: "#FF5722"
    };
    this.showVolume = true;
    this._activeTool = "crosshair";
    this.activeChartId = null;
    this._magnetOn = false;
    this.alerts = this._loadAlerts();
    this._initContextMenu();
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  _loadAlerts() {
    try {
      return JSON.parse(localStorage.getItem("trading-alerts") || "[]");
    } catch { return []; }
  }

  _saveAlerts() {
    localStorage.setItem("trading-alerts", JSON.stringify(this.alerts));
  }

  _initContextMenu() {
    this._ctxMenu = document.createElement("div");
    this._ctxMenu.className = "hline-ctx hidden";
    document.body.appendChild(this._ctxMenu);
    document.addEventListener("click", () => this._ctxMenu.classList.add("hidden"));
  }

  _showContextMenu(e, chartId, price) {
    const existing = this.alerts.find(a => a.chartId === chartId && Math.abs(a.price - price) < 0.5);
    let html = "";
    if (!existing) {
      html += `<div class="hline-ctx-item" data-action="add-alert">Добавить алерт</div>`;
    } else {
      html += `<div class="hline-ctx-item" data-action="remove-alert">Удалить алерт</div>`;
    }
    html += `<div class="hline-ctx-item hline-ctx-danger" data-action="remove-line">Удалить линию</div>`;
    this._ctxMenu.innerHTML = html;
    this._ctxData = { chartId, price };
    this._ctxMenu.style.left = e.clientX + "px";
    this._ctxMenu.style.top = e.clientY + "px";
    this._ctxMenu.classList.remove("hidden");
    this._ctxMenu.querySelectorAll(".hline-ctx-item").forEach(item => {
      item.addEventListener("click", () => {
        const action = item.dataset.action;
        if (action === "add-alert") {
          this.addAlert(chartId, price);
        } else if (action === "remove-alert") {
          this.removeAlert(chartId, price);
        } else if (action === "remove-line") {
          this._removeLineByPrice(chartId, price);
        }
        this._ctxMenu.classList.add("hidden");
      });
    });
  }

  addAlert(chartId, price) {
    const chartObj = this.charts.get(chartId);
    const symbol = chartObj ? chartObj.config.symbol : "???";
    this.alerts.push({ chartId, symbol, price, id: Date.now() });
    this._saveAlerts();
    this._updateLineColor(chartId, price, "#FF9800");
    log(`Alert added: ${symbol} @ ${price}`);
  }

  removeAlert(chartId, price) {
    this.alerts = this.alerts.filter(a => !(a.chartId === chartId && Math.abs(a.price - price) < 0.5));
    this._saveAlerts();
    this._updateLineColor(chartId, price, "#2196F3");
  }

  _updateLineColor(chartId, price, color) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj || !chartObj.mainSeries) return;
    const line = chartObj._horizontalLines.find(l => {
      const p = l.options().price;
      return p != null && Math.abs(p - price) < 0.5;
    });
    if (!line) return;
    chartObj.mainSeries.removePriceLine(line);
    const newLine = chartObj.mainSeries.createPriceLine({
      price,
      color,
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: ""
    });
    chartObj._horizontalLines = chartObj._horizontalLines.map(l => l === line ? newLine : l);
  }

  _removeLineByPrice(chartId, price) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj) return;
    const line = chartObj._horizontalLines.find(l => {
      const p = l.options().price;
      return p != null && Math.abs(p - price) < 0.5;
    });
    if (line) {
      chartObj.mainSeries.removePriceLine(line);
      chartObj._horizontalLines = chartObj._horizontalLines.filter(l => l !== line);
    }
    this.removeAlert(chartId, price);
  }

  checkAlerts(candle) {
    let changed = false;
    for (const alert of this.alerts) {
      if (alert.triggered) continue;
      const chartObj = this.charts.get(alert.chartId);
      if (!chartObj || chartObj.config.symbol !== alert.symbol) continue;
      if (candle.high >= alert.price && candle.low <= alert.price) {
        alert.triggered = true;
        changed = true;
        this._updateLineColor(alert.chartId, alert.price, "#F44336");
        this._sendNotification(alert, candle);
      }
    }
    if (changed) {
      this.alerts = this.alerts.filter(a => !a.triggered);
      this._saveAlerts();
    }
  }

  _sendNotification(alert, candle) {
    const title = `${alert.symbol} — ${alert.price}`;
    const body = `Цена: ${candle.close}`;
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, requireInteraction: false });
      n.onclick = () => { window.focus(); n.close(); };
    }
    this._playSound();
    log(`Alert: ${title}`);
  }

  _playSound() {
    try {
      const audio = new Audio("sounds/alert.wav");
      audio.volume = 0.5;
      audio.play().catch(() => {});
    } catch {}
  }

  _buildHeader(id) {
    const header = document.createElement("div");
    header.className = "chart-header";

    const symbolBtn = document.createElement("button");
    symbolBtn.className = "ch-symbol-btn";
    const chartObj = this.charts.get(id);
    const cfg = chartObj ? chartObj.config : {};
    symbolBtn.textContent = cfg.symbol || "BTCUSDT";
    symbolBtn.dataset.chartId = id;

    const symbolDropdown = document.createElement("div");
    symbolDropdown.className = "ch-symbol-dropdown hidden";
    symbolDropdown.dataset.chartId = id;
    document.body.appendChild(symbolDropdown);

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "ch-symbol-search";
    searchInput.placeholder = "Поиск...";
    symbolDropdown.appendChild(searchInput);

    const list = document.createElement("div");
    list.className = "ch-symbol-list";
    SYMBOLS.forEach(s => {
      const item = document.createElement("div");
      item.className = "ch-symbol-item";
      item.dataset.ticker = s.ticker;
      item.dataset.source = s.source;
      item.innerHTML = `<span class="ch-si-icon">${s.icon}</span><span class="ch-si-name">${s.name}</span><span class="ch-si-ticker">${s.ticker}</span>`;
      list.appendChild(item);
    });
    symbolDropdown.appendChild(list);

    symbolBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".ch-symbol-dropdown").forEach(d => {
        if (d !== symbolDropdown) d.classList.add("hidden");
      });
      symbolDropdown.classList.toggle("hidden");
      if (!symbolDropdown.classList.contains("hidden")) {
        const rect = symbolBtn.getBoundingClientRect();
        symbolDropdown.style.position = "fixed";
        symbolDropdown.style.top = rect.bottom + "px";
        symbolDropdown.style.left = rect.left + "px";
        symbolDropdown.style.zIndex = "10000";
        searchInput.value = "";
        searchInput.focus();
        list.querySelectorAll(".ch-symbol-item").forEach(i => i.style.display = "");
      }
    });

    searchInput.addEventListener("input", () => {
      const q = searchInput.value.toUpperCase();
      list.querySelectorAll(".ch-symbol-item").forEach(item => {
        const match = item.dataset.ticker.includes(q) || item.querySelector(".ch-si-name").textContent.toUpperCase().includes(q);
        item.style.display = match ? "" : "none";
      });
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const ticker = searchInput.value.trim().toUpperCase();
        if (ticker) {
          symbolBtn.textContent = ticker;
          symbolDropdown.classList.add("hidden");
          this._updateChartConfig(id, { symbol: ticker, source: "moex" });
          this._reloadChart(id);
        }
      }
    });

    list.querySelectorAll(".ch-symbol-item").forEach(item => {
      item.addEventListener("click", () => {
        const ticker = item.dataset.ticker;
        const source = item.dataset.source;
        symbolBtn.textContent = ticker;
        symbolDropdown.classList.add("hidden");
        this._updateChartConfig(id, { symbol: ticker, source });
        this._reloadChart(id);
      });
    });

    const tfContainer = document.createElement("div");
    tfContainer.className = "ch-tf-buttons";
    TIMEFRAMES.forEach(t => {
      const btn = document.createElement("button");
      btn.className = "ch-tf-btn" + (t.tf === (cfg.timeframe || "1h") ? " active" : "");
      btn.textContent = t.label;
      btn.dataset.tf = t.tf;
      btn.addEventListener("click", () => {
        tfContainer.querySelectorAll(".ch-tf-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this._updateChartConfig(id, { timeframe: t.tf });
        this._reloadChart(id);
      });
      tfContainer.appendChild(btn);
    });

    const typeSelect = document.createElement("select");
    typeSelect.className = "ch-type-select";
    ["candlestick", "line", "area", "bar"].forEach(t => {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      if (t === (cfg.chartType || "candlestick")) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener("change", () => {
      this.changeChartType(id, typeSelect.value);
      this._updateChartConfig(id, { chartType: typeSelect.value });
    });

    const indContainer = document.createElement("div");
    indContainer.className = "ch-ind-buttons";
    this._renderIndicatorButtons(indContainer, id, cfg);

    const addIndBtn = document.createElement("button");
    addIndBtn.className = "ch-ind-btn";
    addIndBtn.textContent = "+";
    addIndBtn.title = "Создать индикатор";
    addIndBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._showIndicatorModal(id);
    });
    indContainer.appendChild(addIndBtn);

    header.appendChild(symbolBtn);
    header.appendChild(tfContainer);
    header.appendChild(typeSelect);
    header.appendChild(indContainer);

    return header;
  }

  _updateChartConfig(id, updates) {
    const chartObj = this.charts.get(id);
    if (chartObj) {
      Object.assign(chartObj.config, updates);
    }
  }

  _getChartSettings(id) {
    const chartObj = this.charts.get(id);
    const symbol = chartObj ? (chartObj.config.symbol || "default") : "default";
    try {
      const raw = localStorage.getItem("chart-settings-" + symbol);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  _saveChartSettings(id, settings) {
    const chartObj = this.charts.get(id);
    const symbol = chartObj ? (chartObj.config.symbol || "default") : "default";
    localStorage.setItem("chart-settings-" + symbol, JSON.stringify(settings));
  }

  _showChartSettings(id) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    const settings = this._getChartSettings(id);

    const defaults = {
      upColor: "#26a69a",
      downColor: "#ef5350",
      bgColor: "#131722",
      gridColor: "#242832",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    };
    const s = { ...defaults, ...settings };

    const overlay = document.createElement("div");
    overlay.className = "ind-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "ind-modal";
    modal.innerHTML = `
      <h3>Настройки графика</h3>
      <label>Цвет свечей вверх</label>
      <div class="chart-settings-color"><input type="color" id="cs-up" value="${s.upColor}"><span>${s.upColor}</span></div>
      <label>Цвет свечей вниз</label>
      <div class="chart-settings-color"><input type="color" id="cs-down" value="${s.downColor}"><span>${s.downColor}</span></div>
      <label>Фон графика</label>
      <div class="chart-settings-color"><input type="color" id="cs-bg" value="${s.bgColor}"><span>${s.bgColor}</span></div>
      <label>Цвет сетки</label>
      <div class="chart-settings-color"><input type="color" id="cs-grid" value="${s.gridColor}"><span>${s.gridColor}</span></div>
      <label>Фитиль вверх</label>
      <div class="chart-settings-color"><input type="color" id="cs-wickup" value="${s.wickUpColor}"><span>${s.wickUpColor}</span></div>
      <label>Фитиль вниз</label>
      <div class="chart-settings-color"><input type="color" id="cs-wickdown" value="${s.wickDownColor}"><span>${s.wickDownColor}</span></div>
      <div class="ind-modal-btns">
        <button class="ind-cancel">Отмена</button>
        <button class="ind-reset" id="cs-reset">Сбросить</button>
        <button class="ind-save">Применить</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelectorAll("input[type=color]").forEach(inp => {
      inp.addEventListener("input", () => {
        inp.nextElementSibling.textContent = inp.value;
      });
    });

    modal.querySelector(".ind-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector("#cs-reset").addEventListener("click", () => {
      const d = { up: defaults.upColor, down: defaults.downColor, bg: defaults.bgColor, grid: defaults.gridColor, wickup: defaults.wickUpColor, wickdown: defaults.wickDownColor };
      Object.entries(d).forEach(([k, v]) => {
        const inp = modal.querySelector(`#cs-${k}`);
        if (inp) { inp.value = v; inp.nextElementSibling.textContent = v; }
      });
    });

    modal.querySelector(".ind-save").addEventListener("click", () => {
      const newSettings = {
        upColor: modal.querySelector("#cs-up").value,
        downColor: modal.querySelector("#cs-down").value,
        bgColor: modal.querySelector("#cs-bg").value,
        gridColor: modal.querySelector("#cs-grid").value,
        wickUpColor: modal.querySelector("#cs-wickup").value,
        wickDownColor: modal.querySelector("#cs-wickdown").value,
      };
      this._saveChartSettings(id, newSettings);
      this._applyChartSettings(chartObj, newSettings);
      overlay.remove();
    });
  }

  _applyChartSettings(chartObj, s) {
    const chart = chartObj.chart;
    chart.applyOptions({
      layout: { background: { type: "solid", color: s.bgColor } },
      grid: { vertLines: { color: s.gridColor }, horzLines: { color: s.gridColor } }
    });
    if (chartObj.chartType === "candlestick" || chartObj.chartType === "bar") {
      chartObj.mainSeries.applyOptions({
        upColor: s.upColor, downColor: s.downColor,
        wickUpColor: s.wickUpColor, wickDownColor: s.wickDownColor,
      });
    }
  }

  _toggleIndicator(id, indId) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    if (!chartObj.config._activeIndicators) chartObj.config._activeIndicators = [];

    if (chartObj.indicators[indId]) {
      chartObj.chart.removeSeries(chartObj.indicators[indId]);
      delete chartObj.indicators[indId];
      chartObj.config._activeIndicators = chartObj.config._activeIndicators.filter(i => i !== indId);
    } else {
      const custom = loadCustomIndicators().find(c => c.id === indId);
      const color = (custom && custom.extra && custom.extra.color) || this.indicatorColors[indId] || "#787B86";
      const lineWidth = (custom && custom.extra && custom.extra.lineWidth) || 2;
      const series = chartObj.chart.addLineSeries({
        color,
        lineWidth,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 }
      });
      chartObj.indicators[indId] = series;
      chartObj.config._activeIndicators.push(indId);

      if (chartObj.config._lastCandles) {
        const data = this._calcIndicator(indId, chartObj.config._lastCandles);
        if (data) series.setData(data);
      }
    }
  }

  _renderIndicatorButtons(container, chartId, cfg) {
    container.querySelectorAll(".ch-ind-btn[data-indicator]").forEach(b => b.remove());
    INDICATORS.forEach(ind => {
      const btn = document.createElement("button");
      btn.className = "ch-ind-btn";
      btn.textContent = ind.label;
      btn.dataset.indicator = ind.id;
      if (cfg._activeIndicators && cfg._activeIndicators.includes(ind.id)) {
        btn.classList.add("active");
      }
      btn.addEventListener("click", () => {
        this._toggleIndicator(chartId, ind.id);
        btn.classList.toggle("active");
      });
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (confirm(`Удалить индикатор "${ind.label}"?`)) {
          this._deleteCustomIndicator(ind.id, chartId, container, cfg);
        }
      });
      container.insertBefore(btn, container.lastChild);
    });
  }

  _deleteCustomIndicator(indId, chartId, container, cfg) {
    const chartObj = this.charts.get(chartId);
    if (chartObj && chartObj.indicators[indId]) {
      chartObj.chart.removeSeries(chartObj.indicators[indId]);
      delete chartObj.indicators[indId];
      cfg._activeIndicators = (cfg._activeIndicators || []).filter(i => i !== indId);
    }
    const custom = loadCustomIndicators().filter(c => c.id !== indId);
    saveCustomIndicators(custom);
    if (!indId.startsWith("custom_")) {
      const deleted = getDeletedIndicators();
      if (!deleted.includes(indId)) {
        deleted.push(indId);
        localStorage.setItem("trading-dashboard-deleted-indicators", JSON.stringify(deleted));
      }
    }
    mergeIndicators();
    this._renderIndicatorButtons(container, chartId, cfg);
  }

  _showIndicatorModal(chartId) {
    const overlay = document.createElement("div");
    overlay.className = "ind-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "ind-modal";
    modal.innerHTML = `
      <h3>Новый индикатор</h3>
      <label>Тип</label>
      <select id="ind-type">
        ${INDICATOR_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join("")}
        <option value="custom">Свой</option>
      </select>
      <div id="ind-params"></div>
      <div id="ind-custom-fields" style="display:none">
        <label>Параметры (JSON)</label>
        <textarea id="ind-params-json" rows="3" placeholder='{"period": 14, "offset": 0}'>{"period": 14}</textarea>
        <label>Формула (на каждый бар)</label>
        <textarea id="ind-formula" rows="5" placeholder="// Доступно: candles, i, c, params&#10;// c = candles[i], верни число&#10;c.close"></textarea>
        <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">
          Примеры:<br>
          SMA: <code>closes.slice(i-p+1, i+1).reduce((s,x)=>s+x,0)/p</code><br>
          EMA: <code>prev = c.close*k + prev*(1-k)</code><br>
          RSI: <code>100 - 100/(1 + gains/losses)</code><br>
          <code>closes</code>, <code>highs</code>, <code>lows</code>, <code>volumes</code> — массивы значений
        </div>
      </div>
      <label>Имя</label>
      <input id="ind-name" placeholder="Мое_индикатора_14">
      <div class="ind-modal-btns">
        <button class="ind-cancel">Отмена</button>
        <button class="ind-save">Сохранить</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const typeSelect = modal.querySelector("#ind-type");
    const paramsDiv = modal.querySelector("#ind-params");
    const customFields = modal.querySelector("#ind-custom-fields");
    const nameInput = modal.querySelector("#ind-name");

    const renderParams = () => {
      const isCustom = typeSelect.value === "custom";
      customFields.style.display = isCustom ? "" : "none";
      paramsDiv.style.display = isCustom ? "none" : "";
      paramsDiv.innerHTML = "";
      const type = INDICATOR_TYPES.find(t => t.id === typeSelect.value);
      if (!type || isCustom) return;
      type.params.forEach(p => {
        const label = document.createElement("label");
        label.textContent = p.label;
        const input = document.createElement("input");
        input.type = "number";
        input.value = p.default;
        input.dataset.key = p.key;
        paramsDiv.appendChild(label);
        paramsDiv.appendChild(input);
      });
      if (type.extra) {
        type.extra.forEach(ex => {
          const label = document.createElement("label");
          label.textContent = ex.label;
          if (ex.type === "color") {
            const wrap = document.createElement("div");
            wrap.style.display = "flex";
            wrap.style.alignItems = "center";
            wrap.style.gap = "6px";
            const input = document.createElement("input");
            input.type = "color";
            input.value = ex.default;
            input.dataset.extra = ex.key;
            input.style.width = "40px";
            input.style.height = "26px";
            input.style.border = "none";
            input.style.background = "none";
            input.style.cursor = "pointer";
            const span = document.createElement("span");
            span.textContent = ex.default;
            span.style.fontSize = "11px";
            span.style.color = "var(--text-secondary)";
            input.addEventListener("input", () => { span.textContent = input.value; });
            wrap.appendChild(label);
            wrap.appendChild(input);
            wrap.appendChild(span);
            paramsDiv.appendChild(wrap);
          } else if (ex.type === "select") {
            paramsDiv.appendChild(label);
            const select = document.createElement("select");
            select.dataset.extra = ex.key;
            ex.options.forEach(o => {
              const opt = document.createElement("option");
              opt.value = o.value;
              opt.textContent = o.label;
              select.appendChild(opt);
            });
            paramsDiv.appendChild(select);
          } else {
            paramsDiv.appendChild(label);
            const input = document.createElement("input");
            input.type = "number";
            input.value = ex.default;
            input.dataset.extra = ex.key;
            paramsDiv.appendChild(input);
          }
        });
      }
      nameInput.placeholder = type.label + "_" + (type.params[0]?.default || "");
    };
    typeSelect.addEventListener("change", renderParams);
    renderParams();

    modal.querySelector(".ind-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector(".ind-save").addEventListener("click", () => {
      const type = typeSelect.value;
      const isCustom = type === "custom";

      if (isCustom) {
        const name = nameInput.value.trim();
        if (!name) { alert("Введите имя индикатора"); return; }
        const paramsJson = modal.querySelector("#ind-params-json").value.trim();
        const formula = modal.querySelector("#ind-formula").value.trim();
        if (!formula) { alert("Введите формулу"); return; }

        let params = {};
        try { params = JSON.parse(paramsJson); } catch(e) { alert("Неверный JSON параметров: " + e.message); return; }

        const id = "custom_" + name.toLowerCase().replace(/[^a-z0-9]/g, "_");

        try {
          const testFn = new Function("candles", "i", "c", "params", "closes", "highs", "lows", "volumes", "prev", "emaCalc", "return (" + formula + ")");
          const testCandles = [{ time: 0, open: 1, high: 2, low: 0, close: 1, volume: 1 }];
          testFn(testCandles, 0, testCandles[0], params, [1], [2], [0], [1], { value: 1 }, null);
        } catch(e) {
          alert("Ошибка в формуле: " + e.message);
          return;
        }

        const custom = loadCustomIndicators();
        custom.push({ id, label: name, type: "custom", params, formula });
        saveCustomIndicators(custom);
        mergeIndicators();

        const chartObj = this.charts.get(chartId);
        if (chartObj) {
          const container = chartObj.container.querySelector(".ch-ind-buttons");
          if (container) this._renderIndicatorButtons(container, chartId, chartObj.config);
        }
        overlay.remove();
      } else {
        const typeName = INDICATOR_TYPES.find(t => t.id === type)?.label || type;
        const name = nameInput.value.trim() || typeName + "_" + (modal.querySelector("#ind-params input")?.value || "20");
        const id = "custom_" + name.toLowerCase().replace(/[^a-z0-9]/g, "_");
        const params = {};
        paramsDiv.querySelectorAll("input[data-key]").forEach(inp => { params[inp.dataset.key] = Number(inp.value) || 0; });
        const extra = {};
        paramsDiv.querySelectorAll("select[data-extra]").forEach(sel => { extra[sel.dataset.extra] = sel.value; });
        paramsDiv.querySelectorAll("input[data-extra]").forEach(inp => {
          extra[inp.dataset.extra] = inp.type === "color" ? inp.value : (Number(inp.value) || 0);
        });

        const custom = loadCustomIndicators();
        custom.push({ id, label: name, type, params, extra });
        saveCustomIndicators(custom);
        mergeIndicators();

        const chartObj = this.charts.get(chartId);
        if (chartObj) {
          const container = chartObj.container.querySelector(".ch-ind-buttons");
          if (container) this._renderIndicatorButtons(container, chartId, chartObj.config);
        }
        overlay.remove();
      }
    });
  }

  _calcIndicator(indId, candles) {
    const custom = loadCustomIndicators().find(c => c.id === indId);
    const params = custom ? custom.params : {};
    const period = params.period || 20;

    const emaCalc = (data, p) => {
      const k = 2 / (p + 1);
      let prev = data[0].value;
      return data.map(d => { prev = d.value * k + prev * (1 - k); return { time: d.time, value: prev }; });
    };

    if (custom && custom.type === "custom" && custom.formula) {
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const volumes = candles.map(c => c.volume);
      let prev = { value: closes[0] || 0 };
      try {
        const fn = new Function("candles", "i", "c", "params", "closes", "highs", "lows", "volumes", "prev", "emaCalc", "return (" + custom.formula + ")");
        return candles.map((c, i) => ({ time: c.time, value: fn(candles, i, c, params, closes, highs, lows, volumes, prev, emaCalc) || 0 }));
      } catch(e) {
        log(`Formula error for ${indId}:`, e.message);
        return candles.map(c => ({ time: c.time, value: 0 }));
      }
    }

    if (indId === "sma" || (custom && custom.type === "sma")) {
      return candles.map((c, i) => {
        if (i < period - 1) return { time: c.time, value: c.close };
        const slice = candles.slice(i - period + 1, i + 1);
        return { time: c.time, value: slice.reduce((s, x) => s + x.close, 0) / period };
      });
    }
    if (indId === "ema" || (custom && custom.type === "ema")) {
      const closes = candles.map(c => ({ time: c.time, value: c.close }));
      return emaCalc(closes, period);
    }
    if (indId === "rsi" || (custom && custom.type === "rsi")) {
      const p = period;
      const result = [];
      for (let i = 0; i < candles.length; i++) {
        if (i < p) { result.push({ time: candles[i].time, value: 50 }); continue; }
        let gains = 0, losses = 0;
        for (let j = i - p + 1; j <= i; j++) {
          const diff = candles[j].close - candles[j].open;
          if (diff > 0) gains += diff; else losses -= diff;
        }
        const rs = losses === 0 ? 100 : gains / losses;
        result.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
      }
      return result;
    }
    if (indId === "macd" || (custom && custom.type === "macd")) {
      const fast = params.fast || 12, slow = params.slow || 26;
      const closes = candles.map(c => ({ time: c.time, value: c.close }));
      const ema12 = emaCalc(closes, fast);
      const ema26 = emaCalc(closes, slow);
      return ema12.map((d, i) => ({ time: d.time, value: d.value - ema26[i].value }));
    }
    if (custom && custom.type === "bollinger") {
      const p = params.period || 20, mult = params.stddev || 2;
      const upper = [], lower = [];
      for (let i = 0; i < candles.length; i++) {
        if (i < p - 1) { upper.push({ time: candles[i].time, value: candles[i].close }); lower.push({ time: candles[i].time, value: candles[i].close }); continue; }
        const slice = candles.slice(i - p + 1, i + 1);
        const avg = slice.reduce((s, x) => s + x.close, 0) / p;
        const std = Math.sqrt(slice.reduce((s, x) => s + (x.close - avg) ** 2, 0) / p);
        upper.push({ time: candles[i].time, value: avg + mult * std });
        lower.push({ time: candles[i].time, value: avg - mult * std });
      }
      return upper;
    }
    if (custom && custom.type === "atr") {
      const p = period;
      return candles.map((c, i) => {
        if (i === 0) return { time: c.time, value: c.high - c.low };
        const tr = Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close));
        if (i < p) return { time: c.time, value: tr };
        const slice = candles.slice(i - p + 1, i + 1);
        return { time: c.time, value: slice.reduce((s, x) => s + (x.high - x.low), 0) / p };
      });
    }
    if (custom && custom.type === "wma") {
      const p = period;
      const denom = p * (p + 1) / 2;
      return candles.map((c, i) => {
        if (i < p - 1) return { time: c.time, value: c.close };
        let sum = 0;
        for (let j = 0; j < p; j++) sum += candles[i - p + 1 + j].close * (j + 1);
        return { time: c.time, value: sum / denom };
      });
    }
    if (custom && custom.type === "stoch") {
      const kPeriod = params.k || 14, dPeriod = params.d || 3;
      const kValues = [];
      for (let i = 0; i < candles.length; i++) {
        if (i < kPeriod - 1) { kValues.push(50); continue; }
        const slice = candles.slice(i - kPeriod + 1, i + 1);
        const high = Math.max(...slice.map(c => c.high));
        const low = Math.min(...slice.map(c => c.low));
        kValues.push(high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100);
      }
      return kValues.map((v, i) => ({ time: candles[i].time, value: v }));
    }
    if (indId === "poc" || (custom && custom.type === "poc")) {
      const p = period;
      const numBins = params.bins || 30;
      const extendMode = (custom && custom.extra && custom.extra.extendMode) || "day";

      const calcPocForSlice = (slice) => {
        if (slice.length < 2) return null;
        const minP = Math.min(...slice.map(x => x.low));
        const maxP = Math.max(...slice.map(x => x.high));
        if (maxP === minP) return null;
        const binSize = (maxP - minP) / numBins;
        const volAtPrice = new Array(numBins).fill(0);
        for (const candle of slice) {
          const avgPrice = (candle.high + candle.low + candle.close) / 3;
          let bin = Math.floor((avgPrice - minP) / binSize);
          if (bin >= numBins) bin = numBins - 1;
          if (bin < 0) bin = 0;
          volAtPrice[bin] += candle.volume;
        }
        let maxVol = 0, pocBin = 0;
        for (let b = 0; b < numBins; b++) {
          if (volAtPrice[b] > maxVol) { maxVol = volAtPrice[b]; pocBin = b; }
        }
        return minP + (pocBin + 0.5) * binSize;
      };

      if (p === 0) {
        const dayStart = {};
        candles.forEach((c, i) => {
          const d = new Date(c.time * 1000).toISOString().slice(0, 10);
          if (!(d in dayStart)) dayStart[d] = i;
        });
        const result = [];
        const days = Object.keys(dayStart).sort();
        for (let di = 0; di < days.length; di++) {
          const startIdx = dayStart[days[di]];
          const endIdx = di < days.length - 1 ? dayStart[days[di + 1]] : candles.length;
          const daySlice = candles.slice(startIdx, endIdx);
          const poc = calcPocForSlice(daySlice);
          for (let i = startIdx; i < endIdx; i++) {
            result.push({ time: candles[i].time, value: poc !== null ? poc : candles[i].close });
          }
        }
        if (extendMode === "cross") {
          let lastPoc = result[0].value;
          return result.map((r, i) => {
            if (candles[i].close < lastPoc && candles[i].low <= lastPoc) lastPoc = r.value;
            else if (candles[i].close > lastPoc && candles[i].high >= lastPoc) lastPoc = r.value;
            return { time: r.time, value: lastPoc };
          });
        }
        return result;
      }

      const rawPoc = candles.map((c, i) => {
        const start = Math.max(0, i - p + 1);
        const slice = candles.slice(start, i + 1);
        const poc = calcPocForSlice(slice);
        return poc !== null ? poc : c.close;
      });
      if (extendMode === "cross") {
        let lastPoc = rawPoc[0];
        return candles.map((c, i) => {
          if (c.close < lastPoc && c.low <= lastPoc) {
            lastPoc = rawPoc[i];
          } else if (c.close > lastPoc && c.high >= lastPoc) {
            lastPoc = rawPoc[i];
          }
          return { time: c.time, value: lastPoc };
        });
      }
      return rawPoc.map((v, i) => ({ time: candles[i].time, value: v }));
    }
    return null;
  }

  _reloadChart(id) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    const cfg = chartObj.config;
    this.onChartChange(id, cfg.symbol, cfg.timeframe, cfg.source, cfg.chartType);
  }

  setActiveChart(id) {
    this.activeChartId = id;
    for (const [cid, obj] of this.charts) {
      obj.container.classList.toggle("active", cid === id);
    }
  }

  createChart(id, config = {}) {
    if (this.charts.has(id)) {
      log(`Chart ${id} already exists`);
      return this.charts.get(id);
    }

    const chartType = config.chartType || "candlestick";

    const wrapper = document.createElement("div");
    wrapper.className = "chart-wrapper";
    wrapper.id = `chart-${id}`;

    const body = document.createElement("div");
    body.className = "chart-body";

    wrapper.appendChild(body);
    this.container.appendChild(wrapper);

    wrapper.addEventListener("click", () => {
      this.setActiveChart(id);
    });

    const chartObj = {
      chart: null,
      mainSeries: null,
      volumeSeries: null,
      chartType,
      config: { ...config },
      indicators: {},
      container: wrapper,
      body: body,
      _resizeTimer: null,
      _horizontalLines: [],
      crosshairPrice: null
    };
    this.charts.set(id, chartObj);

    const header = this._buildHeader(id);
    wrapper.insertBefore(header, body);

    const rect = body.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : 600;
    const h = rect.height > 0 ? rect.height : 400;

    const chart = LightweightCharts.createChart(body, {
      width: w,
      height: h,
      layout: {
        background: { type: "solid", color: "#131722" },
        textColor: "#d1d4dc"
      },
      grid: {
        vertLines: { color: "#242832" },
        horzLines: { color: "#242832" }
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: {
        scaleMargins: { top: 0.1, bottom: 0.25 }
      }
    });

    const mainSeries = this._createSeries(chart, chartType);

    chart.subscribeCrosshairMove((param) => {
      if (param && param.time) {
        chartObj.crosshairTime = param.time;
        const data = param.seriesData.get(chartObj.mainSeries);
        if (data) chartObj.crosshairPrice = data.close || data.value || null;
      }
    });

    body.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (this._activeTool !== "horizontal") return;
      const rect = body.getBoundingClientRect();
      const y = e.clientY - rect.top;
      let price = chartObj.mainSeries.coordinateToPrice(y);
      if (price == null || isNaN(price)) return;
      if (this._magnetOn && chartObj.crosshairTime != null) {
        const candles = chartObj.config._lastCandles;
        if (candles) {
          const candle = candles.find(c => c.time === chartObj.crosshairTime);
          if (candle) {
            const distHigh = Math.abs(price - candle.high);
            const distLow = Math.abs(price - candle.low);
            price = distHigh <= distLow ? candle.high : candle.low;
          }
        }
      }
      this.addHorizontalLine(id, price);
      this._activeTool = "crosshair";
      document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
      document.querySelector('.tool-btn[data-tool="crosshair"]')?.classList.add("active");
    }, true);

    body.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (this._activeTool !== "eraser") return;
      if (chartObj._horizontalLines.length === 0) return;
      const rect = body.getBoundingClientRect();
      const y = e.clientY - rect.top;
      let closest = null;
      let minDist = Infinity;
      for (const line of chartObj._horizontalLines) {
        const lineY = chartObj.mainSeries.priceToCoordinate(line.options().price);
        if (lineY == null) continue;
        const dist = Math.abs(y - lineY);
        if (dist < minDist) { minDist = dist; closest = line; }
      }
      if (closest && minDist < 20) {
        const removedPrice = closest.options().price;
        chartObj.mainSeries.removePriceLine(closest);
        chartObj._horizontalLines = chartObj._horizontalLines.filter(l => l !== closest);
        this.removeAlert(id, removedPrice);
      }
    }, true);

    body.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const rect = body.getBoundingClientRect();
      const y = e.clientY - rect.top;
      let closest = null;
      let minDist = Infinity;
      for (const line of chartObj._horizontalLines) {
        const lineY = chartObj.mainSeries.priceToCoordinate(line.options().price);
        if (lineY == null) continue;
        const dist = Math.abs(y - lineY);
        if (dist < minDist) { minDist = dist; closest = line; }
      }
      if (closest && minDist < 20) {
        this._showContextMenu(e, id, closest.options().price);
      }
    });

    const volumeSeries = chart.addHistogramSeries({
      color: "#26a69a",
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      scaleMargins: { top: 0.8, bottom: 0 }
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 }
    });

    chartObj.chart = chart;
    chartObj.mainSeries = mainSeries;
    chartObj.volumeSeries = volumeSeries;

    const savedSettings = this._getChartSettings(id);
    if (Object.keys(savedSettings).length > 0) {
      this._applyChartSettings(chartObj, savedSettings);
    }

    const gearBtn = document.createElement("button");
    gearBtn.className = "chart-settings-btn";
    gearBtn.textContent = "⚙";
    gearBtn.title = "Настройки графика";
    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._showChartSettings(id);
    });
    body.appendChild(gearBtn);

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries[0]) {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) {
          if (chartObj._resizeTimer) clearTimeout(chartObj._resizeTimer);
          chartObj._resizeTimer = setTimeout(() => {
            chart.applyOptions({ width, height });
          }, 10);
        }
      }
    });
    resizeObserver.observe(body);
    chartObj._resizeObserver = resizeObserver;

    requestAnimationFrame(() => {
      const r = body.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        chart.applyOptions({ width: r.width, height: r.height });
      }
      chart.timeScale().fitContent();
      chart.timeScale().scrollToPosition(5, false);
      setTimeout(() => {
        const r2 = body.getBoundingClientRect();
        if (r2.width > 0 && r2.height > 0) {
          chart.applyOptions({ width: r2.width, height: r2.height });
        }
      }, 200);
    });

    log(`Chart created: ${id} (${chartType}) ${w}x${h}`);
    if (!this.activeChartId) this.setActiveChart(id);
    return chartObj;
  }

  _createSeries(chart, type) {
    switch (type) {
      case "candlestick":
        return chart.addCandlestickSeries({
          upColor: "#26a69a",
          downColor: "#ef5350",
          borderVisible: false,
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350"
        });
      case "line":
        return chart.addLineSeries({
          color: "#2962FF",
          lineWidth: 2,
          priceLineVisible: true,
          lastValueVisible: true
        });
      case "area":
        return chart.addAreaSeries({
          topColor: "rgba(41, 98, 255, 0.4)",
          bottomColor: "rgba(41, 98, 255, 0.0)",
          lineColor: "#2962FF",
          lineWidth: 2
        });
      case "bar":
        return chart.addBarSeries({
          upColor: "#26a69a",
          downColor: "#ef5350",
          borderVisible: false
        });
      default:
        return chart.addCandlestickSeries({
          upColor: "#26a69a",
          downColor: "#ef5350",
          borderVisible: false,
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350"
        });
    }
  }

  _formatDataForType(candles, type) {
    if (type === "candlestick" || type === "bar") {
      return candles;
    }
    return candles.map(c => ({ time: c.time, value: c.close }));
  }

  _formatVolumeData(candles) {
    return candles.map(c => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)"
    }));
  }

  updateData(id, candles, indicators = {}) {
    const chartObj = this.charts.get(id);
    if (!chartObj) {
      log(`Chart ${id} not found`);
      return;
    }

    const formattedData = this._formatDataForType(candles, chartObj.chartType);
    const volumeData = this._formatVolumeData(candles);

    chartObj.mainSeries.setData(formattedData);
    chartObj.volumeSeries.setData(volumeData);

    for (const [indName, values] of Object.entries(indicators)) {
      if (!chartObj.indicators[indName]) {
        const color = this.indicatorColors[indName] || "#787B86";
        const lineSeries = chartObj.chart.addLineSeries({
          color,
          lineWidth: 2,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 }
        });
        chartObj.indicators[indName] = lineSeries;
      }
      chartObj.indicators[indName].setData(values);
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chartObj.chart.timeScale().fitContent();
        chartObj.chart.timeScale().scrollToPosition(5, false);
      });
    });
  }

  updateCandle(id, candle) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;

    try {
      if (chartObj.chartType === "candlestick" || chartObj.chartType === "bar") {
        const data = chartObj.mainSeries.data();
        const last = data.length > 0 ? data[data.length - 1] : null;

        if (last && candle.time === last.time) {
          chartObj.mainSeries.update(candle);
        } else {
          chartObj.mainSeries.update({
            time: candle.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close
          });
        }
      } else {
        chartObj.mainSeries.update({ time: candle.time, value: candle.close });
      }

      chartObj.volumeSeries.update({
        time: candle.time,
        value: candle.volume,
        color: candle.close >= candle.open ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)"
      });
    } catch (e) {
      log(`Update candle error for ${chartObj.config.symbol}:`, e.message);
      return;
    }

    this.checkAlerts(candle);
    chartObj.chart.timeScale().scrollToPosition(5, false);
  }

  changeChartType(id, newType) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;

    const savedLines = chartObj._horizontalLines.map(l => l.options().price);
    chartObj._horizontalLines = [];

    chartObj.chart.removeSeries(chartObj.mainSeries);

    const newSeries = this._createSeries(chartObj.chart, newType);
    chartObj.mainSeries = newSeries;
    chartObj.chartType = newType;

    if (chartObj.config._lastCandles) {
      const formattedData = this._formatDataForType(chartObj.config._lastCandles, newType);
      newSeries.setData(formattedData);
      chartObj.chart.timeScale().fitContent();
      chartObj.chart.timeScale().scrollToPosition(5, false);
    }

    savedLines.forEach(price => this.addHorizontalLine(id, price));

    log(`Chart ${id} type changed to ${newType}`);
  }

  removeChart(id) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    if (chartObj._resizeObserver) chartObj._resizeObserver.disconnect();
    if (chartObj._resizeTimer) clearTimeout(chartObj._resizeTimer);
    this.removeAllHorizontalLines(id);
    chartObj.chart.remove();
    if (chartObj.container.parentNode) {
      chartObj.container.parentNode.removeChild(chartObj.container);
    }
    this.charts.delete(id);
    log(`Chart removed: ${id}`);
  }

  addHorizontalLine(chartId, price) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj || !chartObj.mainSeries) return;
    const line = chartObj.mainSeries.createPriceLine({
      price,
      color: "#2196F3",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: ""
    });
    chartObj._horizontalLines.push(line);
    log(`Horizontal line added at ${price}`);
  }

  removeAllHorizontalLines(chartId) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj) return;
    for (const line of chartObj._horizontalLines) {
      chartObj.mainSeries.removePriceLine(line);
    }
    chartObj._horizontalLines = [];
  }

  getAllChartIds() {
    return Array.from(this.charts.keys());
  }

  restoreAlertColors() {
    for (const alert of this.alerts) {
      for (const [id, chartObj] of this.charts) {
        if (chartObj.config.symbol === alert.symbol) {
          this._updateLineColor(id, alert.price, "#FF9800");
        }
      }
    }
  }
}

export { addSymbolToList, removeSymbolFromAll, refreshAllSymbolDropdowns, mergeIndicators, getDeletedTickers };
