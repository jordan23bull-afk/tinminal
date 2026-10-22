// Ластик.
//
// Удаление линии — это команда object.delete, а не правка локального
// массива: иначе вторая вкладка и сервер об удалении не узнают.

import { hitHLine, hitLevel } from "../hittest.js";
import { eventToLocal } from "../coords.js";
import { levelsWithout } from "../levels.js";

export const eraserTool = {
  name: "eraser",
  cursor: "not-allowed",

  hit(ctx) {
    return ctx.hitHLine?.() || ctx.hitLevel?.() || null;
  },

  async onPointerDown(ctx) {
    const { chartObj, event, hlines, levels, send } = ctx;
    if (event.button !== 0) return;

    const point = eventToLocal(chartObj, event);
    if (!point) return;

    const target = hitHLine(chartObj, hlines, point) || hitLevel(chartObj, levels, point);
    if (!target) return;

    // Уровень автоуровня — часть объекта сканера: стираем его переустановкой
    // уровней без стёртого поля. Свой алерт при этом уходит каскадом.
    if (target.object.kind === "auto_level") {
      await send({
        kind: "object.set_auto_levels",
        symbol: target.object.symbol,
        timeframe: target.object.timeframe,
        levels: levelsWithout(target.object, target.field),
      });
      return;
    }

    await send({ kind: "object.delete", id: target.object.id });
  }
};