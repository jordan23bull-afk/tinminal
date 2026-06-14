import { log } from "./utils.js";

const SYMBOLS = [
  { ticker: "BTCUSDT", name: "Bitcoin", source: "mock", icon: "₿" },
  { ticker: "ETHUSDT", name: "Ethereum", source: "mock", icon: "Ξ" },
  { ticker: "SOLUSDT", name: "Solana", source: "mock", icon: "◎" },
  { ticker: "BNBUSDT", name: "BNB", source: "mock", icon: "B" },
  { ticker: "XRPUSDT", name: "XRP", source: "mock", icon: "X" },
  { ticker: "SBER", name: "Сбербанк", source: "moex", icon: "С" },
  { ticker: "GAZP", name: "Газпром", source: "moex", icon: "Г" },
  { ticker: "LKOH", name: "Лукойл", source: "moex", icon: "Л" },
  { ticker: "YDEX", name: "Яндекс", source: "moex", icon: "Я" },
  { ticker: "GMKN", name: "Норникель", source: "moex", icon: "Н" },
  { ticker: "ROSN", name: "Роснефть", source: "moex", icon: "Р" },
  { ticker: "VTBR", name: "ВТБ", source: "moex", icon: "В" },
  { ticker: "TCSG", name: "Т-Банк", source: "moex", icon: "Т" },
  { ticker: "PHOR", name: "Фосагро", source: "moex", icon: "Ф" },
];

const TIMEFRAMES = [
  { tf: "1m", label: "1m" },
  { tf: "5m", label: "5m" },
  { tf: "15m", label: "15m" },
  { tf: "1h", label: "1ч" },
  { tf: "2h", label: "2ч" },
  { tf: "3h", label: "3ч" },
  { tf: "4h", label: "4ч" },
  { tf: "1d", label: "Д" },
  { tf: "1w", label: "Н" },
  { tf: "1M", label: "М" },
];

