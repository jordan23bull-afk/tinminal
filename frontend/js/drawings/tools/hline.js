// Горизонтальная линия.
//
// Линию рисует сама библиотека: createPriceLine умеет показывать цену
// на оси и участвует в проверке алертов. Оверлей для неё не нужен,
// а вот оверлей понадобится инструментам, у которых есть время и две точки.
//
// Единственная ответственность инструмента: превратить нажатие
// в команду object.create. Всё остальное — синхронизация и отрисовка.

import { pixelToPrice, eventToLocal, magnetPrice } from "../coords.js";
import { hasHLineAt } from "../hittest.js";

export const hlineTool = {
  name: "horizontal",
  cursor: "crosshair",

  // Одноразовый: поставил линию — возвращаемся к курсору. Иначе каждый
  // следующий клик рисовал бы ещё одну линию.
  oneShot: true,

  /** Уже нарисованные линии рядом с точкой — ластик это уже умеет. */
  hit(ctx) {
    return ctx.hitHLine?.() || null;
  },

  async onPointerDown(ctx) {
    const { chartObj, event, hlines, priceTolerance, send } = ctx;
    if (event.button !== 0) return;

    const point = eventToLocal(chartObj, event);
    if (!point) return;

    let price = pixelToPrice(chartObj.mainSeries, point.y);
    if (price == null) return;

    if (ctx.magnetOn) price = magnetPrice(chartObj, price);

    // Уровень, который уже есть, второй раз не добавляем:
    // иначе на одном цене накапливаются неотличимые линии.
    if (hasHLineAt(hlines, price, priceTolerance)) return;

    await send({
      kind: "hline",
      symbol: chartObj.config.symbol,
      timeframe: chartObj.config.timeframe,
      chart_index: ctx.chartIndex,
      data: { price },
      style: { color: "#2196F3", lineWidth: 1, lineStyle: 2 }
    });
  }
};