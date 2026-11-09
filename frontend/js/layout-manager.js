import { equalSizes, sameCells, placeCells, MIN_TRACK_PX } from "./layout-grid.js";
import { LayoutResizer } from "./layout-resize.js";

const LAYOUTS = {
  1: [
    { rows: 1, cols: 1, cells: [[1, 1]] },
  ],
  2: [
    { rows: 1, cols: 2, cells: [[1, 1], [1, 1]] },
    { rows: 2, cols: 1, cells: [[1, 1], [1, 1]] },
  ],
  3: [
    { rows: 1, cols: 3, cells: [[1, 1], [1, 1], [1, 1]] },
    { rows: 2, cols: 2, cells: [[1, 1], [1, 1], [1, 2]] },
    { rows: 2, cols: 2, cells: [[1, 2], [1, 1], [1, 1]] },
    // Слева один высокий график, справа два друг под другом.
    { rows: 2, cols: 2, cells: [[2, 1], [1, 1], [1, 1]] },
    // Зеркально: слева два друг под другом, справа один высокий.
    { rows: 2, cols: 2, cells: [[1, 1], [2, 1], [1, 1]] },
  ],
  4: [
    { rows: 2, cols: 2, cells: [[1, 1], [1, 1], [1, 1], [1, 1]] },
  ],
  6: [
    { rows: 2, cols: 3, cells: [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]] },
  ],
  9: [
    { rows: 3, cols: 3, cells: [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]] },
  ],
  12: [
    { rows: 4, cols: 3, cells: [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]] },
    // Второй вариант — шире и ниже: на широком мониторе панели читаются
    // лучше, чем при делении на три колонки.
    { rows: 3, cols: 4, cells: [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]] },
  ],
};

export { MIN_TRACK_PX };

export class LayoutManager {
  constructor(gridElement, opts = {}) {
    this.grid = gridElement;
    this.currentLayout = { rows: 1, cols: 1, cells: [[1, 1]],
      col_sizes: [1], row_sizes: [1] };
    this.currentOptionIndex = 0;
    // Вызывается при отпускании рукоятки ресайза: живой preview —
    // локальный CSS, а коммит должен идти одной командой на сервер.
    this.onResizeCommit = opts.onResizeCommit || null;
    this.resizer = new LayoutResizer(this, gridElement);
  }

  getLayouts() {
    return LAYOUTS;
  }

  /**
   * Сетка варианта: сколько панелей и как они расположены.
   *
   * Сетка уезжает в состояние раскладки, поэтому отдаётся копией —
   * иначе правка состояния испортила бы таблицу вариантов.
   */
  gridFor(count, optionIndex = 0) {
    const variants = LAYOUTS[count];
    if (!variants) return null;
    const layout = variants[Math.min(optionIndex, variants.length - 1)];
    if (!layout) return null;
    return {
      count,
      rows: layout.rows,
      cols: layout.cols,
      cells: layout.cells.map((cell) => [...cell]),
      col_sizes: equalSizes(layout.cols),
      row_sizes: equalSizes(layout.rows),
    };
  }

  /**
   * Вариант сетки для выпадающего списка: по числу панелей и размеру.
   *
   * Сетка приходит из состояния, а варианты живут в таблице клиента,
   * поэтому вариант находится сопоставлением клеток. Размеры дорожек
   * на выбор варианта не влияют: их пользователь меняет ресайзом.
   */
  optionForGrid(grid) {
    if (!grid) return 0;
    const variants = LAYOUTS[grid.count] || [];
    const index = variants.findIndex(
      (v) => v.rows === grid.rows && v.cols === grid.cols &&
        sameCells(v.cells, grid.cells)
    );
    if (index >= 0) return index;
    // Старое состояние без точного совпадения клеток: определяем
    // вариант по размеру, как раньше, вместо сброса на первый.
    const legacy = variants.findIndex(
      (v) => v.rows === grid.rows && v.cols === grid.cols
    );
    return legacy < 0 ? 0 : legacy;
  }

  /** Применить сетку из состояния раскладки. */
  applyGrid(grid) {
    if (!grid || !grid.rows || !grid.cols || !Array.isArray(grid.cells)) return;
    const cols = Math.max(1, Number(grid.cols) || 1);
    const rows = Math.max(1, Number(grid.rows) || 1);
    this.currentLayout = {
      rows,
      cols,
      cells: grid.cells,
      col_sizes: this._cleanSizes(grid.col_sizes, cols),
      row_sizes: this._cleanSizes(grid.row_sizes, rows),
    };
    this.currentOptionIndex = this.optionForGrid(grid);
    this.applyLayout();
  }

