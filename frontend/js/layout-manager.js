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

export class LayoutManager {
  constructor(gridElement) {
    this.grid = gridElement;
    this.currentLayout = { rows: 1, cols: 1, cells: [[1, 1]] };
    this.currentOptionIndex = 0;
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
    };
  }

  /**
   * Вариант сетки для выпадающего списка: по числу панелей и размеру.
   *
   * Сетка приходит из состояния, а варианты живут в таблице клиента,
   * поэтому вариант находится сопоставлением.
   */
  optionForGrid(grid) {
    if (!grid) return 0;
    const variants = LAYOUTS[grid.count] || [];
    const index = variants.findIndex(
      (v) => v.rows === grid.rows && v.cols === grid.cols
    );
    return index < 0 ? 0 : index;
  }

  /** Применить сетку из состояния раскладки. */
  applyGrid(grid) {
    if (!grid || !grid.rows || !grid.cols || !Array.isArray(grid.cells)) return;
    this.currentLayout = { rows: grid.rows, cols: grid.cols, cells: grid.cells };
    this.currentOptionIndex = this.optionForGrid(grid);
    this.applyLayout();
  }

  setLayoutByCount(count, optionIndex = 0) {
    const layouts = LAYOUTS[count];
    if (!layouts || optionIndex >= layouts.length) return;

    this.currentLayout = layouts[optionIndex];
    this.currentOptionIndex = optionIndex;

    const children = Array.from(this.grid.children);
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
    const children = Array.from(this.grid.children);
    if (!layout || children.length === 0) return;

    if (children.length === 1) {
      this.grid.style.display = 'block';
      this.grid.style.gridTemplateColumns = '';
      this.grid.style.gridTemplateRows = '';
      this.grid.style.gap = '';
      children[0].style.gridRow = '';
      children[0].style.gridColumn = '';
      return;
    }

    this.grid.style.display = 'grid';
    this.grid.style.gap = '2px';
    this.grid.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
    this.grid.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;

    let cellIndex = 0;
    const maxCells = Math.min(layout.cells.length, children.length);

    for (let r = 0; r < layout.rows && cellIndex < maxCells; r++) {
      let c = 0;
      while (c < layout.cols && cellIndex < maxCells) {
        const [rowSpan, colSpan] = layout.cells[cellIndex];
        children[cellIndex].style.gridRow = `${r + 1} / span ${rowSpan}`;
        children[cellIndex].style.gridColumn = `${c + 1} / span ${colSpan}`;
        c += colSpan;
        cellIndex++;
      }
    }
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
}
