import { log } from "./utils.js";
import { INDICATOR_TYPES, INDICATORS, loadCustomIndicators, saveCustomIndicators, mergeIndicators, getDeletedIndicators } from "./indicators.js";
import { loadTickers, buildSymbolItemEl } from "./tickers.js";
import { store } from "./store.js";
import { getTool } from "./drawings/tools/registry.js";
import { eventToLocal } from "./drawings/coords.js";
import { hitHLine, hitLevel } from "./drawings/hittest.js";
import { levelsWithout } from "./drawings/levels.js";
import { saveLineStyle } from "./drawings/line-style.js";
import { CHART_SETTINGS_DEFAULTS } from "./constants.js";



// Палитра линии: 50 готовых цветов (серые, яркие, пастельные, тёмные),
// как у источника, плюс плитка «+» с системным выбором цвета.
const LINE_PALETTE = [
  "#FFFFFF", "#D1D4DC", "#B2B5BE", "#8B8E94", "#5D606B",
  "#363A45", "#1E222D", "#131722", "#08090D", "#000000",
  "#F23645", "#FF9800", "#FFD600", "#089982", "#00BCD4",
  "#2962FF", "#7B1FA2", "#E91E63", "#795548", "#607D8B",
  "#FFCDD2", "#FFE0B2", "#FFF9C4", "#C8E6C9", "#B2EBF2",
  "#BBDEFB", "#D1C4E9", "#F0F4C3", "#FFCCBC", "#CFD8DC",
  "#E57373", "#FFB74D", "#FFF176", "#81C784", "#4DD0E1",
  "#64B5F6", "#9575CD", "#F06292", "#A1887F", "#90A4AE",
  "#B71C1C", "#E65100", "#F9A825", "#1B5E20", "#006064",
  "#0D47A1", "#4A148C", "#880E4F", "#3E2723", "#263238",
];

const LINE_WIDTHS = [1, 2, 3, 4];

// 0 — сплошная, 2 — штрихи, 1 — точки: те три варианта, что у источника.
const LINE_STYLES = [
  { value: 0, label: "Линия" },
  { value: 2, label: "Штриховой пунктир" },
  { value: 1, label: "Точечный пунктир" },
];

const ALERT_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  <circle cx="7" cy="7" r="5.1" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <path d="M7 4.3V7l2 1.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M11.6 11.4h3.2M13.2 9.8v3.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
</svg>`;

const TRASH_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  <path d="M2.4 4.1h11.2M6 4.1V2.4h4v1.7M3.9 4.1l.7 9.5h6.8l.7-9.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`;

const TIMEFRAMES = [
  { tf: "1m", label: "1m" },
  { tf: "5m", label: "5m" },
  { tf: "10m", label: "10m" },
  { tf: "15m", label: "15m" },
  { tf: "30m", label: "30m" },
  { tf: "1h", label: "1ч" },
  { tf: "2h", label: "2ч" },
  { tf: "4h", label: "4ч" },
  { tf: "1d", label: "Д" },
];

export class ChartUI {
  constructor(manager) {
    this.m = manager;
    this._ctxMenu = null;
    this._ctxData = null;
    this._initContextMenu();

    // Плавающая панель настройки линии: живёт рядом с линией, а не
    // по центру экрана. Пока открыта, следует за координатой линии.
    this._linePanel = null;
    this._linePanelState = null;
    this._linePanelRaf = 0;
    this._initLinePanelGlobal();
    this._initLinePanelStore();
  }

  _initContextMenu() {
    this._ctxMenu = document.createElement("div");
    this._ctxMenu.className = "hline-ctx hidden";
    document.body.appendChild(this._ctxMenu);
    document.addEventListener("click", () => this._ctxMenu.classList.add("hidden"));
  }

