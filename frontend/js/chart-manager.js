import { log } from "./utils.js";
import { calcIndicator, loadCustomIndicators } from "./indicators.js";
import { ChartUI } from "./chart-ui.js";
import { TF_SECONDS, floorTs, HEAVY_INDICATOR_TYPES, POC_PRESET_TYPES, CHART_SETTINGS_KEY, CHART_SETTINGS_DEFAULTS } from "./constants.js";

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
            target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio }) => {
              if (!self._chart || self._times.length === 0) return;
              const ts = self._chart.timeScale();
              ctx.lineWidth = 0.5;
              ctx.strokeStyle = "#758696";
              ctx.setLineDash([6, 5]);
              for (const t of self._times) {
                const x = ts.timeToCoordinate(t);
                if (x == null) continue;
                const px = x * horizontalPixelRatio;
                ctx.beginPath();
                ctx.moveTo(px, 0);
                ctx.lineTo(px, bitmapSize.height);
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
    this.onDrawingsChanged = null;
    this._pocState = new Map(); // chartId -> indId -> {snap} // snap = {finals, live}
    this.indicatorColors = {
      rsi: "#2962FF", macd: "#FF6D00", macd_signal: "#9C27B0",
      macd_hist: "#787B86", sma: "#e91e63", poc: "#FF5722", din_poc: "#00C2FF", poc30: "#00C2FF",
      poc60: "#2ECC71", poc120: "#F1C40F", poc240: "#E67E22", poc480: "#E74C3C", poc_day: "#B48EAD"
    };
    this._activeTool = "crosshair";
    this.activeChartId = null;
    this._magnetOn = false;
    this.onToolReset = null;
    this._sendDrawingCommand = null;
    this.alerts = this._loadAlerts();
    this.autoLevels = this._loadAutoLevels();
    this._linesBySymbol = {};
    this.ui = new ChartUI(this);
    // Синхронизация панелей по умолчанию выключена: у каждой панели свои
    // символ и таймфрейм. Включается вручную в меню сетки и при новом
    // запуске снова выключается.
    this.sync = { symbol: false, timeframe: false, crosshair: false, time: false, dateRange: false };
    setInterval(() => this._tickPoc(), 1000);
    // Chrome не пропускает звук с вкладки и не показывает запрос на
    // уведомления, пока пользователь не interacted со страницей. Поэтому
    // цепляемся за первый клик: и звук разблокируется, и разрешение спросят.
    document.addEventListener("pointerdown", () => {
      this.unlockAudio();
      if ("Notification" in window && Notification.permission === "default") {
        try {
          const asked = Notification.requestPermission();
          if (asked && asked.catch) asked.catch(() => {});
        } catch (e) {}
      }
    }, { once: true });

    // Оформление общее для всех вкладок браузера: в соседней вкладке
    // оно должно примениться сразу, а не после перезагрузки.
    window.addEventListener("storage", (e) => {
      if (e.key !== CHART_SETTINGS_KEY) return;
      const settings = this._getChartSettings();
      if (Object.keys(settings).length === 0) return;
      this.applyChartSettingsToAll(settings);
    });
  }

  /**
   * Разблокировка звука: Chrome не даёт проигрывать звук с вкладки, пока
   * пользователь не кликнул. Один тихий проигрыватель снимает запрет.
   */
  unlockAudio() {
    if (this._audioUnlocked) return;
    this._audioUnlocked = true;
    try {
      const audio = new Audio("sounds/alert.wav");
      audio.volume = 0;
      const played = audio.play();
      if (played && played.catch) played.catch(() => {});
    } catch (e) {}
  }

  /**
   * Пользовательские алерты хранятся на сервере и приезжают через store,
   * поэтому в памяти держим только зеркало.
   */
  _loadAlerts() {
    return [];
  }

  /** Старое хранилище: нужно один раз при переносе на сервер. */
  loadLegacyAlerts() {
    try {
      return JSON.parse(localStorage.getItem("trading-alerts") || "[]");
    } catch {
      return [];
    }
  }

  _saveAlerts() {
    // Алерты живут на сервере; локальный кэш больше не используется.
  }

  /**
   * Старый кэш уровней сканера. Нужен только для разового переноса
   * на сервер, см. migrateLegacyAutoLevels.
   */
  _loadAutoLevels() {
    try { return JSON.parse(localStorage.getItem("trading-auto-levels") || "{}"); }
    catch { return {}; }
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

  /**
   * Уровни ATR-сканера.
   *
   * Раньше здесь была своя запись в localStorage и свои алерты в памяти.
   * Теперь уровни и алерты на них — серверные объекты (auto_level),
   * поэтому метод лишь отправляет команду, а рисует их app.js по данным
   * из store.
   */
  setAutoLevels(symbol, dayHigh, dayLow, eveHigh, eveLow) {
    if (typeof this._setAutoLevels !== "function") {
      log("Уровни недоступны: нет подключения к серверу");
      return Promise.resolve(null);
    }
    return this._setAutoLevels(symbol, dayHigh, dayLow, eveHigh, eveLow);
  }

  /**
   * Создать алерт. Проверяет условие сервер, состояние приходит событием,
   * поэтому здесь только команда и обновление вида линии.
   */
  addAlert(chartId, price, opts = {}) {
    const sourceObj = this.charts.get(chartId);
    const symbol = sourceObj ? sourceObj.config.symbol : "???";
    let lineColor = "#2196F3";
    for (const [, chartObj] of this.charts) {
      if (chartObj.config.symbol !== symbol) continue;
      const line = this._findLineByPrice(chartObj, price);
      if (line) lineColor = line._opts?.color || "#2196F3";
    }
    if (!this._createAlert) {
      log("Алерт недоступен: нет подключения к серверу");
      return null;
    }
    const alert = this._createAlert({
      symbol,
      price,
      condition: opts.condition || "cross",
      timeframe: opts.timeframe || "1m",
      channels: opts.channels || ["sound", "browser"],
      repeat_mode: opts.repeat_mode || "once",
      expires_at: opts.expires_at ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      line_color: lineColor
    });
    // до срабатывания линия сплошная
    this._updateLineColor(chartId, price, null, null, 0);
    log(`Алерт создан: ${symbol} @ ${price}`);
    return alert;
  }

  /** Удалить алерт по цене на графике. */
  removeAlert(chartId, price) {
    const sourceObj = this.charts.get(chartId);
    const symbol = sourceObj ? sourceObj.config.symbol : null;
    const tol = this._priceTol(sourceObj);
    const matched = this._findServerAlert(symbol, price, tol);
    if (matched) {
      if (this._deleteAlert) this._deleteAlert(matched.id);
      else log("Удаление алерта недоступно: нет подключения к серверу");
    }
    this._updateLineColor(chartId, price, null, null, 2);
  }

  /** Алерт на этом символе и цене, если он есть. */
  _findServerAlert(symbol, price, tol) {
    const list = this.alerts || [];
    return list.find(
      (a) => (!symbol || a.symbol === symbol) && a.price != null && Math.abs(a.price - price) <= tol
    ) || null;
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
      // Лину перекрашиваем на месте: пересоздание рвало её метки
      // (_objectId, _autoLevel), и дальше её никто не узнавал бы — ни
      // автоуровень, ни правило «сработал — штрихи».
      try {
        line.applyOptions({ color: newColor, lineWidth: newLineWidth, lineStyle: newLineStyle });
      } catch (e) {
        log("Не удалось изменить вид линии", e);
        continue;
      }
      line._opts = { color: newColor, lineWidth: newLineWidth, lineStyle: newLineStyle, ...(old.ownerSymbol ? { ownerSymbol: old.ownerSymbol } : {}) };
    }
  }

  _findLineByPrice(chartObj, price) {
    const tol = this._priceTol(chartObj);
    return chartObj._horizontalLines.find(l => {
      const p = l.options().price;
      return p != null && Math.abs(p - price) < tol;
    }) || null;
  }

  /**
   * Проверка алертов убрана с клиента: условие проверяет сервер на каждой
   * свече, иначе без открытой вкладки алерты молчат, а в двух вкладках
   * одно срабатывание приходит дважды.
   */
  checkAlerts() {}

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
      const played = audio.play();
      if (played && played.catch) {
        played.catch((err) => log("Звук алерта не проигрался:", err && err.name));
      }
    } catch (e) {
      log("Звук алерта недоступен:", e);
    }
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

  _getChartSettings() {
    try { return JSON.parse(localStorage.getItem(CHART_SETTINGS_KEY) || "{}"); }
    catch { return {}; }
  }

  _saveChartSettings(settings) {
    localStorage.setItem(CHART_SETTINGS_KEY, JSON.stringify(settings));
  }

  /**
   * Оформление одно на весь терминал: настройка применяется ко всем
   * панелям сразу, а не к той, где открыли окно.
   */
  applyChartSettingsToAll(settings) {
    for (const [, chartObj] of this.charts) {
      if (!chartObj.mainSeries) continue;
      this._applyChartSettings(chartObj, settings);
    }
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
      const series = chartObj.chart.addSeries(LightweightCharts.LineSeries, {
        color, lineWidth,
        ...(this.isPoc(indId) ? {
          lineType: LightweightCharts.LineType.WithSteps,
          pointMarkersVisible: false,
          lastValueVisible: false,
        } : {}),
        // На ценовой шкале остаётся только текущая цена: значение
        // индикатора сюда не выводим.
        priceFormat: { type: "price", precision: 2, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: false
      });
      chartObj.indicators[indId] = series;
      chartObj.config._activeIndicators.push(indId);

      if (this.isPoc(indId)) {
        this._joinPoc(id, indId);
      } else if (chartObj.config._lastCandles) {
        const data = calcIndicator(indId, chartObj.config._lastCandles, this.calcOpts(chartObj, indId));
        if (data) this._updateIndicatorSeries(series, data);
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

  /**
   * Обновить серию индикатора, не пересобирая её целиком.
   *
   * Значение точки i зависит только от свечей до i, поэтому у встроенных
   * индикаторов прежние точки не меняются: новой свече хватает обновить
   * последнюю точку. Пересборка всей серии на каждой свече выглядела бы
   * как перезагрузка графика, хотя значения на экране те же.
   *
   * У кастомных формул значения пересчитываются по всему массиву свечей,
   * поэтому там прежние точки могут разойтись — тогда серию пересобираем.
   */
  _updateIndicatorSeries(series, data) {
    if (!series || !Array.isArray(data) || data.length === 0) return;
    const prev = series.data();
    if (!prev || prev.length === 0) {
      series.setData(data);
      return;
    }

    // Все точки, кроме последней новой, должны совпасть с прежними.
    const common = Math.min(prev.length, data.length - 1);
    let same = true;
    for (let i = 0; i < common; i++) {
      if (prev[i].time !== data[i].time || prev[i].value !== data[i].value) {
        same = false;
        break;
      }
    }

    if (!same || data.length < prev.length) {
      series.setData(data);
      return;
    }

    const lastNew = data[data.length - 1];
    const lastPrev = prev[prev.length - 1];
    // Последняя точка не изменилась — перерисовывать нечего.
    if (data.length === prev.length &&
        lastNew.time === lastPrev.time && lastNew.value === lastPrev.value) {
      return;
    }
    // update заменяет последнюю точку, если время то же, и добавляет новую,
    // если свежее. Если время уехало назад — нужна пересборка.
    if (lastNew.time < lastPrev.time) {
      series.setData(data);
      return;
    }
    series.update(lastNew);
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
        this._updateIndicatorSeries(chartObj.indicators[indId], pts);
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
          this._updateIndicatorSeries(chartObj.indicators[indId], pts);
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
      const changed = chartObj.config.symbol !== symbol;
      if (changed) {
        this._stashLines(id, chartObj);
        this.removeAllHorizontalLines(id);
      }
      chartObj.config.symbol = symbol;
      if (changed) this._restoreLines(id, chartObj);
      chartObj.config.source = source;
      const btn = chartObj.container.querySelector(".ch-symbol-btn");
      if (btn) btn.textContent = symbol;
      this.onChartChange(id, symbol, chartObj.config.timeframe, source, chartObj.chartType);
    }
    // символ активного графика изменился — подсветка тикера должна уехать вместе с ним
    if (this.onActiveChartChange) this.onActiveChartChange(this.activeChartId);
    // линии нового символа приходят из store, а не из локального кэша
    this.onDrawingsChanged?.();
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
      // График мог быть снят между событием и этой правкой: у снятого
      // библиотека роняет обращение.
      try {
        chartObj.chart.setCrosshairPosition(NaN, time, chartObj.mainSeries);
      } catch (e) {
        /* график уже снят — синхронизировать нечего */
      }
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

    chartObj.volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      color: "#089982", priceFormat: { type: "volume" },
      priceScaleId: "volume",
      // Шкала объёма своя, на правой оси ей не место: значение последнего
      // столбца печаталось поверх ценовых делений.
      lastValueVisible: false, priceLineVisible: false
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      ticksVisible: false
    });

    chartObj.chart = chart;

    // Палитра приложения применяется всегда: без сохранённых настроек
    // график остался бы с цветами библиотеки.
    const savedSettings = { ...CHART_SETTINGS_DEFAULTS, ...this._getChartSettings() };
    this._applyChartSettings(chartObj, savedSettings);

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
        return chart.addSeries(LightweightCharts.LineSeries, { color: "#2962FF", lineWidth: 2, priceLineVisible: true, lastValueVisible: true });
      case "area":
        return chart.addSeries(LightweightCharts.AreaSeries, { topColor: "rgba(41, 98, 255, 0.4)", bottomColor: "rgba(41, 98, 255, 0.0)", lineColor: "#2962FF", lineWidth: 2, priceLineVisible: true, lastValueVisible: true });
      case "bar":
        return chart.addSeries(LightweightCharts.BarSeries, { upColor: "#089982", downColor: "#f23645", borderVisible: false, thinBars: false, priceLineVisible: true, lastValueVisible: true });
      default:
        return chart.addSeries(LightweightCharts.CandlestickSeries, { upColor: "#089982", downColor: "#f23645", borderVisible: false, wickUpColor: "#089982", wickDownColor: "#f23645", priceLineVisible: true, lastValueVisible: true });
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
        chartObj.indicators[indName] = chartObj.chart.addSeries(LightweightCharts.LineSeries, {
          color, lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: false
        });
      }
      chartObj.indicators[indName].setData(values);
    }

    requestAnimationFrame(() => {
      // График могли снять, пока ждали кадр: перестроение панелей убирает
      // графики, и обращение к удалённому роняет библиотеку.
      if (!this.charts.has(id)) return;
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
        // Точечное обновление: прежние точки встроенных индикаторов от новой
        // свечи не меняются, пересобирать всю серию было незачем.
        if (data) this._updateIndicatorSeries(series, data);
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
    // Линии с новой серией нужно перерисовать из store: локальный кэш
    // не знает про идентификаторы объектов.
    this.onDrawingsChanged?.();
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
    // Из карты убираем до remove(): библиотека при снятии шлёт события,
    // и синхронизация перекрестия дёргала уже удалённый график.
    this.charts.delete(id);
    // Снятая панель не должна оставаться активной: идентификатор указывал
    // бы на несуществующий график, и вочлист, кнопка «Очистить рисунки»
    // и подсветка панели работали бы вхолостую.
    if (this.activeChartId === id) this.activeChartId = null;
    chartObj.chart.remove();
    if (chartObj.container.parentNode) chartObj.container.parentNode.removeChild(chartObj.container);
    log(`Chart removed: ${id}`);
  }

  /**
   * Снять одноразовый инструмент после действия.
   *
   * Вызывается только для инструментов с oneShot: поставил линию — вернулся
   * курсор. Стиралка и магнит остаются включёнными, для них залипание
   * удобно. Магнит здесь тоже не трогаем: он работает как защёлка.
   */
  resetTool() {
    this._activeTool = "crosshair";
    if (this.onToolReset) this.onToolReset();
  }

  /**
   * Отправка команды рисования на сервер.
   *
   * Саму функцию задаёт app.js: там живут шина команд и идентификатор
   * раскладки. Пока она не задана, рисование работает только локально.
   */
  sendDrawingCommand(payload) {
    if (!this._sendDrawingCommand) {
      log("Команда рисования недоступна: нет подключения к серверу");
      return null;
    }
    return this._sendDrawingCommand(payload);
  }

  /**
   * Линия по серверному объекту. Единственный путь, которым рисовалка
   * попадает на график: и при первом открытии, и при изменении с сервера.
   */
  addObjectLine(chartObj, obj) {
    if (!chartObj?.mainSeries || obj?.data?.price == null) return null;
    const style = obj.style || {};
    const line = chartObj.mainSeries.createPriceLine({
      price: obj.data.price,
      color: style.color || "#2196F3",
      lineWidth: style.lineWidth ?? 1,
      lineStyle: style.lineStyle ?? 2,
      axisLabelVisible: false,
      title: ""
    });
    line._opts = {
      color: style.color || "#2196F3",
      lineWidth: style.lineWidth ?? 1,
      lineStyle: style.lineStyle ?? 2,
      ownerSymbol: obj.symbol || chartObj.config.symbol
    };
    line._objectId = obj.id;
    chartObj._horizontalLines.push(line);
    return line;
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
        price, color, lineWidth, lineStyle, axisLabelVisible: false, title: ""
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

  // линии живут в памяти графика и сносились при смене тикера; stash/restore
  // держат их по тикеру, addHorizontalLine дедуплицирует по цене — повторный
  // вызов applyAutoLevelsForSymbol дублей не создаст
  _stashLines(chartId, chartObj) {
    const symbol = chartObj.config.symbol;
    if (!symbol) return;
    const saved = this._linesBySymbol[symbol] || (this._linesBySymbol[symbol] = []);
    for (const line of chartObj._horizontalLines) {
      // Линии с _objectId хранятся на сервере: кэшировать их здесь не нужно,
      // после смены символа они возвращаются синхронизацией из store.
      if (line._objectId) continue;
      const o = line.options();
      if (o.price == null) continue;
      const price = o.price;
      if (saved.some(s => Math.abs(s.price - price) < this._priceTol(chartObj))) continue;
      saved.push({ price, color: o.color, lineWidth: o.lineWidth, lineStyle: o.lineStyle });
    }
  }

  _restoreLines(chartId, chartObj) {
    const saved = this._linesBySymbol[chartObj.config.symbol];
    if (!saved) return;
    for (const l of saved) {
      this.addHorizontalLine(chartId, l.price, { color: l.color, lineWidth: l.lineWidth, lineStyle: l.lineStyle, ownerSymbol: chartObj.config.symbol });
    }
  }

  /**
   * Локальная очистка остатков сканера.
   *
   * Основное удаление идёт командами object.clear_symbol; здесь снимаются
   * только флажки и локальный кэш черт старого уровня.
   */
  clearAllScannerData() {
    this._linesBySymbol = {};
    this.autoLevels = {};
    log("Cleared local scanner cache");
  }

  clearAllForSymbol(symbol) {
    if (!symbol) return;
    delete this._linesBySymbol[symbol];
    delete this.autoLevels[symbol];
    try {
      const scanFlags = JSON.parse(localStorage.getItem("trading-scan-flags") || "{}");
      if (scanFlags[symbol]) {
        delete scanFlags[symbol];
        localStorage.setItem("trading-scan-flags", JSON.stringify(scanFlags));
      }
    } catch {}
    log(`Cleared all lines/alerts for ${symbol}`);
  }

  getAllChartIds() { return Array.from(this.charts.keys()); }

  restoreAlertColors() {
    for (const alert of this.alerts) {
      // Сработавший алерт — штрихи, вооружённый — сплошная линия.
      const style = alert.status === "fired" ? 2 : 0;
      for (const [id, chartObj] of this.charts) {
        if (chartObj.config.symbol === alert.symbol) this._updateLineColor(id, alert.price, null, null, style);
      }
    }
  }
}

