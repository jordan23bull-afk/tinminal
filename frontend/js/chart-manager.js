import { log } from "./utils.js";
import { calcIndicator, loadCustomIndicators } from "./indicators.js";
import { ChartUI } from "./chart-ui.js";
import { TF_SECONDS, floorTs, HEAVY_INDICATOR_TYPES, POC_PRESET_TYPES } from "./constants.js";

function mskFullTime(time) {
  if (typeof time === "object" && time.year !== undefined) {
    return `${time.year}-${String(time.month).padStart(2,"0")}-${String(time.day).padStart(2,"0")}`;
  }
  const d = new Date(time * 1000);
  return d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

// вертикальная линия на время(а) sessionTimes; draw через media coordinate space
class SessionLinePrimitive {
  constructor() {
    this._chart = null;
    this._series = null;
    this._times = [];
  }
  setTimes(times) { this._times = times || []; }
  paneViews() {
    const self = this;
    return [{
      zOrder() { return "normal"; },
      renderer() {
        return {
          draw(target) {
            target.useMediaCoordinateSpace((scope) => {
              const { context: ctx, mediaSize } = scope;
              if (!self._chart || self._times.length === 0) return;
              const ts = self._chart.timeScale();
              ctx.lineWidth = 1;
              ctx.strokeStyle = "#758696";
              ctx.setLineDash([6, 5]);
              for (const t of self._times) {
                const x = ts.timeToCoordinate(t);
                if (x == null) continue;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, mediaSize.height);
                ctx.stroke();
              }
              ctx.setLineDash([]);
            });
          },
          drawBackground() {},
        };
      },
    }];
  }
  attached(param) {
    this._chart = param.chart;
    this._series = param.series;
    this.updateData(param.series.data());
  }
  updateAllViews() {}
  updateData(data) {
    // первая свеча каждого торгового дня (по МСК) = начало сессии
    const times = [];
    let lastDay = null;
    for (const item of data) {
      const d = new Date(item.time * 1000);
      const day = d.toLocaleString("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" });
      if (day !== lastDay) {
        lastDay = day;
        times.push(item.time);
      }
    }
    this._times = times;
  }
  // live-свеча: если наступил новый торговый день — добавить линию без полного пересчёта
  addTimeIfNewSession(time) {
    const d = new Date(time * 1000);
    const day = d.toLocaleString("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" });
    const last = this._times.length ? this._times[this._times.length - 1] : null;
    const lastDay = last != null ? new Date(last * 1000).toLocaleString("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }) : null;
    if (day !== lastDay && !this._times.includes(time)) {
      this._times.push(time);
    }
  }
}

export class ChartManager {
  constructor(containerId, onChartChange) {
    this.container = document.getElementById(containerId);
    this.charts = new Map();
    this.onChartChange = onChartChange || (() => {});
    this.onPocNeeds = null;
    this.onActiveChartChange = null;
    this._pocState = new Map(); // chartId -> indId -> {snap} // snap = {finals, live}
    this.indicatorColors = {
      rsi: "#2962FF", macd: "#FF6D00", macd_signal: "#9C27B0",
      macd_hist: "#787B86", sma: "#e91e63", poc: "#FF5722", din_poc: "#00C2FF", poc30: "#00C2FF",
      poc60: "#2ECC71", poc120: "#F1C40F", poc240: "#E67E22", poc480: "#E74C3C", poc_day: "#B48EAD"
    };
    this._activeTool = "crosshair";
    this.activeChartId = null;
    this._magnetOn = false;
    this.alerts = this._loadAlerts();
    this.autoLevels = this._loadAutoLevels();
    this.ui = new ChartUI(this);
    this.sync = { symbol: true, timeframe: true, crosshair: true, time: false, dateRange: false };
    setInterval(() => this._tickPoc(), 1000);
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

  // матчинг уровней/алертов: полтинка тика инструмента, cap 0.5 (старое поведение
  // для дорогого тикера), при неизвестном тике — 0.01 (низкоценовые бумаги не сливаются)
  _priceTol(chartObj) {
    const tick = chartObj && chartObj.config.tick > 0 ? chartObj.config.tick : 0.01;
    return Math.min(0.5, tick / 2);
  }

  _symbolTol(symbol) {
    for (const [, c] of this.charts) {
      if (c.config.symbol === symbol) return this._priceTol(c);
    }
    return this._priceTol(null);
  }

  setAutoLevels(symbol, dayHigh, dayLow, eveHigh, eveLow) {
    const prev = this.autoLevels[symbol];
    const tol = this._symbolTol(symbol);
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
          if (oldPrices.some(op => Math.abs(p - op) < tol)) {
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
        if (l.p != null) this.addHorizontalLine(id, l.p, { color: l.c, lineWidth: l.w, lineStyle: 2, ownerSymbol: symbol });
      }
    }
  }

