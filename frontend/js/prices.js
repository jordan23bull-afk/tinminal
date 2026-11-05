// Шаг цены инструмента.
//
// На бирже сделки бывают только на шагах цены, между шагами их не бывает.
// Всё, что становится уровнем или алертом, обязано лежать на шаге: иначе
// линия стоит на цене, по которой никто не торговал.
//
// Шаг приходит с историей как config.tick (min_price_increment из Tinkoff),
// тот же шаг сервер использует при сравнении сделки с уровнем.
//
// Сравнение цены с уровнем идёт по номеру шага (`stepIndex`), а не по
// расстоянию: это то же «на одном шаге», но без допуска в половину шага.
// Правило округления (`floor(x + 0.5)`) совпадает с серверным
// `backend/core/prices.py` → `step_index`, иначе ровно на полушаге клиент и
// сервер разошлись бы.

export const DEFAULT_TICK = 0.01;

/** Положительный шаг инструмента или запасной. */
function stepOf(tick) {
  const value = Number(tick);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TICK;
}

/** Сколько знаков после запятой нужно, чтобы записать шаг без потерь. */
export function tickDecimals(tick) {
  const text = stepOf(tick).toFixed(10).replace(/0+$/, "");
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Номер шага, на котором стоит цена. Нет цены — null. */
export function stepIndex(price, tick) {
  if (price == null || price === "") return null;
  const value = Number(price);
  if (!Number.isFinite(value)) return null;
  return Math.floor(value / stepOf(tick) + 0.5);
}

/** Ближайшая цена, кратная шагу. Нет цены — null. */
export function snapToTick(price, tick) {
  const index = stepIndex(price, tick);
  if (index == null) return null;
  const step = stepOf(tick);
  const snapped = index * step;
  // toFixed снимает хвост float: без него 0.1 + 0.2 снова уходит с шага.
  return Number(snapped.toFixed(tickDecimals(step)));
}

/** Стоят ли две цены на одном шаге. */
export function sameStep(a, b, tick) {
  const left = stepIndex(a, tick);
  const right = stepIndex(b, tick);
  return left != null && left === right;
}
