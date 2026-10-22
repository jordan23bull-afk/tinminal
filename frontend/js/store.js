// Зеркало состояния на клиенте.
//
// Сервер — источник истины. Здесь держим копию, чтобы интерфейсу не ждать
// сеть при каждом чтении, и раздаём подписчикам изменения.

class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this._handlers.get(event) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[Store] подписчик ${event} упал:`, err);
      }
    }
  }
}

class Store extends Emitter {
  constructor() {
    super();
    this.layoutId = null;
    this.layout = null;
    this.objects = new Map();
    this.alerts = new Map();
    this.canUndo = false;
    this.canRedo = false;
    this.online = false;
  }

  reset() {
    this.layoutId = null;
    this.layout = null;
    this.objects.clear();
    this.alerts.clear();
    this.canUndo = false;
    this.canRedo = false;
  }

  applyStateSync(payload) {
    if (!payload) return;
    if (payload.layout) this.layout = payload.layout;
    if (payload.layout) this.layoutId = payload.layout.id;
    this.objects = new Map((payload.objects || []).map((o) => [o.id, o]));
    this.alerts = new Map((payload.alerts || []).map((a) => [a.id, a]));
    this.canUndo = !!payload.can_undo;
    this.canRedo = !!payload.can_redo;
    // Полная синхронизация меняет и графики: после отмены именно она
    // возвращает их к прежнему виду. Вкладки не получают изменений друг
    // друга, поэтому этот снимок — единственный источник обновления.
    //
    // Снимок с сервера — отдельное событие: на свои изменения вкладка
    // реагировать не должна. Реакция замыкалась в кольцо — панель
    // расходилась с записью в пуле, обработчик звал changeSymbol, тот
    // менял все панели разом, и расхождение возникало снова.
    this.emit("layout", this.layout);
    this.emit("stateCharts", this.charts());
    this.emit("objects", Array.from(this.objects.values()));
    this.emit("alerts", Array.from(this.alerts.values()));
    this.emit("history", { canUndo: this.canUndo, canRedo: this.canRedo });
    this.emit("sync", this.snapshot());
  }

  snapshot() {
    return {
      layoutId: this.layoutId,
      layout: this.layout,
      objects: Array.from(this.objects.values()),
      alerts: Array.from(this.alerts.values()),
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      online: this.online,
    };
  }

  setOnline(value) {
    if (this.online === value) return;
    this.online = value;
    this.emit("connection", { online: value });
  }

  chart(index) {
    const charts = (this.layout?.state?.charts) || [];
    return charts[index] || {};
  }

  charts() {
    return this.layout?.state?.charts || [];
  }

  chartCount() {
    return this.charts().length;
  }

  // --- обработка событий от сервера ---

  putObject(obj) {
    if (!obj || !obj.id) return;
    this.objects.set(obj.id, obj);
    this.emit("objects", Array.from(this.objects.values()));
  }

  dropObject(id) {
    if (this.objects.delete(id)) {
      for (const [aid, alert] of this.alerts) {
        if (alert.object_id === id) this.alerts.delete(aid);
      }
      this.emit("objects", Array.from(this.objects.values()));
    }
  }

  putAlert(alert) {
    if (!alert || !alert.id) return;
    this.alerts.set(alert.id, alert);
    this.emit("alerts", Array.from(this.alerts.values()));
  }

  dropAlert(alert) {
    const id = typeof alert === "string" ? alert : alert?.id;
    if (id && this.alerts.delete(id)) {
      this.emit("alerts", Array.from(this.alerts.values()));
    }
  }

  setChartField(index, field, value) {
    if (!this.layout) return;
    const charts = this.layout.state.charts || (this.layout.state.charts = []);
    while (charts.length <= index) charts.push({});
    charts[index] = { ...charts[index], [field]: value };
    // Своё изменение: графики трогать нельзя, они уже в нужном виде.
    // На него подписан только панель инструментов.
    this.emit("charts", charts);
  }

  setHistoryState(canUndo, canRedo) {
    this.canUndo = !!canUndo;
    this.canRedo = !!canRedo;
    this.emit("history", { canUndo: this.canUndo, canRedo: this.canRedo });
  }

  resetHistoryState() {
    this.setHistoryState(false, false);
  }
}

export const store = new Store();