  _addSymbolAlert(symbol, price, color) {
    if (price == null) return;
    const tol = this._symbolTol(symbol);
    const exists = this.alerts.some(a => a.symbol === symbol && Math.abs(a.price - price) < tol);
    if (exists) return;
    let chartId = null;
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol === symbol) { chartId = id; break; }
    }
    this.alerts.push({ chartId, symbol, price, id: Date.now(), lineColor: color, auto: true });
    this._saveAlerts();
    // алерт активен — линия сплошная, цвет исходный
    if (chartId) this._updateLineColor(chartId, price, null, null, 0);
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
      const tol = this._priceTol(chartObj);
      const exists = this.alerts.some(a => a.chartId === id && Math.abs(a.price - price) < tol);
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
    // алерт активен — линия сплошная, цвет исходный
    this._updateLineColor(chartId, price, null, null, 0);
    log(`Alert added: ${symbol} @ ${price}`);
  }

  removeAlert(chartId, price) {
    const sourceObj = this.charts.get(chartId);
    const symbol = sourceObj ? sourceObj.config.symbol : null;
    const tol = this._priceTol(sourceObj);
    let origColor = "#2196F3";
    const matched = this.alerts.find(a => Math.abs(a.price - price) < tol && (symbol ? a.symbol === symbol : a.chartId === chartId));
    if (matched && matched.lineColor) origColor = matched.lineColor;
    this.alerts = this.alerts.filter(a => {
      if (Math.abs(a.price - price) >= tol) return true;
      if (symbol && a.symbol === symbol) return false;
      if (a.chartId === chartId) return false;
      return true;
    });
    this._saveAlerts();
    this._updateLineColor(chartId, price, origColor, null, 2);
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
      const newColor = color || old.color || "#2196F3";
      const newLineWidth = lineWidth != null ? lineWidth : (old.lineWidth || 1);
      const newLineStyle = lineStyle != null ? lineStyle : (old.lineStyle ?? 2);
      chartObj.mainSeries.removePriceLine(line);
      const newLine = chartObj.mainSeries.createPriceLine({
        price, color: newColor, lineWidth: newLineWidth, lineStyle: newLineStyle, axisLabelVisible: true, title: ""
      });
      newLine._opts = { color: newColor, lineWidth: newLineWidth, lineStyle: newLineStyle, ...(old.ownerSymbol ? { ownerSymbol: old.ownerSymbol } : {}) };
      chartObj._horizontalLines = chartObj._horizontalLines.map(l => l === line ? newLine : l);
    }
  }

  _findLineByPrice(chartObj, price) {
    const tol = this._priceTol(chartObj);
    return chartObj._horizontalLines.find(l => {
      const p = l.options().price;
      return p != null && Math.abs(p - price) < tol;
    }) || null;
  }

  checkAlerts(candle, opts = {}) {
    const notified = new Set();
    const symbol = opts.symbol ? String(opts.symbol).toUpperCase() : null;
    for (const alert of this.alerts) {
      if (alert.triggered) continue;
      // без фильтра свеча одного тикера ложно сбивала алерты других символов
      if (symbol && String(alert.symbol).toUpperCase() !== symbol) continue;
      if (candle.high >= alert.price && candle.low <= alert.price) {
        alert.triggered = true;
        const key = `${alert.symbol}_${alert.price}`;
        if (!notified.has(key)) {
          this._sendNotification(alert, candle);
          notified.add(key);
        }
        for (const [id, chartObj] of this.charts) {
          if (chartObj.config.symbol === alert.symbol) {
            // сработал — линия пунктир, цвет остаётся исходным
            this._updateLineColor(id, alert.price, null, null, 2);
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
      if (this.isPoc(indId)) this._leavePoc(id, indId);
    } else {
      const custom = loadCustomIndicators().find(c => c.id === indId);
      const color = (custom && custom.extra && custom.extra.color) || this.indicatorColors[indId] || "#787B86";
      const lineWidth = (custom && custom.extra && custom.extra.lineWidth) || 2;
      const series = chartObj.chart.addLineSeries({
        color, lineWidth,
        ...(this.isPoc(indId) ? {
          lineType: LightweightCharts.LineType.WithSteps,
          pointMarkersVisible: false,
          lastValueVisible: true,
        } : {}),
        priceFormat: { type: "price", precision: 2, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: true
      });
      chartObj.indicators[indId] = series;
      chartObj.config._activeIndicators.push(indId);

      if (this.isPoc(indId)) {
        this._joinPoc(id, indId);
      } else if (chartObj.config._lastCandles) {
        const data = calcIndicator(indId, chartObj.config._lastCandles, this.calcOpts(chartObj, indId));
        if (data) series.setData(data);
      }
    }
  }

  isPoc(indId) {
    if (indId === "din_poc" || POC_PRESET_TYPES.has(indId) || indId === "poc_day") return true;
    const custom = loadCustomIndicators().find(c => c.id === indId);
    return !!custom && (custom.type === "din_poc" || POC_PRESET_TYPES.has(custom.type) || custom.type === "poc_day");
  }

  _pocWindow(chartObj, indId) {
    const custom = loadCustomIndicators().find(c => c.id === indId);
    const params = (custom && custom.params) || {};
    const type = custom && custom.type;
    if (POC_PRESET_TYPES.has(indId) || POC_PRESET_TYPES.has(type)) {
      const preset = POC_PRESET_TYPES.has(type) ? type : indId;
      if (params.periodMin > 0) return params.periodMin;
      return parseInt(preset.slice(3), 10) || 30;
    }
    if (indId === "poc_day" || type === "poc_day") return params.periodMin > 0 ? params.periodMin : 1440;
    return params.period > 0 ? params.period : 9; // din_poc
  }

  _joinPoc(id, indId) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    const state = this._pocState.get(id) || (this._pocState.set(id, {}), this._pocState.get(id));
    state[indId] = { snap: null };
    const target = { chatId: id, indId, symbol: chartObj.config.symbol, windowMin: this._pocWindow(chartObj, indId) };
    if (typeof this.onPocNeeds === "function") this.onPocNeeds([target]);
  }

  _leavePoc(id, indId) {
    const state = this._pocState.get(id);
    if (state) delete state[indId];
    const chartObj = this.charts.get(id);
    if (chartObj && typeof this.onPocNeeds === "function") {
      this.onPocNeeds([{ chatId: id, indId, symbol: chartObj.config.symbol, windowMin: this._pocWindow(chartObj, indId), leave: true }]);
    }
  }

  applyPocSnapshot(data) {
    this._applyPoc(data, (state) => { state.snap = data.snap; });
  }

  applyPocUpdate(data) {
    this._applyPoc(data, (state) => { state.snap = data.snap; });
  }

  _pocStepPoints(snap, nowSec, tfSeconds = 60) {
    // step-after series: finals (полки по bucketStart), live: первая точка на
    // bucketStart, ступеньки на каждом изменении POC, правый конец продлевается до now.
    // Всё время floor-ится к сетке баров: иначе несовпадающие таймстемпы POC
    // вставляют лишние слоты на time-scale между свечами ("свечи раздвигаются")
    const pts = [];
    for (const f of (snap && snap.finals) || []) {
      if (f.value != null) pts.push({ time: floorTs(f.start, tfSeconds), value: f.value });
    }
    const live = snap && snap.live;
    if (live && live.value != null) {
      const hist = (live.history && live.history.length)
        ? live.history
        : [{ time: live.firstValueTime ?? live.bucketStart, value: live.value }];
      pts.push({ time: floorTs(live.bucketStart, tfSeconds), value: hist[0].value });
      for (const h of hist) {
        if (h.time > live.bucketStart) pts.push({ time: floorTs(h.time, tfSeconds), value: h.value });
      }
      const last = pts[pts.length - 1];
      const tEnd = floorTs(Math.max(nowSec, live.asOf ?? 0, last.time), tfSeconds);
      if (tEnd > last.time) {
        pts.push({ time: tEnd, value: live.value });
      } else {
        last.value = live.value;
      }
    } else if (pts.length) {
      pts.push({ time: floorTs(nowSec, tfSeconds), value: pts[pts.length - 1].value });
    }
    const out = [];
    for (const p of pts) {
      if (out.length && p.time <= out[out.length - 1].time) continue;
      out.push(p);
    }
    return out;
  }

  _applyPoc(data, mutate) {
    const symbol = String(data.symbol || "").toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [id, chartObj] of this.charts) {
      if (!chartObj || chartObj.config.symbol !== symbol) continue;
      for (const indId of Object.keys(chartObj.indicators)) {
        if (!this.isPoc(indId)) continue;
        if (this._pocWindow(chartObj, indId) !== data.windowMin) continue;
        const state = this._pocState.get(id);
        const st = state && state[indId];
        if (!st) continue;
        mutate(st);
        const pts = this._pocStepPoints(st.snap, nowSec, TF_SECONDS[chartObj.config.timeframe] || 60);
        chartObj.indicators[indId].setData(pts);
      }
    }
  }

  _tickPoc() {
    // продлеваем правый конец POC-линии до текущего момента, пока не придёт обновление
    for (const [id, state] of this._pocState) {
      const chartObj = this.charts.get(id);
      if (!chartObj) continue;
      const nowSec = Math.floor(Date.now() / 1000);
      for (const [indId, st] of Object.entries(state)) {
        if (!st || !st.snap || !st.snap.live) continue;
        if (chartObj.indicators[indId]) {
          const pts = this._pocStepPoints(st.snap, nowSec, TF_SECONDS[chartObj.config.timeframe] || 60);
          chartObj.indicators[indId].setData(pts);
        }
      }
    }
  }

  calcOpts(chartObj, indId) {
    if (!this.isPoc(indId)) return {};
    // тик инструмента — дефолт бина, если пользователь не задал свой; для poc30 ещё тф для окна в минутах
    const custom = loadCustomIndicators().find(c => c.id === indId);
    const userBin = custom && custom.params && custom.params.binSize > 0 ? custom.params.binSize : 0;
    const opts = userBin ? {} : { binSize: chartObj.config.tick || 0.5 };
    const custom2 = loadCustomIndicators().find(c => c.id === indId);
    const preset = POC_PRESET_TYPES.has(indId) ? indId : (custom2 && POC_PRESET_TYPES.has(custom2.type) ? custom2.type : null);
    if (preset) opts.tfSeconds = TF_SECONDS[chartObj.config.timeframe] || 300;
    return opts;
  }

  setActiveChart(id) {
    this.activeChartId = id;
    for (const [cid, obj] of this.charts) {
      obj.container.classList.toggle("active", cid === id);
    }
    if (this.onActiveChartChange) this.onActiveChartChange(id);
  }

  changeSymbol(symbol, source, sourceId) {
    source = source || "tinkoff";
    for (const [id, chartObj] of this.charts) {
      const update = id === sourceId || this.sync.symbol;
      if (!update) continue;
      if (chartObj.config.symbol !== symbol) this.removeAllHorizontalLines(id);
      chartObj.config.symbol = symbol;
      chartObj.config.source = source;
      const btn = chartObj.container.querySelector(".ch-symbol-btn");
      if (btn) btn.textContent = symbol;
      this.onChartChange(id, symbol, chartObj.config.timeframe, source, chartObj.chartType);
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
      this.onChartChange(id, chartObj.config.symbol, timeframe, chartObj.config.source, chartObj.chartType);
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
      _resizeTimer: null, _horizontalLines: []
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
    chartObj.sessionLine = new SessionLinePrimitive();
    chartObj.mainSeries.attachPrimitive(chartObj.sessionLine);

    chart.subscribeCrosshairMove((param) => {
      if (param && param.time) {
        chartObj.crosshairTime = param.time;
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
    if (chartObj.sessionLine) chartObj.sessionLine.updateData(candles);

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

    this.checkAlerts(candle, { symbol: chartObj.config.symbol });

    if (chartObj.sessionLine) chartObj.sessionLine.addTimeIfNewSession(candle.time);

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
        if (this.isPoc(indId)) continue; // серверные POC обновляются через poc_* события
        if (HEAVY_INDICATOR_TYPES.has(indId) || heavyTypes.has(indId)) {
          if (!isClosed) continue;
        }
        const data = calcIndicator(indId, candles, this.calcOpts(chartObj, indId));
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
    chartObj.sessionLine = new SessionLinePrimitive();
    newSeries.attachPrimitive(chartObj.sessionLine);
    chartObj.chartType = newType;

    if (chartObj.config._lastCandles) {
      newSeries.setData(this._formatDataForType(chartObj.config._lastCandles, newType));
      if (chartObj.sessionLine) chartObj.sessionLine.updateData(chartObj.config._lastCandles);
      chartObj.chart.timeScale().fitContent();
      chartObj.chart.timeScale().scrollToPosition(5, false);
    }

    for (const opts of savedLines) this.addHorizontalLine(id, opts.price, opts);
    log(`Chart ${id} type changed to ${newType}`);
  }

  removeChart(id) {
    const chartObj = this.charts.get(id);
    if (!chartObj) return;
    const symbol = chartObj.config.symbol;
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
    const ownerSymbol = opts.ownerSymbol || symbol;
    for (const [id, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol || !chartObj.mainSeries) continue;
      const tol = this._priceTol(chartObj);
      const exists = chartObj._horizontalLines.some(l => {
        const p = l.options().price;
        return p != null && Math.abs(p - price) < tol;
      });
      if (exists) continue;
      const line = chartObj.mainSeries.createPriceLine({
        price, color, lineWidth, lineStyle, axisLabelVisible: true, title: ""
      });
      line._opts = { color, lineWidth, lineStyle, ownerSymbol };
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
    const tol = this._symbolTol(symbol);
    this.alerts = this.alerts.filter(a => !(a.symbol === symbol && Math.abs(a.price - price) < tol));
    this._saveAlerts();
    const lv = this.autoLevels[symbol];
    if (lv) {
      if (lv.dayHigh != null && Math.abs(lv.dayHigh - price) < tol) delete lv.dayHigh;
      if (lv.dayLow != null && Math.abs(lv.dayLow - price) < tol) delete lv.dayLow;
      if (lv.eveHigh != null && Math.abs(lv.eveHigh - price) < tol) delete lv.eveHigh;
      if (lv.eveLow != null && Math.abs(lv.eveLow - price) < tol) delete lv.eveLow;
      if (lv.dayHigh == null && lv.dayLow == null && lv.eveHigh == null && lv.eveLow == null) delete this.autoLevels[symbol];
      this._saveAutoLevels();
    }
  }

  getAllChartIds() { return Array.from(this.charts.keys()); }

  restoreAlertColors() {
    for (const alert of this.alerts) {
      for (const [id, chartObj] of this.charts) {
        if (chartObj.config.symbol === alert.symbol) this._updateLineColor(id, alert.price, null, null, 0);
      }
    }
  }
}