  setLayoutByCount(count, optionIndex = 0) {
    const layouts = LAYOUTS[count];
    if (!layouts || optionIndex >= layouts.length) return;

    const layout = layouts[optionIndex];
    // Смена варианта — новая геометрия, размеры дорожек сбрасываются.
    this.currentLayout = {
      rows: layout.rows,
      cols: layout.cols,
      cells: layout.cells,
      col_sizes: equalSizes(layout.cols),
      row_sizes: equalSizes(layout.rows),
    };
    this.currentOptionIndex = optionIndex;

    const children = this._panelChildren();
    children.forEach(child => {
      child.style.gridRow = '';
      child.style.gridColumn = '';
      child.style.width = '';
      child.style.height = '';
    });

    this.applyLayout();
  }

  applyLayout() {
    const layout = this.currentLayout;
    const children = this._panelChildren();
    if (!layout || children.length === 0) return;

    if (children.length === 1) {
      this.grid.style.display = 'block';
      this.grid.style.gridTemplateColumns = '';
      this.grid.style.gridTemplateRows = '';
      this.grid.style.gap = '';
      children[0].style.gridRow = '';
      children[0].style.gridColumn = '';
      this.resizer?.refresh();
      return;
    }

    this.grid.style.display = 'grid';
    this.grid.style.gap = '2px';
    this.grid.style.gridTemplateColumns =
      layout.col_sizes.map((s) => `${s}fr`).join(' ');
    this.grid.style.gridTemplateRows =
      layout.row_sizes.map((s) => `${s}fr`).join(' ');

    // Клетка может накрывать несколько строк или колонок, поэтому
    // размещение идёт по первой свободной клетке, а не построчно.
    const placements = placeCells(
      layout.rows, layout.cols, layout.cells, children.length
    );
    placements.forEach((p, i) => {
      children[i].style.gridRow = `${p.row + 1} / span ${p.rowSpan}`;
      children[i].style.gridColumn = `${p.col + 1} / span ${p.colSpan}`;
    });

    this.resizer?.refresh();
  }

  /** Панели грида: слой ресайза не панель и в расчётах не участвует. */
  _panelChildren() {
    return Array.from(this.grid.children).filter(
      (el) => el.classList.contains("chart-wrapper")
    );
  }

  /**
   * Живой preview во время drag: пиксельные размеры переводятся в веса,
   * геометрия пересобирается, на сервер ничего не шлётся.
   */
  setTrackSizes(axis, sizes) {
    const layout = this.currentLayout;
    if (!layout) return;
    if (axis === "col") {
      layout.col_sizes = this._cleanSizes(sizes, layout.cols);
    } else {
      layout.row_sizes = this._cleanSizes(sizes, layout.rows);
    }
    this.applyLayout();
  }

  /**
   * Коммит размеров: одна команда, один шаг отмены. Живой preview
   * до этого момента был только локальным CSS.
   */
  commitTrackSizes(axis, sizes) {
    if (!this.onResizeCommit) return;
    const payload = axis === "col"
      ? { col_sizes: sizes }
      : { row_sizes: sizes };
    this.onResizeCommit(payload);
  }

  autoLayout(chartCount) {
    // Число панелей совпало — сетку не трогаем: иначе сбросился бы
    // выбранный пользователем вариант (две панели рядом или столбом).
    if (this.currentLayout && (this.currentLayout.cells || []).length === chartCount) {
      this.applyLayout();
      return;
    }
    if (chartCount <= 1) {
      this.setLayoutByCount(1, 0);
    } else if (chartCount <= 2) {
      this.setLayoutByCount(2, 0);
    } else if (chartCount <= 3) {
      this.setLayoutByCount(3, 0);
    } else if (chartCount <= 4) {
      this.setLayoutByCount(4, 0);
    } else if (chartCount <= 6) {
      this.setLayoutByCount(6, 0);
    } else if (chartCount <= 9) {
      this.setLayoutByCount(9, 0);
    } else {
      this.setLayoutByCount(12, 0);
    }
  }

  /** Весы дорожек из состояния; неверные заменяются равными. */
  _cleanSizes(value, n) {
    if (!Array.isArray(value) || value.length !== n) return equalSizes(n);
    const nums = value.map(Number);
    if (nums.some((v) => !Number.isFinite(v) || v <= 0)) return equalSizes(n);
    const total = nums.reduce((a, b) => a + b, 0);
    if (total <= 0) return equalSizes(n);
    return nums.map((v) => v / total);
  }
}
