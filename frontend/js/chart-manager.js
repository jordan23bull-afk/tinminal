import { log } from "./utils.js";
import { calcIndicator, loadCustomIndicators } from "./indicators.js";
import { ChartUI, addSymbolToList, removeSymbolFromAll, refreshAllSymbolDropdowns, getDeletedTickers } from "./chart-ui.js";

export class ChartManager {
  constructor(containerId, onChartChange) {
    this.container = document.getElementById(containerId);
    this.charts = new Map();
    this.onChartChange = onChartChange || (() => {});
    this.indicatorColors = {
      rsi: "#2962FF", macd: "#FF6D00", macd_signal: "#9C27B0",
      macd_hist: "#787B86", sma: "#e91e63", poc: "#FF5722", poc_day: "#2962FF"
    };
    this.showVolume = true;
    this._activeTool = "crosshair";
    this.activeChartId = null;
    this._magnetOn = false;
    this.alerts = this._loadAlerts();
    this.ui = new ChartUI(this);
    this.sync = { symbol: true, timeframe: true, crosshair: true, time: false, dateRange: false };
    this._syncLock = false;
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  _loadAlerts() {
    try { return JSON.parse(localStorage.getItem("trading-alerts") || "[]"); }
    catch { return []; }
  }

  _saveAlerts() {
    localStorage.setItem("trading-alerts", JSON.stringify(this.alerts));
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
      price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: ""
    });
    chartObj._horizontalLines = chartObj._horizontalLines.map(l => l === line ? newLine : l);
  }

  checkAlerts(candle) {
    for (const alert of this.alerts) {
      if (alert.triggered) continue;
      const chartObj = this.charts.get(alert.chartId);
      if (!chartObj || chartObj.config.symbol !== alert.symbol) continue;
      if (candle.high >= alert.price && candle.low <= alert.price) {
        alert.triggered = true;
        this._sendNotification(alert, candle);
        this._updateLineColor(alert.chartId, alert.price, "#2196F3");
      }
    }
    this.alerts = this.alerts.filter(a => !a.triggered);
    this._saveAlerts();
  }

  _sendNotification(alert, candle) {
    const title = `${alert.symbol} — ${alert.price}`;
    const body = `Цена: ${candle.close}`;
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, requireInteraction: false });
      n.onclick = () => { window.focus(); n.close(); };
    }
    try {
      const audio = new Audio("sounds/alert.wav");
      audio.volume = 0.5;
      audio.play().catch(() => {});
    } catch {}
    log(`Alert: ${title}`);
  }

  _updateChartConfig(id, updates) {
    const chartObj = this.charts.get(id);
    if (chartObj) Object.assign(chartObj.config, updates);
  }

  _getChartSettings(id) {
    const chartObj = this.charts.get(id);
    const symbol = chartObj ? (chartObj.config.symbol || "default") : "default";
    try { return JSON.parse(localStorage.getItem("chart-settings-" + symbol) || "{}"); }
    catch { return {}; }
  }

  _saveChartSettings(id, settings) {
    const chartObj = this.charts.get(id);
    const symbol = chartObj ? (chartObj.config.symbol || "default") : "default";
    localStorage.setItem("chart-settings-" + symbol, JSON.stringify(settings));
  }

  _applyChartSettings(chartObj, s) {
    chartObj.chart.applyOptions({
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
        color, lineWidth, priceFormat: { type: "price", precision: 2, minMove: 0.01 }
      });
      chartObj.indicators[indId] = series;
      chartObj.config._activeIndicators.push(indId);

      if (chartObj.config._lastCandles) {
        const data = calcIndicator(indId, chartObj.config._lastCandles);
        if (data) series.setData(data);
      }
    }
  }

  _reloadChart(id) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    const cfg = chartObj.config;
    this.onChartChange(id, null, cfg.symbol, cfg.timeframe, cfg.source, cfg.chartType);
  }

  setActiveChart(id) {
    this.activeChartId = id;
    for (const [cid, obj] of this.charts) {
      obj.container.classList.toggle("active", cid === id);
    }
  }

  syncCrosshair(sourceId, time) {
    if (this._syncLock || !this.sync.crosshair) return;
    this._syncLock = true;
    for (const [id, chartObj] of this.charts) {
      if (id === sourceId || !chartObj.chart) continue;
      chartObj.chart.setCrosshairPosition(NaN, time, chartObj.mainSeries);
    }
    this._syncLock = false;
  }

  syncTimeRange(sourceId, range) {
    if (this._syncLock || !this.sync.time) return;
    this._syncLock = true;
    for (const [id, chartObj] of this.charts) {
      if (id === sourceId || !chartObj.chart) continue;
      chartObj.chart.timeScale().setVisibleRange(range);
    }
    this._syncLock = false;
  }

  syncSymbolTimeframe(symbol, timeframe, source, excludeId) {
    if (this._syncLock) return;
    this._syncLock = true;
    for (const [id, chartObj] of this.charts) {
      if (id === excludeId) continue;
      if (this.sync.symbol) chartObj.config.symbol = symbol;
      if (this.sync.timeframe) chartObj.config.timeframe = timeframe;
      if (source) chartObj.config.source = source;
      const symBtn = chartObj.container.querySelector(".ch-symbol-btn");
      if (symBtn && this.sync.symbol) symBtn.textContent = symbol;
      if (this.sync.timeframe) {
        chartObj.container.querySelectorAll(".ch-tf-btn").forEach(b => {
          b.classList.toggle("active", b.dataset.tf === timeframe);
        });
      }
      this.onChartChange(id, null, chartObj.config.symbol, chartObj.config.timeframe, chartObj.config.source, chartObj.chartType);
    }
    this._syncLock = false;
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

    wrapper.addEventListener("mouseenter", () => this.setActiveChart(id));

    const chartObj = {
      chart: null, mainSeries: null, volumeSeries: null, chartType,
      config: { ...config }, indicators: {}, container: wrapper, body,
      _resizeTimer: null, _horizontalLines: [], crosshairPrice: null
    };
    this.charts.set(id, chartObj);

    const header = this.ui.buildHeader(id);
    wrapper.insertBefore(header, body);

    const rect = body.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : 600;
    const h = rect.height > 0 ? rect.height : 400;

    const chart = LightweightCharts.createChart(body, {
      width: w, height: h,
      layout: { background: { type: "solid", color: "#131722" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "#242832" }, horzLines: { color: "#242832" } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.25 } }
    });

    chartObj.mainSeries = this._createSeries(chart, chartType);

    chart.subscribeCrosshairMove((param) => {
      if (param && param.time) {
        chartObj.crosshairTime = param.time;
        const data = param.seriesData.get(chartObj.mainSeries);
        if (data) chartObj.crosshairPrice = data.close || data.value || null;
        this.syncCrosshair(id, param.time);
      }
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) this.syncTimeRange(id, chart.timeScale().getVisibleRange());
    });

    chartObj.volumeSeries = chart.addHistogramSeries({
      color: "#26a69a", priceFormat: { type: "volume" },
      priceScaleId: "volume"
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      drawTicks: false
    });

    chartObj.chart = chart;

    const savedSettings = this._getChartSettings(id);
    if (Object.keys(savedSettings).length > 0) {
      this._applyChartSettings(chartObj, savedSettings);
    }

    this.ui.bindChartInteractions(id, body, chartObj);

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries[0]) {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) {
          if (chartObj._resizeTimer) clearTimeout(chartObj._resizeTimer);
          chartObj._resizeTimer = setTimeout(() => chart.applyOptions({ width, height }), 10);
        }
      }
    });
    resizeObserver.observe(body);
    chartObj._resizeObserver = resizeObserver;

    requestAnimationFrame(() => {
      const r = body.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) chart.applyOptions({ width: r.width, height: r.height });
      chart.timeScale().fitContent();
      chart.timeScale().scrollToPosition(5, false);
      setTimeout(() => {
        const r2 = body.getBoundingClientRect();
        if (r2.width > 0 && r2.height > 0) chart.applyOptions({ width: r2.width, height: r2.height });
      }, 200);
    });

    log(`Chart created: ${id} (${chartType}) ${w}x${h}`);
    if (!this.activeChartId) this.setActiveChart(id);
    return chartObj;
  }

  _createSeries(chart, type) {
    switch (type) {
      case "line":
        return chart.addLineSeries({ color: "#2962FF", lineWidth: 2, priceLineVisible: true, lastValueVisible: true });
      case "area":
        return chart.addAreaSeries({ topColor: "rgba(41, 98, 255, 0.4)", bottomColor: "rgba(41, 98, 255, 0.0)", lineColor: "#2962FF", lineWidth: 2 });
      case "bar":
        return chart.addBarSeries({ upColor: "#26a69a", downColor: "#ef5350", borderVisible: false });
      default:
        return chart.addCandlestickSeries({ upColor: "#26a69a", downColor: "#ef5350", borderVisible: false, wickUpColor: "#26a69a", wickDownColor: "#ef5350" });
    }
  }

  _formatDataForType(candles, type) {
    if (type === "candlestick" || type === "bar") return candles;
    return candles.map(c => ({ time: c.time, value: c.close }));
  }

  _formatVolumeData(candles) {
    return candles.map(c => ({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)"
    }));
  }

  updateData(id, candles, indicators = {}) {
    const chartObj = this.charts.get(id);
    if (!chartObj) { log(`Chart ${id} not found`); return; }

    chartObj.mainSeries.setData(this._formatDataForType(candles, chartObj.chartType));
    chartObj.volumeSeries.setData(this._formatVolumeData(candles));

    for (const [indName, values] of Object.entries(indicators)) {
      if (!chartObj.indicators[indName]) {
        const color = this.indicatorColors[indName] || "#787B86";
        chartObj.indicators[indName] = chartObj.chart.addLineSeries({
          color, lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 }
        });
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
          chartObj.mainSeries.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
        }
      } else {
        chartObj.mainSeries.update({ time: candle.time, value: candle.close });
      }
      chartObj.volumeSeries.update({
        time: candle.time, value: candle.volume,
        color: candle.close >= candle.open ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)"
      });
    } catch (e) {
      log(`Update candle error for ${chartObj.config.symbol}:`, e.message);
      return;
    }

    this.checkAlerts(candle);
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
      newSeries.setData(this._formatDataForType(chartObj.config._lastCandles, newType));
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
    if (chartObj.container.parentNode) chartObj.container.parentNode.removeChild(chartObj.container);
    this.charts.delete(id);
    log(`Chart removed: ${id}`);
  }

  addHorizontalLine(chartId, price) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj || !chartObj.mainSeries) return;
    const line = chartObj.mainSeries.createPriceLine({
      price, color: "#2196F3", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: ""
    });
    chartObj._horizontalLines.push(line);
    log(`Horizontal line added at ${price}`);
  }

  removeAllHorizontalLines(chartId) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj) return;
    for (const line of chartObj._horizontalLines) chartObj.mainSeries.removePriceLine(line);
    chartObj._horizontalLines = [];
  }

  getAllChartIds() { return Array.from(this.charts.keys()); }

  restoreAlertColors() {
    for (const alert of this.alerts) {
      for (const [id, chartObj] of this.charts) {
        if (chartObj.config.symbol === alert.symbol) this._updateLineColor(id, alert.price, "#FF9800");
      }
    }
  }
}

export { addSymbolToList, removeSymbolFromAll, refreshAllSymbolDropdowns, getDeletedTickers };
