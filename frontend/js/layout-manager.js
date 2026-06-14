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
  6: [
    { rows: 2, cols: 3, cells: [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]] },
  ],
  9: [
    { rows: 3, cols: 3, cells: [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]] },
  ],
  12: [
    { rows: 4, cols: 3, cells: [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]] },
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

  setLayoutByCount(count, optionIndex = 0) {
    const layouts = LAYOUTS[count];
    if (!layouts || optionIndex >= layouts.length) return;

    const layout = layouts[optionIndex];
    this.currentLayout = layout;
    this.currentOptionIndex = optionIndex;

    const children = Array.from(this.grid.children);

    this.grid.style.gridTemplateColumns = '';
    this.grid.style.gridTemplateRows = '';
    this.grid.style.display = '';
    this.grid.style.gap = '';

    children.forEach(child => {
      child.style.gridRow = '';
      child.style.gridColumn = '';
      child.style.width = '';
      child.style.height = '';
    });

    if (count === 1) {
      this.grid.style.display = 'block';
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

  applyLayout() {
    const layout = this.currentLayout;
    const children = Array.from(this.grid.children);
    if (!layout || children.length === 0) return;

    if (children.length === 1) {
      this.grid.style.display = 'block';
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
    if (chartCount <= 1) {
      this.setLayoutByCount(1, 0);
    } else if (chartCount <= 2) {
      this.setLayoutByCount(2, 0);
    } else if (chartCount <= 3) {
      this.setLayoutByCount(3, 0);
    } else if (chartCount <= 6) {
      this.setLayoutByCount(6, 0);
    } else if (chartCount <= 9) {
      this.setLayoutByCount(9, 0);
    } else {
      this.setLayoutByCount(12, 0);
    }
  }
}