const INDICATORS = [
  { id: "rsi", label: "RSI" },
  { id: "macd", label: "MACD" },
  { id: "sma", label: "SMA" },
];

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
    const existing = this.alerts.find(a => a.chartId === chartId && a.price === price);
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
    log(`Alert added: ${symbol} @ ${price}`);
  }

  removeAlert(chartId, price) {
    this.alerts = this.alerts.filter(a => !(a.chartId === chartId && a.price === price));
    this._saveAlerts();
  }

  _removeLineByPrice(chartId, price) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj) return;
    const line = chartObj._horizontalLines.find(l => Math.abs(l.options().price - price) < 0.001);
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
      btn.className = "ch-tf-btn" + (t.tf === (cfg.timeframe || "4h") ? " active" : "");
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

    const indBtn = document.createElement("button");
    indBtn.className = "ch-ind-btn";
    indBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 12h2V7H2v5zm4 0h2V4H6v8zm4 0h2V2h-2v10zm4 0h2V6h-2v6z"/></svg>`;

    const indDropdown = document.createElement("div");
    indDropdown.className = "ch-ind-dropdown hidden";
    INDICATORS.forEach(ind => {
      const btn = document.createElement("button");
      btn.className = "ch-ind-item";
      btn.dataset.indicator = ind.id;
      btn.textContent = ind.label;
      btn.addEventListener("click", () => {
        this._toggleIndicator(id, ind.id);
        btn.classList.toggle("active");
      });
      indDropdown.appendChild(btn);
    });

    indBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".ch-ind-dropdown").forEach(d => {
        if (d !== indDropdown) d.classList.add("hidden");
      });
      indDropdown.classList.toggle("hidden");
    });

    header.appendChild(symbolBtn);
    header.appendChild(symbolDropdown);
    header.appendChild(tfContainer);
    header.appendChild(typeSelect);
    header.appendChild(indBtn);
    header.appendChild(indDropdown);

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

    if (chartObj.indicators[indId]) {
      chartObj.chart.removeSeries(chartObj.indicators[indId]);
      delete chartObj.indicators[indId];
    } else {
      const color = this.indicatorColors[indId] || "#787B86";
      const series = chartObj.chart.addLineSeries({
        color,
        lineWidth: 2,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 }
      });
      chartObj.indicators[indId] = series;

      if (chartObj.config._lastCandles) {
        const data = this._calcIndicator(indId, chartObj.config._lastCandles);
        if (data) series.setData(data);
      }
    }
  }

  _calcIndicator(indId, candles) {
    if (indId === "sma") {
      const period = 20;
      return candles.map((c, i) => {
        if (i < period - 1) return { time: c.time, value: c.close };
        const slice = candles.slice(i - period + 1, i + 1);
        const avg = slice.reduce((s, x) => s + x.close, 0) / period;
        return { time: c.time, value: avg };
      });
    }
    if (indId === "rsi") {
      const period = 14;
      const result = [];
      for (let i = 0; i < candles.length; i++) {
        if (i < period) {
          result.push({ time: candles[i].time, value: 50 });
          continue;
        }
        let gains = 0, losses = 0;
        for (let j = i - period + 1; j <= i; j++) {
          const diff = candles[j].close - candles[j].open;
          if (diff > 0) gains += diff; else losses -= diff;
        }
        const rs = losses === 0 ? 100 : gains / losses;
        result.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
      }
      return result;
    }
    if (indId === "macd") {
      const ema = (data, period) => {
        const k = 2 / (period + 1);
        let prev = data[0].value;
        return data.map(d => { prev = d.value * k + prev * (1 - k); return { time: d.time, value: prev }; });
      };
      const closes = candles.map(c => ({ time: c.time, value: c.close }));
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      return ema12.map((d, i) => ({ time: d.time, value: d.value - ema26[i].value }));
    }
    return null;
  }

  _reloadChart(id) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    const cfg = chartObj.config;
    this.onChartChange(id, cfg.symbol, cfg.timeframe, cfg.source, cfg.chartType);
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
        const data = param.seriesData.get(mainSeries);
        if (data) chartObj.crosshairPrice = data.close || data.value || null;
      }
    });

    body.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (this._activeTool !== "horizontal") return;
      const rect = body.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const price = mainSeries.coordinateToPrice(y);
      if (price == null || isNaN(price)) return;
      this.addHorizontalLine(id, price);
      this._activeTool = "crosshair";
      document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
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
        const lineY = mainSeries.priceToCoordinate(line.options().price);
        if (lineY == null) continue;
        const dist = Math.abs(y - lineY);
        if (dist < minDist) { minDist = dist; closest = line; }
      }
      if (closest && minDist < 20) {
        mainSeries.removePriceLine(closest);
        chartObj._horizontalLines = chartObj._horizontalLines.filter(l => l !== closest);
      }
      this._activeTool = "crosshair";
      document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
      document.querySelector('.tool-btn[data-tool="crosshair"]')?.classList.add("active");
    }, true);

    body.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const rect = body.getBoundingClientRect();
      const y = e.clientY - rect.top;
      let closest = null;
      let minDist = Infinity;
      for (const line of chartObj._horizontalLines) {
        const lineY = mainSeries.priceToCoordinate(line.options().price);
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
      setTimeout(() => {
        const r2 = body.getBoundingClientRect();
        if (r2.width > 0 && r2.height > 0) {
          chart.applyOptions({ width: r2.width, height: r2.height });
        }
      }, 200);
    });

    log(`Chart created: ${id} (${chartType}) ${w}x${h}`);
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

    if (formattedData.length <= 50) {
      chartObj.mainSeries.setData(formattedData);
      chartObj.volumeSeries.setData(volumeData);
    } else {
      const tail = 50;
      chartObj.mainSeries.setData(formattedData.slice(-tail));
      chartObj.volumeSeries.setData(volumeData.slice(-tail));

      const batchSize = 80;
      let idx = formattedData.length - tail;

      const renderBatch = () => {
        if (idx <= 0) {
          chartObj.mainSeries.setData(formattedData);
          chartObj.volumeSeries.setData(volumeData);
          chartObj.chart.timeScale().fitContent();
          return;
        }
        const start = Math.max(0, idx - batchSize);
        const chunkMain = formattedData.slice(start, idx + tail);
        const chunkVol = volumeData.slice(start, idx + tail);
        chartObj.mainSeries.setData(chunkMain);
        chartObj.volumeSeries.setData(chunkVol);
        idx = start;
        requestAnimationFrame(renderBatch);
      };
      requestAnimationFrame(renderBatch);
    }

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

    chartObj.chart.timeScale().fitContent();
  }

  updateCandle(id, candle) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;

    if (chartObj.chartType === "candlestick" || chartObj.chartType === "bar") {
      chartObj.mainSeries.update(candle);
    } else {
      chartObj.mainSeries.update({ time: candle.time, value: candle.close });
    }

    chartObj.volumeSeries.update({
      time: candle.time,
      value: candle.volume,
      color: candle.close >= candle.open ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)"
    });

    this.checkAlerts(candle);
  }

  changeChartType(id, newType) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;

    chartObj.chart.removeSeries(chartObj.mainSeries);

    const newSeries = this._createSeries(chartObj.chart, newType);
    chartObj.mainSeries = newSeries;
    chartObj.chartType = newType;

    if (chartObj.config._lastCandles) {
      const formattedData = this._formatDataForType(chartObj.config._lastCandles, newType);
      newSeries.setData(formattedData);
      chartObj.chart.timeScale().fitContent();
    }

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
}
