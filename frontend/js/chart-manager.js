import { log } from "./utils.js";
import { calcIndicator, loadCustomIndicators } from "./indicators.js";
import { ChartUI } from "./chart-ui.js";

const TF_SECONDS = {
  "1m": 60, "5m": 300, "10m": 600, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
};

function floorTs(ts, tfSeconds) {
  return ts - (ts % tfSeconds);
}

function mskFullTime(time) {
  if (typeof time === "object" && time.year !== undefined) {
    return `${time.year}-${String(time.month).padStart(2,"0")}-${String(time.day).padStart(2,"0")}`;
  }
  const d = new Date(time * 1000);
  return d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

const HEAVY_INDICATOR_TYPES = new Set(["poc", "din_poc"]);

export class ChartManager {
  constructor(containerId, onChartChange) {
    this.container = document.getElementById(containerId);
    this.charts = new Map();
    this.onChartChange = onChartChange || (() => {});
    this.indicatorColors = {
      rsi: "#2962FF", macd: "#FF6D00", macd_signal: "#9C27B0",
      macd_hist: "#787B86", sma: "#e91e63", poc: "#FF5722"
    };
    this._activeTool = "crosshair";
    this.activeChartId = null;
    this._magnetOn = false;
    this.alerts = this._loadAlerts();
    this.autoLevels = this._loadAutoLevels();
    this.ui = new ChartUI(this);
    this.sync = { symbol: true, timeframe: true, crosshair: true, time: false, dateRange: false };
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  _loadAlerts() {
    try {
      const alerts = JSON.parse(localStorage.getItem("trading-alerts") || "[]");
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const fresh = alerts.filter(a => a.id > weekAgo);
      if (fresh.length !== alerts.length) {
        localStorage.setItem("trading-alerts", JSON.stringify(fresh));
      }
      return fresh;
    }
    catch { return []; }
  }

  _saveAlerts() {
    localStorage.setItem("trading-alerts", JSON.stringify(this.alerts));
  }

  _loadAutoLevels() {
    try { return JSON.parse(localStorage.getItem("trading-auto-levels") || "{}"); }
    catch { return {}; }
  }

  _saveAutoLevels() {
    try { localStorage.setItem("trading-auto-levels", JSON.stringify(this.autoLevels)); }
    catch {}
  }

  setAutoLevels(symbol, dayHigh, dayLow, eveHigh, eveLow) {
    const prev = this.autoLevels[symbol];
    this.autoLevels[symbol] = { dayHigh, dayLow, eveHigh, eveLow, ts: Date.now() };
    this._saveAutoLevels();
    if (prev) {
      for (const [id, chartObj] of this.charts) {
        if (chartObj.config.symbol !== symbol || !chartObj.mainSeries) continue;
        const oldPrices = [prev.dayHigh, prev.dayLow, prev.eveHigh, prev.eveLow]
          .filter(p => p != null);
        chartObj._horizontalLines = chartObj._horizontalLines.filter(l => {
          const p = l.options().price;
          if (p == null) return true;
          if (oldPrices.some(op => Math.abs(p - op) < 0.5)) {
            chartObj.mainSeries.removePriceLine(l);
            return false;
          }
          return true;
        });
      }
    }
    this.alerts = this.alerts.filter(a => !(a.symbol === symbol && a.auto));
    this._saveAlerts();
    this.applyAutoLevelsForSymbol(symbol);
    this._addSymbolAlert(symbol, dayHigh, "#e53935");
    this._addSymbolAlert(symbol, dayLow, "#e53935");
    if (eveHigh != null) this._addSymbolAlert(symbol, eveHigh, "#FFEB3B");
    if (eveLow != null) this._addSymbolAlert(symbol, eveLow, "#FFEB3B");
    log(`Auto levels set for ${symbol}`);
  }

  applyAutoLevelsForSymbol(symbol) {
    const lv = this.autoLevels[symbol];
    if (!lv) return;
    const LEVELS = [
      { p: lv.dayLow, c: "#e53935", w: 2 },
      { p: lv.dayHigh, c: "#e53935", w: 2 },
      { p: lv.eveLow, c: "#FFEB3B", w: 1 },
      { p: lv.eveHigh, c: "#FFEB3B", w: 1 },
    ];
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol || !chartObj.mainSeries) continue;
      for (const l of LEVELS) {
        if (l.p != null) this.addHorizontalLine(id, l.p, { color: l.c, lineWidth: l.w, lineStyle: 2 });
      }
    }
  }

  _addSymbolAlert(symbol, price, color) {
    if (price == null) return;
    const exists = this.alerts.some(a => a.symbol === symbol && Math.abs(a.price - price) < 0.5);
    if (exists) return;
    let chartId = null;
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol === symbol) { chartId = id; break; }
    }
    this.alerts.push({ chartId, symbol, price, id: Date.now(), lineColor: color, auto: true });
    this._saveAlerts();
    if (chartId) this._updateLineColor(chartId, price, "#FF9800");
  }

  addAlert(chartId, price) {
    const sourceObj = this.charts.get(chartId);
    const symbol = sourceObj ? sourceObj.config.symbol : "???";
    let lineColor = "#2196F3";
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol) continue;
      const line = this._findLineByPrice(chartObj, price);
      if (line) lineColor = line._opts?.color || "#2196F3";
    }
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol) continue;
      const exists = this.alerts.some(a => a.chartId === id && Math.abs(a.price - price) < 0.5);
      if (!exists) {
        this.alerts.push({ chartId: id, symbol, price, id: Date.now(), lineColor });
      }
    }
    for (const a of this.alerts) {
      if (a.symbol === symbol && !this.charts.has(a.chartId)) {
        const match = [...this.charts.entries()].find(([, c]) => c.config.symbol === symbol);
        if (match) a.chartId = match[0];
      }
    }
    this._saveAlerts();
    this._updateLineColor(chartId, price, "#FF9800");
    log(`Alert added: ${symbol} @ ${price}`);
  }

  removeAlert(chartId, price) {
    const sourceObj = this.charts.get(chartId);
    const symbol = sourceObj ? sourceObj.config.symbol : null;
    let origColor = "#2196F3";
    const matched = this.alerts.find(a => Math.abs(a.price - price) < 0.5 && (symbol ? a.symbol === symbol : a.chartId === chartId));
    if (matched && matched.lineColor) origColor = matched.lineColor;
    this.alerts = this.alerts.filter(a => {
      if (Math.abs(a.price - price) >= 0.5) return true;
      if (symbol && a.symbol === symbol) return false;
      if (a.chartId === chartId) return false;
      return true;
    });
    this._saveAlerts();
    this._updateLineColor(chartId, price, origColor);
  }

  _updateLineColor(chartId, price, color, lineWidth, lineStyle) {
    const sourceObj = this.charts.get(chartId);
    if (!sourceObj) return;
    const symbol = sourceObj.config.symbol;
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol || !chartObj.mainSeries) continue;
      const line = this._findLineByPrice(chartObj, price);
      if (!line) continue;
      const old = line._opts || {};
      const newLineWidth = lineWidth != null ? lineWidth : (old.lineWidth || 1);
      const newLineStyle = lineStyle != null ? lineStyle : (old.lineStyle ?? 2);
      chartObj.mainSeries.removePriceLine(line);
      const newLine = chartObj.mainSeries.createPriceLine({
        price, color, lineWidth: newLineWidth, lineStyle: newLineStyle, axisLabelVisible: true, title: ""
      });
      newLine._opts = { color, lineWidth: newLineWidth, lineStyle: newLineStyle };
      chartObj._horizontalLines = chartObj._horizontalLines.map(l => l === line ? newLine : l);
    }
  }

  _findLineByPrice(chartObj, price) {
    return chartObj._horizontalLines.find(l => {
      const p = l.options().price;
      return p != null && Math.abs(p - price) < 0.5;
    }) || null;
  }

  checkAlerts(candle, opts = {}) {
    const notified = new Set();
    for (const alert of this.alerts) {
      if (alert.triggered) continue;
      if (candle.high >= alert.price && candle.low <= alert.price) {
        alert.triggered = true;
        const key = `${alert.symbol}_${alert.price}`;
        if (!notified.has(key)) {
          this._sendNotification(alert, candle);
          notified.add(key);
        }
        const firedColor = alert.auto ? (alert.lineColor || "#e53935") : "#9e9e9e";
        for (const [id, chartObj] of this.charts) {
          if (chartObj.config.symbol === alert.symbol) {
            this._updateLineColor(id, alert.price, firedColor);
          }
        }
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
      n.onclick = () => {
        n.close();
        window.open(this._alertUrl(alert), "_blank");
      };
    }
    try {
      const audio = new Audio("sounds/alert.wav");
      audio.volume = 0.5;
      audio.play().catch(() => {});
    } catch {}
    log(`Alert: ${title}`);
  }

  _alertUrl(alert) {
    let timeframe = "";
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol === alert.symbol) {
        timeframe = chartObj.config.timeframe || "";
        break;
      }
    }
    const params = new URLSearchParams({ symbol: alert.symbol });
    if (timeframe) params.set("timeframe", timeframe);
    return `${location.origin}${location.pathname}?${params.toString()}`;
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
        color, lineWidth, priceFormat: { type: "price", precision: 2, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: true
      });
      chartObj.indicators[indId] = series;
      chartObj.config._activeIndicators.push(indId);

      if (chartObj.config._lastCandles) {
        const data = calcIndicator(indId, chartObj.config._lastCandles);
        if (data) series.setData(data);
      }
    }
  }

  setActiveChart(id) {
    this.activeChartId = id;
    for (const [cid, obj] of this.charts) {
      obj.container.classList.toggle("active", cid === id);
    }
  }

  changeSymbol(symbol, source, sourceId) {
    source = source || "tinkoff";
    for (const [id, chartObj] of this.charts) {
      const update = id === sourceId || this.sync.symbol;
      if (!update) continue;
      chartObj.config.symbol = symbol;
      chartObj.config.source = source;
      const btn = chartObj.container.querySelector(".ch-symbol-btn");
      if (btn) btn.textContent = symbol;
      this.onChartChange(id, null, symbol, chartObj.config.timeframe, source, chartObj.chartType);
    }
  }

  changeTimeframe(timeframe, sourceId) {
    for (const [id, chartObj] of this.charts) {
      const update = id === sourceId || this.sync.timeframe;
      if (!update) continue;
      chartObj.config.timeframe = timeframe;
      chartObj.container.querySelectorAll(".ch-tf-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.tf === timeframe);
      });
      this.onChartChange(id, null, chartObj.config.symbol, timeframe, chartObj.config.source, chartObj.chartType);
    }
  }

  syncCrosshair(sourceId, time) {
    if (!this.sync.crosshair) return;
    for (const [id, chartObj] of this.charts) {
      if (id === sourceId || !chartObj.chart) continue;
      chartObj.chart.setCrosshairPosition(NaN, time, chartObj.mainSeries);
    }
  }

  syncTimeRange(sourceId, range) {
    if (!this.sync.time) return;
    for (const [id, chartObj] of this.charts) {
      if (id === sourceId || !chartObj.chart) continue;
      chartObj.chart.timeScale().setVisibleRange(range);
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

    wrapper.addEventListener("pointerdown", () => this.setActiveChart(id));

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
      layout: {
        background: { type: "solid", color: "#131722" },
        textColor: "#d1d4dc",
        localization: {
          timeZone: "Europe/Moscow",
          timeFormatter: mskFullTime,
        },
      },
      grid: { vertLines: { color: "#242832" }, horzLines: { color: "#242832" } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: {
        timeVisible: true, secondsVisible: false,
        barSpacing: 8,
        minBarSpacing: 2,
        rightOffset: 10,
        tickMarkFormatter: (time, tickMarkType) => {
          const ts = typeof time === "object" && time.year !== undefined
            ? Date.UTC(time.year, time.month - 1, time.day) / 1000
            : time;
          const d = new Date(ts * 1000);
          const opts = { timeZone: "Europe/Moscow", hour12: false };
          if (tickMarkType === 4) {
            opts.hour = "2-digit"; opts.minute = "2-digit"; opts.second = "2-digit";
          } else if (tickMarkType === 3) {
            opts.hour = "2-digit"; opts.minute = "2-digit";
          } else if (tickMarkType === 2) {
            opts.day = "numeric"; opts.month = "short";
          } else if (tickMarkType === 1) {
            opts.month = "short"; opts.year = "numeric";
          } else {
            opts.year = "numeric";
          }
          return d.toLocaleString("ru-RU", opts);
        },
        timeFormatter: mskFullTime,
      },
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
      // ponytail: defer fitContent until after resize settles
      setTimeout(() => {
        const r2 = body.getBoundingClientRect();
        if (r2.width > 0 && r2.height > 0) chart.applyOptions({ width: r2.width, height: r2.height });
        chart.timeScale().fitContent();
        chart.timeScale().scrollToPosition(5, false);
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
        return chart.addAreaSeries({ topColor: "rgba(41, 98, 255, 0.4)", bottomColor: "rgba(41, 98, 255, 0.0)", lineColor: "#2962FF", lineWidth: 2, priceLineVisible: true, lastValueVisible: true });
      case "bar":
        return chart.addBarSeries({ upColor: "#26a69a", downColor: "#ef5350", borderVisible: false, priceLineVisible: true, lastValueVisible: true });
      default:
        return chart.addCandlestickSeries({ upColor: "#26a69a", downColor: "#ef5350", borderVisible: false, wickUpColor: "#26a69a", wickDownColor: "#ef5350", priceLineVisible: true, lastValueVisible: true });
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

    // ponytail: preserve zoom/pan across data reloads (e.g. tab switch)
    const hadData = chartObj.mainSeries.data().length > 0;
    let savedRange = null;
    if (hadData) {
      try { savedRange = chartObj.chart.timeScale().getVisibleRange(); } catch {}
    }

    chartObj.mainSeries.setData(this._formatDataForType(candles, chartObj.chartType));
    chartObj.volumeSeries.setData(this._formatVolumeData(candles));

    for (const [indName, values] of Object.entries(indicators)) {
      if (!chartObj.indicators[indName]) {
        const color = this.indicatorColors[indName] || "#787B86";
        chartObj.indicators[indName] = chartObj.chart.addLineSeries({
          color, lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: true
        });
      }
      chartObj.indicators[indName].setData(values);
    }

    requestAnimationFrame(() => {
      chartObj.chart.priceScale('right').applyOptions({ autoScale: true });
      if (savedRange) {
        const data = chartObj.mainSeries.data();
        if (data.length === 0) return;
        const firstTime = data[0].time;
        const lastTime = data[data.length - 1].time;
        const from = Math.max(savedRange.from, firstTime);
        const to = Math.min(savedRange.to, lastTime);
        if (from < to) {
          chartObj.chart.timeScale().setVisibleRange({ from, to });
        } else {
          chartObj.chart.timeScale().fitContent();
        }
      }
      // ponytail: first load only — fit + scroll right; updates preserve view
    });
  }

  updateCandle(id, candle) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;

    const tfSeconds = TF_SECONDS[chartObj.config.timeframe] || 60;
    const now = Math.floor(Date.now() / 1000);
    if (candle.time > floorTs(now, tfSeconds)) {
      log(`Ignoring future candle time=${candle.time} for ${chartObj.config.symbol}`);
      return;
    }

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

    if (chartObj.config._lastCandles) {
      const candles = chartObj.config._lastCandles;
      const lastIdx = candles.length - 1;
      if (lastIdx >= 0 && candles[lastIdx].time === candle.time) {
        candles[lastIdx] = candle;
      } else if (lastIdx < 0 || candles[lastIdx].time < candle.time) {
        candles.push(candle);
      }
      const isClosed = candle.time < floorTs(now, tfSeconds);
      const heavyTypes = new Set(loadCustomIndicators().map(c => c.type).filter(t => HEAVY_INDICATOR_TYPES.has(t)));
      for (const [indId, series] of Object.entries(chartObj.indicators)) {
        if (HEAVY_INDICATOR_TYPES.has(indId) || heavyTypes.has(indId)) {
          if (!isClosed) continue;
        }
        const data = calcIndicator(indId, candles);
        if (data) series.setData(data);
      }
    }
  }

  changeChartType(id, newType) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;

    const savedLines = chartObj._horizontalLines.map(l => ({ price: l.options().price, ...(l._opts || {}) }));
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

    for (const opts of savedLines) this.addHorizontalLine(id, opts.price, opts);
    log(`Chart ${id} type changed to ${newType}`);
  }

  removeChart(id) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    this.ui.unbindChartInteractions(chartObj);
    if (chartObj._resizeObserver) chartObj._resizeObserver.disconnect();
    if (chartObj._resizeTimer) clearTimeout(chartObj._resizeTimer);
    this.removeAllHorizontalLines(id);
    chartObj.chart.remove();
    if (chartObj.container.parentNode) chartObj.container.parentNode.removeChild(chartObj.container);
    this.charts.delete(id);
    log(`Chart removed: ${id}`);
  }

  addHorizontalLine(chartId, price, opts = {}) {
    const sourceObj = this.charts.get(chartId);
    if (!sourceObj || !sourceObj.mainSeries) return;
    const symbol = sourceObj.config.symbol;
    const color = opts.color || "#2196F3";
    const lineWidth = opts.lineWidth || 1;
    const lineStyle = opts.lineStyle ?? 2;
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol || !chartObj.mainSeries) continue;
      const exists = chartObj._horizontalLines.some(l => {
        const p = l.options().price;
        return p != null && Math.abs(p - price) < 0.5;
      });
      if (exists) continue;
      const line = chartObj.mainSeries.createPriceLine({
        price, color, lineWidth, lineStyle, axisLabelVisible: true, title: ""
      });
      line._opts = { color, lineWidth, lineStyle };
      chartObj._horizontalLines.push(line);
    }
    log(`Horizontal line added at ${price} for ${symbol}`);
  }

  removeAllHorizontalLines(chartId) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj) return;
    for (const line of chartObj._horizontalLines) chartObj.mainSeries.removePriceLine(line);
    chartObj._horizontalLines = [];
  }

  clearAllScannerData() {
    for (const id of this.getAllChartIds()) {
      this.removeAllHorizontalLines(id);
    }
    this.alerts = [];
    this._saveAlerts();
    this.autoLevels = {};
    this._saveAutoLevels();
    log("Cleared all levels, alerts and auto levels");
  }

  clearAllForSymbol(symbol) {
    if (!symbol) return;
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol || !chartObj.mainSeries) continue;
      for (const line of chartObj._horizontalLines) chartObj.mainSeries.removePriceLine(line);
      chartObj._horizontalLines = [];
    }
    this.alerts = this.alerts.filter(a => a.symbol !== symbol);
    this._saveAlerts();
    delete this.autoLevels[symbol];
    this._saveAutoLevels();
    try {
      const scanFlags = JSON.parse(localStorage.getItem("trading-scan-flags") || "{}");
      if (scanFlags[symbol]) {
        delete scanFlags[symbol];
        localStorage.setItem("trading-scan-flags", JSON.stringify(scanFlags));
      }
    } catch {}
    log(`Cleared all lines/alerts for ${symbol}`);
  }

  _removeLineFromAll(price, symbol) {
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol || !chartObj.mainSeries) continue;
      const line = this._findLineByPrice(chartObj, price);
      if (!line) continue;
      chartObj.mainSeries.removePriceLine(line);
      chartObj._horizontalLines = chartObj._horizontalLines.filter(l => l !== line);
    }
    this.alerts = this.alerts.filter(a => !(a.symbol === symbol && Math.abs(a.price - price) < 0.5));
    this._saveAlerts();
    const lv = this.autoLevels[symbol];
    if (lv) {
      if (lv.dayHigh != null && Math.abs(lv.dayHigh - price) < 0.5) delete lv.dayHigh;
      if (lv.dayLow != null && Math.abs(lv.dayLow - price) < 0.5) delete lv.dayLow;
      if (lv.eveHigh != null && Math.abs(lv.eveHigh - price) < 0.5) delete lv.eveHigh;
      if (lv.eveLow != null && Math.abs(lv.eveLow - price) < 0.5) delete lv.eveLow;
      if (lv.dayHigh == null && lv.dayLow == null && lv.eveHigh == null && lv.eveLow == null) delete this.autoLevels[symbol];
      this._saveAutoLevels();
    }
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

