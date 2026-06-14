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
    this._alertLines = new Map();
    this._initContextMenu();
    this._requestNotificationPermission();
  }

  _requestNotificationPermission() {
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
    this._ctxMenu.className = "chart-context-menu hidden";
    document.body.appendChild(this._ctxMenu);

    document.addEventListener("click", () => {
      this._ctxMenu.classList.add("hidden");
    });
  }

  _showContextMenu(e, chartId) {
    const chartAlerts = this.alerts.filter(a => a.chartId === chartId && !a.triggered);
    const currentSound = localStorage.getItem("alert-sound") || "chime";

    let html = `
      <div class="ctx-item" data-action="add-alert">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
        Добавить уведомление
      </div>
      <div class="ctx-sound-row">
        <span>Звук:</span>
        <select class="ctx-sound-select" data-action="select-sound">
          <option value="chime" ${currentSound === "chime" ? "selected" : ""}>Звон</option>
          <option value="beep" ${currentSound === "beep" ? "selected" : ""}>Бип</option>
          <option value="alert" ${currentSound === "alert" ? "selected" : ""}>Тревога</option>
          <option value="ding" ${currentSound === "ding" ? "selected" : ""}>Динг</option>
          <option value="none" ${currentSound === "none" ? "selected" : ""}>Без звука</option>
        </select>
      </div>
    `;

    if (chartAlerts.length > 0) {
      html += `<div class="ctx-separator"></div>`;
      html += `<div class="ctx-label">Активные:</div>`;
      chartAlerts.forEach(a => {
        html += `
          <div class="ctx-alert-item" data-action="remove-alert" data-alert-id="${a.id}">
            <span class="ctx-alert-price">${a.symbol} — ${a.price}</span>
            <span class="ctx-alert-x">&times;</span>
          </div>
        `;
      });
      html += `<div class="ctx-separator"></div>`;
      html += `
        <div class="ctx-item ctx-danger" data-action="clear-alerts">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          Удалить все уведомления
        </div>
      `;
    }

    this._ctxMenu.innerHTML = html;
    this._ctxData = { chartId };
    this._ctxMenu.style.left = e.clientX + "px";
    this._ctxMenu.style.top = e.clientY + "px";
    this._ctxMenu.classList.remove("hidden");

    this._ctxMenu.querySelectorAll("[data-action]").forEach(item => {
      item.addEventListener("click", () => {
        const action = item.dataset.action;
        if (action === "add-alert") {
          this.addAlert(chartId, this._ctxData.price);
        } else if (action === "remove-alert") {
          this.removeAlert(parseInt(item.dataset.alertId), chartId);
        } else if (action === "clear-alerts") {
          this.clearAlerts(chartId);
        }
        this._ctxMenu.classList.add("hidden");
      });
    });

    const soundSelect = this._ctxMenu.querySelector("[data-action='select-sound']");
    if (soundSelect) {
      soundSelect.addEventListener("change", () => {
        localStorage.setItem("alert-sound", soundSelect.value);
      });
      soundSelect.addEventListener("click", (e) => e.stopPropagation());
    }
  }

  addAlert(chartId, price) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj) return;
    const symbol = chartObj.config.symbol || "???";

    this.alerts.push({
      id: Date.now(),
      chartId,
      symbol,
      price,
      triggered: false
    });
    this._saveAlerts();
    this._renderAlertBadges(chartId);
    log(`Alert added: ${symbol} @ ${price}`);
  }

  removeAlert(alertId, chartId) {
    this.alerts = this.alerts.filter(a => a.id !== alertId);
    this._saveAlerts();
    this._renderAlertBadges(chartId);
  }

  clearAlerts(chartId) {
    this.alerts = this.alerts.filter(a => a.chartId !== chartId);
    this._saveAlerts();
    this._renderAlertBadges(chartId);
  }

  _renderAlertBadges(chartId) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj) return;

    if (!chartObj._alertBadgeContainer) {
      const container = document.createElement("div");
      container.className = "alert-badge-container";
      chartObj.container.appendChild(container);
      chartObj._alertBadgeContainer = container;
    }

    const container = chartObj._alertBadgeContainer;
    container.innerHTML = "";

    const chartAlerts = this.alerts.filter(a => a.chartId === chartId && !a.triggered);
    for (const alert of chartAlerts) {
      const badge = document.createElement("div");
      badge.className = "alert-badge";
      badge.dataset.alertId = alert.id;

      const bell = document.createElement("span");
      bell.className = "alert-bell";
      bell.textContent = "🔔";

      const close = document.createElement("span");
      close.className = "alert-close";
      close.textContent = "×";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeAlert(alert.id, chartId);
      });

      badge.appendChild(bell);
      badge.appendChild(close);
      container.appendChild(badge);
    }

    this._positionAlertBadges(chartId);
  }

  _positionAlertBadges(chartId) {
    const chartObj = this.charts.get(chartId);
    if (!chartObj || !chartObj._alertBadgeContainer) return;

    const chart = chartObj.chart;
    const wrapper = chartObj.container;
    const wrapperRect = wrapper.getBoundingClientRect();

    const chartAlerts = this.alerts.filter(a => a.chartId === chartId && !a.triggered);
    const badges = chartObj._alertBadgeContainer.querySelectorAll(".alert-badge");

    badges.forEach((badge, i) => {
      const alert = chartAlerts[i];
      if (!alert) return;

      const y = chart.priceScale("right").priceToCoordinate(alert.price);
      if (y == null) {
        badge.style.display = "none";
        return;
      }

      const headerH = chartObj.container.querySelector(".chart-header")?.offsetHeight || 0;
      badge.style.display = "";
      badge.style.top = (headerH + y - 10) + "px";
      badge.style.right = "2px";
    });
  }

  _initAlertBadgeUpdates() {
    const update = () => {
      for (const [id] of this.charts) {
        this._positionAlertBadges(id);
      }
    };
    for (const [, chartObj] of this.charts) {
      chartObj.chart.timeScale().subscribeVisibleLogicalRangeChange(update);
    }
  }

  checkAlerts(candle) {
    for (const alert of this.alerts) {
      if (alert.triggered) continue;
      const chartObj = this.charts.get(alert.chartId);
      if (!chartObj) continue;
      if (chartObj.config.symbol !== alert.symbol) continue;

      const hit = candle.high >= alert.price && candle.low <= alert.price;

      if (hit) {
        alert.triggered = true;
        this._sendNotification(alert, candle);
        this.removeAlert(alert.id, alert.chartId);
      }
    }
  }

  _sendNotification(alert, candle) {
    const title = `${alert.symbol} — цена достигла ${alert.price}`;
    const body = `Текущая цена: ${candle.close}`;

    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, {
        body,
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔔</text></svg>",
        requireInteraction: false
      });
      n.onclick = () => { window.focus(); n.close(); };
    }

    const sound = localStorage.getItem("alert-sound") || "chime";
    if (sound !== "none") {
      this._playSound(sound);
    }

    log(`Alert triggered: ${title}`);
  }

  _playSound(type) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();

      const sounds = {
        chime: [
          { freq: 523, start: 0, dur: 0.15 },
          { freq: 659, start: 0.12, dur: 0.15 },
          { freq: 784, start: 0.24, dur: 0.2 },
        ],
        beep: [
          { freq: 800, start: 0, dur: 0.15 },
          { freq: 800, start: 0.2, dur: 0.15 },
        ],
        alert: [
          { freq: 880, start: 0, dur: 0.1 },
          { freq: 660, start: 0.12, dur: 0.1 },
          { freq: 880, start: 0.24, dur: 0.1 },
          { freq: 660, start: 0.36, dur: 0.1 },
        ],
        ding: [
          { freq: 1200, start: 0, dur: 0.3 },
        ],
      };

      const notes = sounds[type] || sounds.chime;
      notes.forEach(note => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = note.freq;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.3, ctx.currentTime + note.start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note.start + note.dur);
        osc.start(ctx.currentTime + note.start);
        osc.stop(ctx.currentTime + note.start + note.dur);
      });
    } catch (e) { /* audio not available */ }
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

    const showCtx = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const price = chartObj.crosshairPrice;
      if (price == null || isNaN(price)) return;

      this._ctxData = { chartId: id, price: Math.round(price * 100) / 100 };
      this._showContextMenu(e, id);
    };

    body.addEventListener("contextmenu", showCtx, true);
    wrapper.addEventListener("contextmenu", showCtx, true);

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
            this._positionAlertBadges(id);
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
    setTimeout(() => {
      this._renderAlertBadges(id);
      this._initAlertBadgeUpdates();
    }, 300);
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
