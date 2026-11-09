// Общая геометрия сетки панелей: размещение клеток с произвольными
// спанами, нормовка весов дорожек, сравнение вариантов сетки.
// Живёт отдельно, потому что одна таблица нужна и раскладчику,
// и рукояткам ресайза — иначе они разойдутся в том, что где стоит.

// Минимальная ширина или высота дорожки в пикселях: иначе ресайз
// сжимает панель в полоску, в которой ничего не читать.
export const MIN_TRACK_PX = 120;

/** Размеры дорожек: все равные, сумма 1. */
export function equalSizes(n) {
  const count = Math.max(1, Number(n) || 1);
  return new Array(count).fill(1 / count);
}

/** Сравнение клеток сетки: порядок и спаны важны, это идентичность варианта. */
export function sameCells(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((cell, i) =>
    Array.isArray(cell) && Array.isArray(b[i]) &&
    Number(cell[0]) === Number(b[i][0]) && Number(cell[1]) === Number(b[i][1])
  );
}

/**
 * Разместить клетки по первой свободной позиции, слева направо,
 * сверху вниз. Клетка может накрывать несколько строк или колонок,
 * поэтому простой проход по строкам ставит следующую панель
 * под уже занятую.
 */
export function placeCells(rows, cols, cells, count) {
  const occupied = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const placements = [];
  const limit = Math.min(cells.length, count);
  for (let i = 0; i < limit; i++) {
    const [rowSpan, colSpan] = cells[i] || [1, 1];
    const spanR = Math.max(1, Math.min(rowSpan, rows));
    const spanC = Math.max(1, Math.min(colSpan, cols));
    const at = firstFreeCell(occupied, rows, cols, spanR, spanC);
    if (!at) break;
    markOccupied(occupied, at.row, at.col, spanR, spanC);
    placements.push({ row: at.row, col: at.col, rowSpan: spanR, colSpan: spanC });
  }
  return placements;
}

function firstFreeCell(occupied, rows, cols, rowSpan, colSpan) {
  for (let r = 0; r + rowSpan <= rows; r++) {
    for (let c = 0; c + colSpan <= cols; c++) {
      let free = true;
      for (let dr = 0; dr < rowSpan && free; dr++) {
        for (let dc = 0; dc < colSpan && free; dc++) {
          if (occupied[r + dr][c + dc]) free = false;
        }
      }
      if (free) return { row: r, col: c };
    }
  }
  return null;
}

function markOccupied(occupied, row, col, rowSpan, colSpan) {
  for (let dr = 0; dr < rowSpan; dr++) {
    for (let dc = 0; dc < colSpan; dc++) {
      occupied[row + dr][col + dc] = true;
    }
  }
}