  showContextMenu(e, chartId, object, target) {
    const chartObj = this.m.charts.get(chartId);
    // Уровень автоуровня: своя цена в поле данных, набор инструментов
    // для линии не подходит.
    if (object?.kind === "auto_level") {
      this._showLevelContextMenu(e, chartId, object, target);
      return;
    }
    const price = object?.data?.price;
    if (price == null) return;
    // Алерт ищем по символу и цене: у серверного алерта поля chartId нет,
    // и прежняя проверка всегда отвечала «алерта нет».
    const symbol = object.symbol || chartObj?.config?.symbol;
    const existing = this.m._findServerAlert(symbol, price, this.m._symbolTol(symbol));
    let html = "";
    html += `<div class="hline-ctx-item" data-action="edit-line">Изменить</div>`;
    if (!existing) {
      html += `<div class="hline-ctx-item" data-action="add-alert">Добавить алерт</div>`;
    } else {
      html += `<div class="hline-ctx-item" data-action="remove-alert">Удалить алерт</div>`;
    }
    html += `<div class="hline-ctx-item hline-ctx-danger" data-action="remove-line">Удалить линию</div>`;
    this._ctxMenu.innerHTML = html;
    this._ctxData = { chartId, object, price };
    this._ctxMenu.style.left = e.clientX + "px";
    this._ctxMenu.style.top = e.clientY + "px";
    this._ctxMenu.classList.remove("hidden");
    this._ctxMenu.querySelectorAll(".hline-ctx-item").forEach(item => {
      item.addEventListener("click", (ev) => {
        const action = item.dataset.action;
        if (action === "add-alert") this.m.addAlert(chartId, price);
        else if (action === "remove-alert") this.m.removeAlert(chartId, price, object.id);
        else if (action === "remove-line") this.m.sendDrawingCommand({ kind: "object.delete", id: object.id });
        else if (action === "edit-line") this._editLine(chartId, object, ev);
        this._ctxMenu.classList.add("hidden");
      });
    });
  }

  /**
   * Меню уровня автоуровня: у него своя цена в поле данных, а набор
   * действий для линии не подходит.
   */
  _showLevelContextMenu(e, chartId, object, target) {
    const field = target?.field;
    if (!field) return;
    let html = "";
    html += `<div class="hline-ctx-item" data-action="remove-level">Удалить уровень</div>`;
    this._ctxMenu.innerHTML = html;
    this._ctxData = { chartId, object, field };
    this._ctxMenu.style.left = e.clientX + "px";
    this._ctxMenu.style.top = e.clientY + "px";
    this._ctxMenu.classList.remove("hidden");
    this._ctxMenu.querySelectorAll(".hline-ctx-item").forEach(item => {
      item.addEventListener("click", () => {
        if (item.dataset.action === "remove-level") {
          this.m.sendDrawingCommand({
            kind: "object.set_auto_levels",
            symbol: object.symbol,
            timeframe: object.timeframe,
            levels: levelsWithout(object, field),
          });
        }
        this._ctxMenu.classList.add("hidden");
      });
    });
  }

  _editLine(chartId, object, anchorEvent = null) {
    this.showLineSettingsPanel(chartId, object, anchorEvent);
  }

  /**
   * Плавающий тулбар настройки линии — как у источника.
   *
   * Панель живёт у самой линии и едет за ней при зуме и панораме. Кнопки:
   * цвет, толщина, стиль, алерт, удаление. Выбор применяется сразу одной
   * командой object.update; предпросмотра и кнопки «Применить» нет — откат
   * живёт в обычной истории вкладки (Ctrl+Z). Выбранный вид запоминается и
   * достаётся следующей линии.
   */
  showLineSettingsPanel(chartId, object, anchorEvent = null) {
    const chartObj = this.m.charts.get(chartId);
    const price = object?.data?.price;
    if (!chartObj?.mainSeries || !object?.id || price == null) return;

    // Панель уже открыта на этой линии: второй экземпляр не нужен.
    if (this._linePanelState?.objectId === object.id) return;
    this.closeLinePanel();

    const style = object.style || {};
    const initial = {
      color: style.color || "#2196F3",
      lineWidth: style.lineWidth ?? 1,
      lineStyle: style.lineStyle ?? 2,
    };

    const panel = document.createElement("div");
    panel.className = "line-panel";
    panel.setAttribute("role", "toolbar");
    panel.setAttribute("aria-label", "Настройки линии");

    const state = {
      chartId,
      objectId: object.id,
      symbol: object.symbol || chartObj.config.symbol,
      price,
      style: initial,
      popup: null,
      popupEl: null,
      buttons: {},
      anchorX: anchorEvent ? anchorEvent.clientX : null,
      // Кэш последней геометрии: слежение идёт каждый кадр, лишние
      // записи в стили вызывали бы пересчёт раскладки без нужды.
      visibility: null,
      top: null,
      left: null,
    };

    const addButton = (name, title, html, onClick) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "line-panel-btn";
      btn.dataset.act = name;
      btn.title = title;
      btn.innerHTML = html;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      panel.appendChild(btn);
      state.buttons[name] = btn;
      return btn;
    };

