// Рукоятки ресайза дорожек сетки панелей.
//
// Границы рисуются не по всей высоте или ширине сетки, а только там,
// где слева и справа стоят разные клетки: иначе линия резала бы панель,
// которая занимает две колонки или две строки. Живой preview — локальный
// CSS, коммит идёт одной командой layout.resize только на отпускании.
import { placeCells, MIN_TRACK_PX } from "./layout-grid.js";

const HANDLE_PX = 7;
// Полоса вокруг вертикальной границы, где горизонтальная рукоятка
// не рисуется: в точке пересечения клик отдаётся вертикальной.
const CUT_PX = HANDLE_PX / 2 + 2;

export class LayoutResizer {
  constructor(manager, grid) {
    this.m = manager;
    this.grid = grid;
    this._drag = null;

    this.layer = document.createElement("div");
    this.layer.className = "layout-resize-layer";
    grid.appendChild(this.layer);

    // Панель может измениться и без перестройки грида: смена окна,
    // боковая панель, перезагрузка графика.
    this._observer = new ResizeObserver(() => this.refresh());
    this._observer.observe(grid);

    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    this._onKeyDown = (e) => {
      if (e.key === "Escape" && this._drag) this._cancelDrag();
    };
    this.layer.addEventListener("pointerdown", this._onPointerDown);
    document.addEventListener("pointermove", this._onPointerMove);
    document.addEventListener("pointerup", this._onPointerUp);
    document.addEventListener("pointercancel", this._onPointerUp);
    document.addEventListener("keydown", this._onKeyDown);
  }

  destroy() {
    this._observer.disconnect();
    this.layer.removeEventListener("pointerdown", this._onPointerDown);
    document.removeEventListener("pointermove", this._onPointerMove);
    document.removeEventListener("pointerup", this._onPointerUp);
    document.removeEventListener("pointercancel", this._onPointerUp);
    document.removeEventListener("keydown", this._onKeyDown);
    this.layer.remove();
  }

  /** Перестроить рукоятки под текущую геометрию. */
  refresh() {
    const layout = this.m.currentLayout;
    const panels = this.m._panelChildren();
    if (!layout || !layout.cells || panels.length < 2) {
      this.layer.innerHTML = "";
      return;
    }
    const placements = placeCells(
      layout.rows, layout.cols, layout.cells, panels.length
    );
    if (!placements.length) return;

    const colPx = readTracks(this.grid, "col");
    const rowPx = readTracks(this.grid, "row");
    if (!colPx.length || !rowPx.length) return;
    const gap = gapPx(this.grid);

    const specs = [];
    const colXs = [];
    for (let c = 1; c < layout.cols; c++) {
      const bx = boundaryX(colPx, gap, c);
      colXs.push(bx);
      for (const seg of boundarySegments(placements, layout.rows, c, "col")) {
        specs.push({
          axis: "col", index: c - 1,
          key: `col:${c - 1}:${Math.round(bx)}:${Math.round(segStart(rowPx, gap, seg[0]))}`,
          left: bx - HANDLE_PX / 2, top: segStart(rowPx, gap, seg[0]),
          width: HANDLE_PX, height: segLength(rowPx, gap, seg),
        });
      }
    }
    for (let r = 1; r < layout.rows; r++) {
      for (const seg of boundarySegments(placements, layout.cols, r, "row")) {
        const y = boundaryY(rowPx, gap, r);
        const x0 = segStart(colPx, gap, seg[0]);
        const x1 = x0 + segLength(colPx, gap, seg);
        // Горизонтальную рукоятку режем вокруг вертикальных границ: в
        // точке пересечения приоритет у вертикальной, иначе клик
        // попадал на случайную из двух.
        const cuts = colXs.filter((bx) => bx > x0 + CUT_PX && bx < x1 - CUT_PX)
          .map((bx) => [bx - CUT_PX, bx + CUT_PX]);
        for (const [px0, px1] of subtractRanges(x0, x1, cuts)) {
          specs.push({
            axis: "row", index: r - 1,
            key: `row:${r - 1}:${Math.round(px0)}:${Math.round(y)}`,
            left: px0, top: y - HANDLE_PX / 2,
            width: px1 - px0, height: HANDLE_PX,
          });
        }
      }
    }

    // Перетаскиваемую рукоятку не трогаем: элемент живой, с ним связан
    // pointer capture, и пересоздание оборвало бы drag.
    for (const el of Array.from(this.layer.children)) {
      if (el === this._drag?.handle) continue;
      const spec = specs.find((s) => s.key === el.dataset.handle);
      if (!spec) {
        el.remove();
      } else {
        positionHandle(el, spec);
      }
    }
    for (const spec of specs) {
      if (this.layer.querySelector(`[data-handle="${spec.key}"]`)) continue;
      if (this._drag && this._drag.axis === spec.axis &&
          this._drag.index === spec.index) continue;
      this.layer.appendChild(createHandle(spec));
    }
  }

  _pointerDown(e) {
    const handle = e.target.closest(".layout-resize-handle");
    if (!handle || this._drag) return;
    e.preventDefault();
    e.stopPropagation();
    const tracks = readTracks(this.grid, handle.dataset.axis);
    const index = Number(handle.dataset.index);
    if (!tracks.length || index + 1 >= tracks.length) return;
    this._drag = {
      axis: handle.dataset.axis,
      index,
      handle,
      pointerId: e.pointerId,
      start: handle.dataset.axis === "col" ? e.clientX : e.clientY,
      tracks: tracks.slice(),
      moved: false,
    };
    handle.classList.add("dragging");
    document.body.classList.add("layout-resizing");
    try { handle.setPointerCapture(e.pointerId); } catch (_err) { /* нет поддержки — drag всё равно идёт по document */ }
  }

