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

function mergeIndicators() {
  const custom = loadCustomIndicators();
  INDICATORS.length = 0;
  INDICATORS.push(
    { id: "rsi", label: "RSI" },
    { id: "macd", label: "MACD" },
    { id: "sma", label: "SMA" },
  );
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
      sma: "#e91e63"
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

  _toggleIndicator(id, indId) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    if (!chartObj.config._activeIndicators) chartObj.config._activeIndicators = [];

    if (chartObj.indicators[indId]) {
      chartObj.chart.removeSeries(chartObj.indicators[indId]);
      delete chartObj.indicators[indId];
      chartObj.config._activeIndicators = chartObj.config._activeIndicators.filter(i => i !== indId);
    } else {
      const color = this.indicatorColors[indId] || "#787B86";
      const series = chartObj.chart.addLineSeries({
        color,
        lineWidth: 2,
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
      container.insertBefore(btn, container.lastChild);
    });
  }

  _showIndicatorModal(chartId) {
    const overlay = document.createElement("div");
    overlay.className = "ind-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "ind-modal";
    modal.innerHTML = `
      <h3>Новый индикатор</h3>
      <label>Тип</label>
      <select id="ind-type">${INDICATOR_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join("")}</select>
      <div id="ind-params"></div>
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
    const nameInput = modal.querySelector("#ind-name");

    const renderParams = () => {
      const type = INDICATOR_TYPES.find(t => t.id === typeSelect.value);
      paramsDiv.innerHTML = "";
      if (!type) return;
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
      nameInput.placeholder = type.label + "_" + (type.params[0]?.default || "");
    };
    typeSelect.addEventListener("change", renderParams);
    renderParams();

    modal.querySelector(".ind-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector(".ind-save").addEventListener("click", () => {
      const type = typeSelect.value;
      const typeName = INDICATOR_TYPES.find(t => t.id === type)?.label || type;
      const name = nameInput.value.trim() || typeName + "_" + (modal.querySelector("#ind-params input")?.value || "20");
      const id = "custom_" + name.toLowerCase().replace(/[^a-z0-9]/g, "_");
      const params = {};
      paramsDiv.querySelectorAll("input").forEach(inp => { params[inp.dataset.key] = Number(inp.value) || 0; });

      const custom = loadCustomIndicators();
      custom.push({ id, label: name, type, params });
      saveCustomIndicators(custom);
      mergeIndicators();

      const chartObj = this.charts.get(chartId);
      if (chartObj) {
        const container = chartObj.container.querySelector(".ch-ind-buttons");
        if (container) this._renderIndicatorButtons(container, chartId, chartObj.config);
      }
      overlay.remove();
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
        const len = formattedData.length;
        const visibleCount = Math.min(50, len);
        chartObj.chart.timeScale().setVisibleLogicalRange({
          from: len - visibleCount,
          to: len + 5
        });
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
      this._updateLineColor(alert.chartId, alert.price, "#FF9800");
    }
  }
}

export { addSymbolToList, removeSymbolFromAll, refreshAllSymbolDropdowns, mergeIndicators, getDeletedTickers };