    addButton("color", "Цвет", this._lineColorIcon(initial.color),
      () => this._toggleLinePopup("color"));
    addButton("width", "Толщина", this._lineWidthIcon(initial.lineWidth),
      () => this._toggleLinePopup("width"));
    addButton("style", "Стиль линии", this._lineStyleIcon(initial.lineStyle),
      () => this._toggleLinePopup("style"));
    addButton("alert", "Поставить алерт", ALERT_ICON,
      () => this._toggleLineAlert());
    addButton("delete", "Удалить линию", TRASH_ICON,
      () => this._deleteLine());

    const popupEl = document.createElement("div");
    popupEl.className = "line-panel-popup hidden";
    panel.appendChild(popupEl);
    state.popupEl = popupEl;

    this._linePanel = panel;
    this._linePanelState = state;
    document.body.appendChild(panel);

    this._refreshLinePanelButtons();
    this._positionLinePanel();
    this._startLinePanelFollow();
  }

  /** Шестиугольник с текущим цветом: кнопка показывает выбранный цвет. */
  _lineColorIcon(color) {
    return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M8 1.6 13.4 4.6v6.8L8 14.4 2.6 11.4V4.6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
      <circle cx="8" cy="8" r="2.6" fill="${color}"/>
    </svg>`;
  }

  _lineWidthIcon(width) {
    const w = Math.max(1, Math.min(4, Number(width) || 1));
    return `<span class="line-panel-dash" style="height:${w}px"></span>` +
      `<span>${w}px</span>` +
      `<span class="line-panel-dash" style="height:${w}px"></span>`;
  }

  _lineStyleIcon(lineStyle) {
    const dash = lineStyle === 1
      ? ' stroke-dasharray="1.5 2.5" stroke-linecap="round"'
      : lineStyle === 2
        ? ' stroke-dasharray="4 3"'
        : lineStyle === 3
          ? ' stroke-dasharray="5 3 1.5 3"'
          : "";
    return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" stroke-width="1.6"${dash}/>
    </svg>`;
  }

  _lineOptionSample(lineStyle) {
    const cls = lineStyle === 1 ? " dotted" : lineStyle === 2 ? " dashed" : "";
    return `<span class="line-option-sample${cls}"></span>`;
  }

  /** Открыть/закрыть всплывающую таблицу под тулбаром. */
  _toggleLinePopup(kind) {
    const state = this._linePanelState;
    if (!state) return;
    if (state.popup === kind) {
      this._closeLinePopup();
      return;
    }
    state.popup = kind;
    state.popupAnchor = state.buttons[kind] || null;
    this._renderLinePopup();
    this._refreshLinePanelButtons();
    this._positionLinePopup();
  }

  _closeLinePopup() {
    const state = this._linePanelState;
    if (!state) return;
    state.popup = null;
    if (state.popupEl) {
      state.popupEl.classList.add("hidden");
      state.popupEl.innerHTML = "";
    }
    this._refreshLinePanelButtons();
  }

  _renderLinePopup() {
    const state = this._linePanelState;
    if (!state?.popupEl || !state.popup) return;
    const popup = state.popupEl;
    popup.innerHTML = "";
    popup.classList.remove("hidden");

    if (state.popup === "color") {
      const grid = document.createElement("div");
      grid.className = "line-palette";
      const current = (state.style.color || "").toLowerCase();
      for (const color of LINE_PALETTE) {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "line-swatch";
        swatch.dataset.color = color;
        swatch.style.background = color;
        swatch.title = color;
        if (color.toLowerCase() === current) swatch.classList.add("active");
        swatch.addEventListener("click", () => this._applyLineStyleChange({ color }));
        grid.appendChild(swatch);
      }
      // Свой цвет: открывает системную палитру.
      const custom = document.createElement("label");
      custom.className = "line-swatch line-swatch-custom";
      custom.title = "Другой цвет";
      custom.textContent = "+";
      const input = document.createElement("input");
      input.type = "color";
      input.value = state.style.color;
      input.addEventListener("input", () => this._applyLineStyleChange({ color: input.value }));
      custom.appendChild(input);
      grid.appendChild(custom);
      popup.appendChild(grid);
      return;
    }

    const list = document.createElement("div");
    list.className = "line-options";
    if (state.popup === "width") {
      for (const width of LINE_WIDTHS) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "line-option";
        row.dataset.width = String(width);
        if (width === state.style.lineWidth) row.classList.add("active");
        row.innerHTML = `<span class="line-option-mark" style="height:${width}px"></span>` +
          `<span>${width}px</span>`;
        row.addEventListener("click", () => {
          this._applyLineStyleChange({ lineWidth: width });
          this._closeLinePopup();
        });
        list.appendChild(row);
      }
      popup.appendChild(list);
      return;
    }

    for (const option of LINE_STYLES) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "line-option";
      row.dataset.style = String(option.value);
      if (option.value === state.style.lineStyle) row.classList.add("active");
      row.innerHTML = `${this._lineOptionSample(option.value)}<span>${option.label}</span>`;
      row.addEventListener("click", () => {
        this._applyLineStyleChange({ lineStyle: option.value });
        this._closeLinePopup();
      });
      list.appendChild(row);
    }
    popup.appendChild(list);
  }

  /** Подсветка выбранного в уже открытой таблице — без перерисовки. */
  _refreshLinePopup() {
    const state = this._linePanelState;
    if (!state?.popupEl || !state.popup) return;
    if (state.popup === "color") {
      const current = (state.style.color || "").toLowerCase();
      state.popupEl.querySelectorAll(".line-swatch[data-color]").forEach((swatch) => {
        swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === current);
      });
      const input = state.popupEl.querySelector("input[type=color]");
      if (input && document.activeElement !== input) input.value = state.style.color;
    }
  }

  /** Кнопки показывают текущий вид линии и состояние алерта. */
  _refreshLinePanelButtons() {
    const state = this._linePanelState;
    if (!state) return;
    const buttons = state.buttons;
    if (buttons.color) {
      buttons.color.innerHTML = this._lineColorIcon(state.style.color);
      buttons.color.classList.toggle("open", state.popup === "color");
    }
    if (buttons.width) {
      buttons.width.innerHTML = this._lineWidthIcon(state.style.lineWidth);
      buttons.width.classList.toggle("open", state.popup === "width");
    }
    if (buttons.style) {
      buttons.style.innerHTML = this._lineStyleIcon(state.style.lineStyle);
      buttons.style.classList.toggle("open", state.popup === "style");
    }
    if (buttons.alert) {
      const alert = this._lineAlertFor(state);
      buttons.alert.classList.toggle("active", !!alert);
      buttons.alert.title = alert ? "Убрать алерт" : "Поставить алерт";
    }
  }

  /** Алерт этой линии: сначала по объекту, потом по символу и цене. */
  _lineAlertFor(state) {
    const list = Array.from(store.alerts?.values?.() || []);
    const own = list.find((a) => a.object_id === state.objectId);
    if (own) return own;
    const tol = this.m._symbolTol(state.symbol);
    return list.find(
      (a) => a.symbol === state.symbol && a.price != null &&
        Math.abs(a.price - state.price) <= tol
    ) || null;
  }

  /**
   * Применить выбранный вид: одна команда, один шаг отмены.
   *
   * Стиль меняется на сервере, а не только на графике: иначе он не пережил
   * бы перезагрузку и разошёлся бы с линией после следующей синхронизации.
   */
  _applyLineStyleChange(patch) {
    const state = this._linePanelState;
    if (!state) return;
    const obj = store.objects.get(state.objectId);
    // Неизвестные ключи стиля сохраняем: сервер заменяет style целиком.
    const next = { ...(obj?.style || state.style), ...patch };
    state.style = {
      color: next.color || "#2196F3",
      lineWidth: next.lineWidth ?? 1,
      lineStyle: next.lineStyle ?? 2,
    };
    // Настройка линии запоминается: следующая линия рисуется такой же.
    saveLineStyle(state.style);
    this._refreshLinePanelButtons();
    this._refreshLinePopup();
    this._positionLinePopup();
    this.m.sendDrawingCommand({ kind: "object.update", id: state.objectId, style: next });
  }

  _toggleLineAlert() {
    const state = this._linePanelState;
    if (!state) return;
    this._closeLinePopup();
    const alert = this._lineAlertFor(state);
    if (alert) this.m.removeAlert(state.chartId, state.price, state.objectId);
    else this.m.addAlert(state.chartId, state.price);
  }

  _deleteLine() {
    const state = this._linePanelState;
    if (!state) return;
    const id = state.objectId;
    this.closeLinePanel();
    // Алерт сервер удаляет вместе с объектом и возвращает в ответе:
    // без этого он остался бы в store вкладки до перезагрузки.
    this.m.sendDrawingCommand({ kind: "object.delete", id });
  }

  /**
   * Поставить тулбар у линии: по Y — над линией (или под ней, если сверху
   * места нет), по X — на точку клика, с прижатием к краям окна.
   */
  _positionLinePanel() {
    const state = this._linePanelState;
    const panel = this._linePanel;
    if (!state || !panel) return;

    const chartObj = this.m.charts.get(state.chartId);
    if (!chartObj?.mainSeries || !document.body.contains(chartObj.body)) {
      this.closeLinePanel();
      return;
    }
    // Панель живёт только пока линия нарисована: смена символа или
    // раскладки уносит линию с панели, и настройка теряет смысл.
    const line = (chartObj._horizontalLines || []).find(
      (l) => l._objectId === state.objectId
    );
    if (!line) {
      this.closeLinePanel();
      return;
    }

    const rect = chartObj.body.getBoundingClientRect();
    const y = chartObj.mainSeries.priceToCoordinate(state.price);
    // Линия ушла из видимой области: панель прячется, но не закрывается —
    // вернули масштаб, и она снова встанет на своё место.
    if (y == null || Number.isNaN(y) || y < 0 || y > rect.height) {
      if (state.visibility !== "hidden") {
        panel.style.visibility = "hidden";
        state.visibility = "hidden";
      }
      return;
    }

    // Тулбар меряем без поповера: тот позиционирован абсолютно и на
    // высоту панели не влияет.
    const box = panel.getBoundingClientRect();
    const lineY = rect.top + y;
    const gap = 10;
    let top = lineY - box.height - gap;
    if (top < 8) top = lineY + gap;
    const maxTop = Math.max(8, window.innerHeight - box.height - 8);
    const clampedTop = Math.min(Math.max(top, 8), maxTop);

    const left = state.anchorX != null
      ? state.anchorX - box.width / 2
      : rect.left + rect.width / 2 - box.width / 2;
    const maxLeft = Math.max(8, window.innerWidth - box.width - 8);
    const clampedLeft = Math.min(Math.max(left, 8), maxLeft);

    // Цикл слежения идёт каждый кадр, а меняются координаты далеко не
    // всегда: без сравнения мы бы дёргали раскладку 60 раз в секунду.
    if (state.visibility !== "visible") {
      panel.style.visibility = "visible";
      state.visibility = "visible";
    }
    const roundedTop = Math.round(clampedTop);
    const roundedLeft = Math.round(clampedLeft);
    if (state.top !== roundedTop) {
      panel.style.top = `${roundedTop}px`;
      state.top = roundedTop;
    }
    if (state.left !== roundedLeft) {
      panel.style.left = `${roundedLeft}px`;
      state.left = roundedLeft;
    }
  }

  /**
   * Поповер открывается под тулбаром; если снизу нет места — над ним,
   * а по горизонтали сдвигается, чтобы не выйти за окно.
   */
  _positionLinePopup() {
    const state = this._linePanelState;
    const panel = this._linePanel;
    const popup = state?.popupEl;
    if (!state || !panel || !popup || !state.popup) return;

    // Таблица встаёт левым краем по своей кнопке: так видно, какая настройка
    // открыта, и палитра не уезжает от тулбара на узких окнах.
    popup.style.left = `${state.popupAnchor?.offsetLeft ?? 0}px`;
    popup.style.transform = "none";
    popup.classList.remove("above");

    const box = popup.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8 && panelBox.top - box.height - 6 > 8) {
      popup.classList.add("above");
    }

    const shifted = popup.getBoundingClientRect();
    let shift = 0;
    if (shifted.left < 8) shift = 8 - shifted.left;
    else if (shifted.right > window.innerWidth - 8) shift = window.innerWidth - 8 - shifted.right;
    if (shift) popup.style.transform = `translateX(${shift}px)`;
    // Размер окна запоминаем: при ресайзе поповер надо прижать заново.
    state.popupWin = `${window.innerWidth}x${window.innerHeight}`;
  }

  /** Пока панель открыта, её Y пересчитывается каждый кадр: так она едет
   *  за линией при зуме, панораме, автоскейле и ресайзе панели графика. */
  _startLinePanelFollow() {
    if (this._linePanelRaf) return;
    const tick = () => {
      if (!this._linePanel) {
        this._linePanelRaf = 0;
        return;
      }
      this._positionLinePanel();
      if (!this._linePanel) {
        this._linePanelRaf = 0;
        return;
      }
      // Поповер стоит внутри тулбара и едет вместе с ним; пересчитывать его
      // каждый кадр незачем — только когда изменился размер окна.
      const state = this._linePanelState;
      if (state?.popup && state.popupWin !== `${window.innerWidth}x${window.innerHeight}`) {
        this._positionLinePopup();
      }
      this._linePanelRaf = requestAnimationFrame(tick);
    };
    this._linePanelRaf = requestAnimationFrame(tick);
  }

  closeLinePanel() {
    if (this._linePanel) this._linePanel.remove();
    if (this._linePanelRaf) cancelAnimationFrame(this._linePanelRaf);
    this._linePanel = null;
    this._linePanelState = null;
    this._linePanelRaf = 0;
  }

  _initLinePanelGlobal() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this._linePanel) return;
      e.preventDefault();
      this.closeLinePanel();
    });

    document.addEventListener("pointerdown", (e) => {
      if (!this._linePanel) return;
      if (e.target instanceof Element && e.target.closest(".line-panel")) return;
      this.closeLinePanel();
    }, true);
  }

  /** Панель показывает то, что лежит в store: источник истины — сервер. */
  _syncLinePanelState() {
    const state = this._linePanelState;
    if (!state) return;
    const obj = store.objects.get(state.objectId);
    if (!obj) {
      this.closeLinePanel();
      return;
    }
    const style = obj.style || {};
    state.style = {
      color: style.color || "#2196F3",
      lineWidth: style.lineWidth ?? 1,
      lineStyle: style.lineStyle ?? 2,
    };
    if (obj.data?.price != null) state.price = obj.data.price;
    this._refreshLinePanelButtons();
    this._refreshLinePopup();
  }

  _initLinePanelStore() {
    // Своя команда тоже приходит этим событием: панель просто показывает
    // новый вид. Отмена и повтор обновляют её так же — черновика больше нет,
    // спорить с историей нечему.
    store.on("objects", () => {
      if (!this._linePanelState) return;
      this._syncLinePanelState();
      this._positionLinePanel();
    });

    store.on("alerts", () => {
      if (!this._linePanelState) return;
      this._refreshLinePanelButtons();
    });
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
      this.m.setActiveChart(id);
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

    // делегированный клик на списке: переживает innerHTML="" в refreshAllSymbolDropdowns
    list.addEventListener("click", (e) => {
      const item = e.target.closest(".ch-symbol-item");
      if (!item) return;
      const ticker = item.dataset.ticker;
      const source = item.dataset.source;
      symbolBtn.textContent = ticker;
      symbolDropdown.classList.add("hidden");
      this.m.setActiveChart(id);
      this.m.changeSymbol(ticker, source, id);
    });

    const tfContainer = document.createElement("div");
    tfContainer.className = "ch-tf-buttons";
    TIMEFRAMES.forEach(t => {
      const btn = document.createElement("button");
      btn.className = "ch-tf-btn" + (t.tf === (cfg.timeframe || "1h") ? " active" : "");
      btn.textContent = t.label;
      btn.dataset.tf = t.tf;
      btn.addEventListener("click", () => {
        this.m.setActiveChart(id);
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
      this.m.setActiveChart(id);
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
      this.m.setActiveChart(id);
      this.showIndicatorModal(id);
    });
    indContainer.appendChild(addIndBtn);

    header.appendChild(symbolBtn);
    header.appendChild(tfContainer);
    header.appendChild(typeSelect);
    header.appendChild(indContainer);

    return header;
  }

  showChartSettings(id) {
    const chartObj = this.m.charts.get(id);
    if (!chartObj) return;
    const settings = this.m._getChartSettings();

    const defaults = CHART_SETTINGS_DEFAULTS;
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
      this.m._saveChartSettings(newSettings);
      // Оформление одно на весь терминал: меняем все панели сразу.
      this.m.applyChartSettingsToAll(newSettings);
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
        this.m.setActiveChart(chartId);
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
      nameInput.placeholder = type.label;
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
        const name = nameInput.value.trim() || typeName;
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
    const tooltip = document.createElement("div");
    tooltip.className = "candle-tooltip hidden";
    body.appendChild(tooltip);

    const fmtPrice = (v) => (v == null || isNaN(v)) ? "-" : Number(v).toFixed(2);

    chartObj.chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData) {
        tooltip.classList.add("hidden");
        return;
      }
      const data = param.seriesData.get(chartObj.mainSeries);
      if (!data || typeof data !== "object" || !("open" in data)) {
        tooltip.classList.add("hidden");
        return;
      }
      const timeStr = (typeof param.time === "object")
        ? `${String(param.time.year)}-${String(param.time.month).padStart(2,"0")}-${String(param.time.day).padStart(2,"0")}`
        : new Date(param.time * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
      const dir = data.close >= data.open;
      tooltip.innerHTML = `
        <div class="ct-title">${timeStr} <span class="ct-dir ${dir ? 'up' : 'down'}">${dir ? '▲' : '▼'}</span></div>
        <div class="ct-row"><span>Откр</span><b>${fmtPrice(data.open)}</b></div>
        <div class="ct-row"><span>Макс</span><b>${fmtPrice(data.high)}</b></div>
        <div class="ct-row"><span>Мин</span><b>${fmtPrice(data.low)}</b></div>
        <div class="ct-row"><span>Закр</span><b>${fmtPrice(data.close)}</b></div>
        ${data.volume !== undefined ? `<div class="ct-row"><span>Объём</span><b>${data.volume}</b></div>` : ""}
      `;
      tooltip.classList.remove("hidden");
      tooltip.style.left = (this._ttX || 20) + "px";
      tooltip.style.top = (this._ttY || 20) + "px";
    });

    const onTooltipMove = (e) => {
      const rect = body.getBoundingClientRect();
      this._ttX = e.clientX - rect.left + 16;
      this._ttY = e.clientY - rect.top + 16;
      if (tooltip.classList.contains("hidden")) return;
      tooltip.style.left = this._ttX + "px";
      tooltip.style.top = this._ttY + "px";
    };
    body.addEventListener("mousemove", onTooltipMove);

    // Рисование ведётся через реестр инструментов: chart-ui не знает
    // ни про одну конкретную фигуру, новый инструмент добавляется рядом.
    const activeTool = () => getTool(this.m._activeTool);

    const toolContext = (event, chartIdLocal) => {
      const idx = this.m.getAllChartIds().indexOf(chartIdLocal);
      const hlines = store.objects
        ? Array.from(store.objects.values()).filter(
            (o) => o.kind === "hline" && o.symbol === chartObj.config.symbol
          )
        : [];
      // Автоуровни сканера: цена каждого лежит в своём поле данных,
      // поэтому инструментам нужен отдельный список.
      const levels = store.objects
        ? Array.from(store.objects.values()).filter(
            (o) => o.kind === "auto_level" && o.symbol === chartObj.config.symbol
          )
        : [];
      return {
        chartObj,
        chartId: chartIdLocal,
        chartIndex: idx < 0 ? 0 : idx,
        event,
        hlines,
        levels,
        priceTolerance: this.m._priceTol(chartObj),
        magnetOn: !!this.m._magnetOn,
        hitHLine: () => {
          const point = eventToLocal(chartObj, event);
          return point ? hitHLine(chartObj, hlines, point) : null;
        },
        hitLevel: () => {
          const point = eventToLocal(chartObj, event);
          return point ? hitLevel(chartObj, levels, point) : null;
        },
        // Инструмент вернул созданный сервером объект: панель настройки
        // открывается сразу, как у источника после отрисовки.
        onObjectCreated: (obj, ev) => this.showLineSettingsPanel(chartIdLocal, obj, ev),
        send: (payload) => this.m.sendDrawingCommand(payload)
      };
    };

    const onToolPointerDown = (e) => {
      const tool = activeTool();
      if (!tool || tool.passive) return;
      if (typeof tool.onPointerDown === "function") {
        e.stopPropagation();
        // Одноразовые инструменты снимают себя после действия — иначе
        // режим рисования залипает. Стиралка и магнит залипают намеренно,
        // поэтому сброс зависит от флага oneShot у инструмента.
        Promise.resolve(tool.onPointerDown(toolContext(e, id)))
          .catch((err) => console.error("[Drawings] инструмент упал:", err))
          .finally(() => { if (tool.oneShot) this.m.resetTool?.(); });
      }
    };

    const onToolPointerMove = (e) => {
      const tool = activeTool();
      if (!tool || typeof tool.onPointerMove !== "function") return;
      tool.onPointerMove(toolContext(e, id));
    };

    const onToolPointerUp = (e) => {
      const tool = activeTool();
      if (!tool || typeof tool.onPointerUp !== "function") return;
      tool.onPointerUp(toolContext(e, id));
    };

    // Клик по готовой линии открывает тулбар настройки, как у источника.
    // Работает только с курсором: при рисовании и ластике нажатие занято
    // инструментом, и панель открылась бы вместо действия.
    let lineDown = null;
    const onLinePointerDown = (e) => {
      lineDown = e.button === 0 && this.m._activeTool === "crosshair"
        ? { x: e.clientX, y: e.clientY }
        : null;
    };
    const onLinePointerUp = (e) => {
      const down = lineDown;
      lineDown = null;
      if (!down || e.button !== 0) return;
      // Протаскивание графика панель не открывает: только чистый клик.
      if (Math.abs(e.clientX - down.x) > 5 || Math.abs(e.clientY - down.y) > 5) return;
      const point = eventToLocal(chartObj, e);
      if (!point) return;
      const hlines = Array.from(store.objects?.values() || []).filter(
        (o) => o.kind === "hline" && o.symbol === chartObj.config.symbol
      );
      const hit = hitHLine(chartObj, hlines, point);
      if (hit) this.showLineSettingsPanel(id, hit.object, e);
    };
    body.addEventListener("pointerdown", onLinePointerDown, true);
    body.addEventListener("pointerup", onLinePointerUp, true);

    body.addEventListener("pointerdown", onToolPointerDown, true);
    body.addEventListener("pointermove", onToolPointerMove, true);
    body.addEventListener("pointerup", onToolPointerUp, true);

    chartObj._boundListeners = [
      { target: body, handler: onLinePointerDown, capture: true },
      { target: body, handler: onLinePointerUp, capture: true },
      { target: body, handler: onToolPointerDown, capture: true },
      { target: body, handler: onToolPointerMove, capture: true },
      { target: body, handler: onToolPointerUp, capture: true },
      { target: body, handler: onTooltipMove, capture: false },
    ];

    body.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const point = eventToLocal(chartObj, e);
      const hlines = Array.from(store.objects?.values() || []).filter(
        (o) => o.kind === "hline" && o.symbol === chartObj.config.symbol
      );
      const levels = Array.from(store.objects?.values() || []).filter(
        (o) => o.kind === "auto_level" && o.symbol === chartObj.config.symbol
      );
      const target = point ? (hitHLine(chartObj, hlines, point) || hitLevel(chartObj, levels, point)) : null;
      if (target) {
        this.showContextMenu(e, id, target.object, target);
      }
    });

    const gearBtn = document.createElement("button");
    gearBtn.className = "chart-settings-btn";
    gearBtn.textContent = "⚙";
    gearBtn.title = "Настройки графика";
    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.m.setActiveChart(id);
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