  _pointerMove(e) {
    const d = this._drag;
    if (!d) return;
    const pos = d.axis === "col" ? e.clientX : e.clientY;
    const delta = pos - d.start;
    if (!d.moved && Math.abs(delta) < 2) return;
    d.moved = true;
    const i = d.index;
    const total = d.tracks[i] + d.tracks[i + 1];
    // Обе соседние дорожки обязаны остаться не меньше MIN_TRACK_PX.
    let a = d.tracks[i] + delta;
    a = Math.max(MIN_TRACK_PX, Math.min(total - MIN_TRACK_PX, a));
    const next = d.tracks.slice();
    next[i] = a;
    next[i + 1] = total - a;
    this.m.setTrackSizes(d.axis, next);
  }

  _pointerUp(e) {
    const d = this._drag;
    if (!d) return;
    this._finishDrag(d, false);
    if (d.moved) {
      // Размеры уже лежат в currentLayout после preview; коммитим их.
      this.m.commitTrackSizes(d.axis, currentSizes(this.m, d.axis));
    }
  }

  _cancelDrag() {
    const d = this._drag;
    if (!d) return;
    this._finishDrag(d, true);
  }

  _finishDrag(d, revert) {
    this._drag = null;
    d.handle.classList.remove("dragging");
    document.body.classList.remove("layout-resizing");
    if (d.handle.hasPointerCapture?.(d.pointerId)) {
      try { d.handle.releasePointerCapture(d.pointerId); } catch (_err) { /* уже отпущен */ }
    }
    if (revert) {
      this.m.setTrackSizes(d.axis, d.tracks);
    } else {
      this.m.applyLayout();
    }
  }
}

/** Пиксельные размеры дорожек грида: computed style отдаёт px даже для fr. */
function readTracks(grid, axis) {
  const style = getComputedStyle(grid);
  const text = axis === "col" ? style.gridTemplateColumns : style.gridTemplateRows;
  if (!text || text === "none") return [];
  return text.split(/\s+/)
    .map((part) => parseFloat(part))
    .filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * Отрезки границы: строки (для вертикальной границы) или колонки
 * (для горизонтальной), в которых слева и справа стоят разные клетки.
 * Соседние индексы склеиваются в один отрезок.
 */
function boundarySegments(placements, lines, boundary, axis) {
  const hits = [];
  for (let line = 0; line < lines; line++) {
    const before = placements.some((p) =>
      axis === "col"
        ? p.col + p.colSpan === boundary && line >= p.row && line < p.row + p.rowSpan
        : p.row + p.rowSpan === boundary && line >= p.col && line < p.col + p.colSpan
    );
    const after = placements.some((p) =>
      axis === "col"
        ? p.col === boundary && line >= p.row && line < p.row + p.rowSpan
        : p.row === boundary && line >= p.col && line < p.col + p.colSpan
    );
    if (before && after) hits.push(line);
  }
  const segments = [];
  for (const line of hits) {
    const last = segments[segments.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else segments.push([line, line]);
  }
  return segments;
}

/** Вычесть отрезки cuts из [start, end]: остаток списком отрезков. */
function subtractRanges(start, end, cuts) {
  const sorted = cuts.slice().sort((x, y) => x[0] - y[0]);
  const ranges = [];
  let cursor = start;
  for (const [a, b] of sorted) {
    if (a > cursor + 1) ranges.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (end > cursor + 1) ranges.push([cursor, end]);
  return ranges;
}

/** X середины зазора между колонкой boundary-1 и boundary. */
function boundaryX(colPx, gap, boundary) {
  let x = 0;
  for (let i = 0; i < boundary; i++) x += colPx[i];
  return x + gap * (boundary - 1) + gap / 2;
}

/** Y середины зазора между строкой boundary-1 и boundary. */
function boundaryY(rowPx, gap, boundary) {
  let y = 0;
  for (let i = 0; i < boundary; i++) y += rowPx[i];
  return y + gap * (boundary - 1) + gap / 2;
}

function segStart(px, gap, first) {
  let start = 0;
  for (let i = 0; i < first; i++) start += px[i];
  return start + gap * first;
}

function segLength(px, gap, seg) {
  let length = 0;
  for (let i = seg[0]; i <= seg[1]; i++) length += px[i];
  return length + gap * (seg[1] - seg[0]);
}

/** Зазор между дорожками: он же участвует в геометрии границ. */
function gapPx(grid) {
  const value = parseFloat(getComputedStyle(grid).columnGap);
  return Number.isFinite(value) && value > 0 ? value : 2;
}

function createHandle(spec) {
  const el = document.createElement("div");
  el.className = `layout-resize-handle ${spec.axis === "col" ? "col" : "row"}`;
  el.dataset.axis = spec.axis;
  el.dataset.index = String(spec.index);
  el.dataset.handle = spec.key;
  el.title = spec.axis === "col" ? "Изменить ширину колонок" : "Изменить высоту строк";
  positionHandle(el, spec);
  return el;
}

function positionHandle(el, spec) {
  el.style.left = `${spec.left}px`;
  el.style.top = `${spec.top}px`;
  el.style.width = `${spec.width}px`;
  el.style.height = `${spec.height}px`;
}

/** Текущие веса дорожек из состояния — именно их шлёт коммит. */
function currentSizes(manager, axis) {
  const layout = manager.currentLayout;
  return axis === "col" ? layout.col_sizes.slice() : layout.row_sizes.slice();
}
