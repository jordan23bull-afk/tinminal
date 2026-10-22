// Преобразования координат для рисовалок.
//
// У графика координаты живут в трёх системах, и путать их —
// источник почти всех ошибок в рисовалках:
//   * пиксели   — координаты мыши внутри .chart-body;
//   * цена      — вертикальная ось;
//   * время     — горизонтальная ось.
//
// Наружу отдаём только эти функции: у каждой есть явный контракт,
// где ожидается null, а где исключение.

/** Точка в пикселях системы координат графика. */
export function pixelToPrice(series, y) {
  if (!series || y == null || Number.isNaN(y)) return null;
  const price = series.coordinateToPrice(y);
  return price == null || Number.isNaN(price) ? null : price;
}

export function priceToPixel(series, price) {
  if (!series || price == null || Number.isNaN(price)) return null;
  const y = series.priceToCoordinate(price);
  return y == null || Number.isNaN(y) ? null : y;
}

/** Время по горизонтали. chart.timeScale().coordinateToTime(). */
export function pixelToTime(chart, x) {
  if (!chart || x == null || Number.isNaN(x)) return null;
  const time = chart.timeScale().coordinateToTime(x);
  return time == null || Number.isNaN(time) ? null : time;
}

export function timeToPixel(chart, time) {
  if (!chart || time == null) return null;
  const x = chart.timeScale().timeToCoordinate(time);
  return x == null || Number.isNaN(x) ? null : x;
}

/** Прямоугольник .chart-body в координатах графика. */
export function bodyRect(chartObj) {
  if (!chartObj || !chartObj.body) return null;
  return chartObj.body.getBoundingClientRect();
}

/** Позиция указателя относительно .chart-body. */
export function eventToLocal(chartObj, event) {
  const rect = bodyRect(chartObj);
  if (!rect) return null;
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * Привязка к ближайшей точке свечи (магнит).
 * Возвращает цену уровня, если свеча найдена, иначе исходную цену.
 */
export function magnetPrice(chartObj, price) {
  if (!chartObj || price == null) return price;
  const time = chartObj.crosshairTime;
  if (time == null) return price;
  const candles = chartObj.config?._lastCandles;
  if (!candles) return price;
  const candle = candles.find((c) => c.time === time);
  if (!candle) return price;
  const toHigh = Math.abs(price - candle.high);
  const toLow = Math.abs(price - candle.low);
  return toHigh <= toLow ? candle.high : candle.low;
}