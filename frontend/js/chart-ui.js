import { log } from "./utils.js";
import { INDICATOR_TYPES, INDICATORS, loadCustomIndicators, saveCustomIndicators, mergeIndicators, getDeletedIndicators } from "./indicators.js";
import { loadTickers, addTicker, removeTicker, refreshAllSymbolDropdowns, buildSymbolItemEl } from "./tickers.js";

export { refreshAllSymbolDropdowns };

const TIMEFRAMES = [
  { tf: "1m", label: "1m" },
  { tf: "10m", label: "10m" },
  { tf: "1h", label: "1ч" },
  { tf: "1d", label: "Д" },
];

export class ChartUI {
  constructor(manager) {
    this.m = manager;
    this._ctxMenu = null;
    this._ctxData = null;
    this._initContextMenu();
  }

  _initContextMenu() {
    this._ctxMenu = document.createElement("div");
    this._ctxMenu.className = "hline-ctx hidden";
    document.body.appendChild(this._ctxMenu);
    document.addEventListener("click", () => this._ctxMenu.classList.add("hidden"));
  }

  showContextMenu(e, chartId, price) {
    const existing = this.m.alerts.find(a => a.chartId === chartId && Math.abs(a.price - price) < 0.5);
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
        if (action === "add-alert") this.m.addAlert(chartId, price);
        else if (action === "remove-alert") this.m.removeAlert(chartId, price);
        else if (action === "remove-line") this._removeLineByPrice(chartId, price);
        this._ctxMenu.classList.add("hidden");
      });
    });
  }

  _removeLineByPrice(chartId, price) {
    const chartObj = this.m.charts.get(chartId);
    if (!chartObj) return;
    this.m._removeLineFromAll(price, chartObj.config.symbol);
  }

  buildHeader(id) {
    const header = document.createElement("div");
    header.className = "chart-header";

    const chartObj = this.m.charts.get(id);
    const cfg = chartObj ? chartObj.config : {};

    const symbolBtn = document.createElement("button");
    symbolBtn.className = "ch-symbol-btn";
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
    loadTickers().forEach(s => list.appendChild(buildSymbolItemEl(s)));
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
          this.m.changeSymbol(ticker, "moex", id);
        }
      }
    });

    list.querySelectorAll(".ch-symbol-item").forEach(item => {
      item.addEventListener("click", () => {
        const ticker = item.dataset.ticker;
        const source = item.dataset.source;
        symbolBtn.textContent = ticker;
        symbolDropdown.classList.add("hidden");
        this.m.changeSymbol(ticker, source, id);
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
        this.m.changeTimeframe(t.tf, id);
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
      this.m.changeChartType(id, typeSelect.value);
      this.m._updateChartConfig(id, { chartType: typeSelect.value });
    });

    const indContainer = document.createElement("div");
    indContainer.className = "ch-ind-buttons";
    this.renderIndicatorButtons(indContainer, id, cfg);

    const addIndBtn = document.createElement("button");
    addIndBtn.className = "ch-ind-btn";
    addIndBtn.textContent = "+";
    addIndBtn.title = "Создать индикатор";
    addIndBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showIndicatorModal(id);
    });
    indContainer.appendChild(addIndBtn);

    const clearBtn = document.createElement("button");
    clearBtn.className = "ch-ind-btn";
    clearBtn.textContent = "\u{1F5D1}";
    clearBtn.title = "Удалить все объекты";
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const symbol = chartObj.config.symbol;
      for (const [cid, obj] of this.m.charts) {
        if (obj.config.symbol !== symbol) continue;
        this.m.removeAllHorizontalLines(cid);
      }
      this.m.alerts = this.m.alerts.filter(a => a.symbol !== symbol);
      this.m._saveAlerts();
    });
    indContainer.appendChild(clearBtn);

    header.appendChild(symbolBtn);
    header.appendChild(tfContainer);
    header.appendChild(typeSelect);
    header.appendChild(indContainer);

    return header;
  }

  showChartSettings(id) {
    const chartObj = this.m.charts.get(id);
    if (!chartObj) return;
    const settings = this.m._getChartSettings(id);

    const defaults = {
      upColor: "#26a69a", downColor: "#ef5350", bgColor: "#131722",
      gridColor: "#242832", wickUpColor: "#26a69a", wickDownColor: "#ef5350",
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
      inp.addEventListener("input", () => { inp.nextElementSibling.textContent = inp.value; });
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
      this.m._saveChartSettings(id, newSettings);
      this.m._applyChartSettings(chartObj, newSettings);
      overlay.remove();
    });
  }

  renderIndicatorButtons(container, chartId, cfg) {
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
        this.m._toggleIndicator(chartId, ind.id);
        btn.classList.toggle("active");
      });
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (confirm(`Удалить индикатор "${ind.label}"?`)) {
          this.deleteCustomIndicator(ind.id, chartId, container, cfg);
        }
      });
      container.insertBefore(btn, container.lastChild);
    });
  }

  deleteCustomIndicator(indId, chartId, container, cfg) {
    const chartObj = this.m.charts.get(chartId);
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
    this.renderIndicatorButtons(container, chartId, cfg);
  }

  showIndicatorModal(chartId) {
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

        const chartObj = this.m.charts.get(chartId);
        if (chartObj) {
          const container = chartObj.container.querySelector(".ch-ind-buttons");
          if (container) this.renderIndicatorButtons(container, chartId, chartObj.config);
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

        const chartObj = this.m.charts.get(chartId);
        if (chartObj) {
          const container = chartObj.container.querySelector(".ch-ind-buttons");
          if (container) this.renderIndicatorButtons(container, chartId, chartObj.config);
        }
        overlay.remove();
      }
    });
  }

  bindChartInteractions(id, body, chartObj) {
    const onHorizontal = (e) => {
      if (e.button !== 0) return;
      if (this.m._activeTool !== "horizontal") return;
      const rect = body.getBoundingClientRect();
      const y = e.clientY - rect.top;
      let price = chartObj.mainSeries.coordinateToPrice(y);
      if (price == null || isNaN(price)) return;
      if (this.m._magnetOn && chartObj.crosshairTime != null) {
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
      this.m.addHorizontalLine(id, price);
      this.m._activeTool = "crosshair";
      document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
      document.querySelector('.tool-btn[data-tool="crosshair"]')?.classList.add("active");
    };

    const onEraser = (e) => {
      if (e.button !== 0) return;
      if (this.m._activeTool !== "eraser") return;
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
      if (closest && minDist < 10) {
        const removedPrice = closest.options().price;
        this.m._removeLineFromAll(removedPrice, chartObj.config.symbol);
      }
    };

    body.addEventListener("mousedown", onHorizontal, true);
    body.addEventListener("mousedown", onEraser, true);

    chartObj._boundListeners = [
      { target: body, handler: onHorizontal, capture: true },
      { target: body, handler: onEraser, capture: true },
    ];

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
      if (closest && minDist < 10) {
        this.showContextMenu(e, id, closest.options().price);
      }
    });

    const gearBtn = document.createElement("button");
    gearBtn.className = "chart-settings-btn";
    gearBtn.textContent = "⚙";
    gearBtn.title = "Настройки графика";
    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showChartSettings(id);
    });
    body.appendChild(gearBtn);
  }

  unbindChartInteractions(chartObj) {
    if (!chartObj._boundListeners) return;
    for (const { target, handler, capture } of chartObj._boundListeners) {
      target.removeEventListener("mousedown", handler, capture);
    }
    chartObj._boundListeners = null;
  }
}
