// Автоуровни сканера.
//
// В отличие от нарисованных линий, автоуровень — один серверный объект, у
// которого четыре цены разложены по полям данных: day_high, day_low,
// eve_high, eve_low. Своей цены в data.price у него нет, поэтому
// инструменты, работающие с линиями, его не видят.

/** Поля уровней автоуровня. */
export const LEVEL_FIELDS = ["day_high", "day_low", "eve_high", "eve_low"];

/**
 * Уровни объекта: цена каждого и поле, где она лежит.
 */
export function levelEntries(obj) {
  if (!obj || obj.kind !== "auto_level") return [];
  const out = [];
  for (const field of LEVEL_FIELDS) {
    const value = obj.data?.[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out.push({ field, price: value });
  }
  return out;
}

/**
 * Уровни объекта без одного поля — набор для переустановки.
 *
 * Пустой набор означает «уровней нет»: сервер снимает объект целиком.
 */
export function levelsWithout(obj, field) {
  const rest = {};
  for (const entry of levelEntries(obj)) {
    if (entry.field === field) continue;
    rest[entry.field] = entry.price;
  }
  return rest;
}
