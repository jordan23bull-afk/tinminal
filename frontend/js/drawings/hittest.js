// Попадание по рисовалкам.
//
// Каждый рисунок умеет сказать, где он на экране и какая у него зона
// захвата. Здесь живёт только сравнение: инструменты отвечают за геометрию,
// а решение «попали или нет» принимается в одном месте с одним правилом
// на расстояние — иначе ластик, выбор и перетаскивание расходятся между собой.

import { levelEntries } from "./levels.js";

/** Порог захвата в пикселях. Общий для всех инструментов. */
export const HIT_TOLERANCE = 10;

export function withinTolerance(distance, tolerance = HIT_TOLERANCE) {
  return distance != null && Math.abs(distance) <= tolerance;
}

/**
 * Ближайшая горизонтальная линия к точке.
 *
 * chartObj — объект графика из ChartManager,
 * objects — массив серверных объектов с kind === "hline".
 * Возвращает { object, distance } или null.
 */
export function hitHLine(chartObj, objects, point, tolerance = HIT_TOLERANCE) {
  const series = chartObj?.mainSeries;
  if (!series || !point || !Array.isArray(objects)) return null;

  let best = null;
  for (const obj of objects) {
    if (obj.kind !== "hline") continue;
    const y = priceToPixelSafe(series, obj.data?.price);
    if (y == null) continue;
    const distance = point.y - y;
    if (best === null || Math.abs(distance) < Math.abs(best.distance)) {
      best = { object: obj, distance };
    }
  }
  if (!best) return null;
  return withinTolerance(best.distance, tolerance) ? best : null;
}

function priceToPixelSafe(series, price) {
  if (price == null || Number.isNaN(price)) return null;
  const y = series.priceToCoordinate(price);
  return y == null || Number.isNaN(y) ? null : y;
}

/**
 * Есть ли линия рядом с ценой. Нужно, чтобы не плодить дубли
 * на одном уровне: сравнение идёт с допуском по шагу цены.
 */
export function hasHLineAt(objects, price, tolerance) {
  if (price == null || !Array.isArray(objects)) return false;
  return objects.some(
    (o) => o.kind === "hline" && o.data?.price != null && Math.abs(o.data.price - price) <= tolerance
  );
}

/**
 * Ближайший уровень автоуровня к точке.
 *
 * Возвращает { object, field, price, distance } или null.
 */
export function hitLevel(chartObj, objects, point, tolerance = HIT_TOLERANCE) {
  const series = chartObj?.mainSeries;
  if (!series || !point || !Array.isArray(objects)) return null;

  let best = null;
  for (const obj of objects) {
    for (const entry of levelEntries(obj)) {
      const y = priceToPixelSafe(series, entry.price);
      if (y == null) continue;
      const distance = point.y - y;
      if (best === null || Math.abs(distance) < Math.abs(best.distance)) {
        best = { object: obj, field: entry.field, price: entry.price, distance };
      }
    }
  }
  if (!best) return null;
  return withinTolerance(best.distance, tolerance) ? best : null;
}