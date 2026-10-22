// Реестр инструментов рисования.
//
// Инструмент — это объект с контрактом:
//   name        — значение data-tool в разметке;
//   cursor      — курсор над графиком, пока инструмент активен;
//   onPointerDown(ctx) — реакция на нажатие;
//   onPointerMove(ctx) — необязательно, для рисования по движению;
//   onPointerUp(ctx)   — необязательно;
//   hit(ctx)    — необязательно, попадание по уже нарисованному.
//
// Реестр нужен по двум причинам: кнопки в панели рисуются из него,
// а обработчики графика не знают ни про один конкретный инструмент.
// Добавление trendline или rectangle не должно трогать chart-ui.js.

import { hlineTool } from "./hline.js";
import { eraserTool } from "./eraser.js";

const tools = new Map();

export function registerTool(tool) {
  if (!tool || !tool.name) throw new Error("Инструмент должен иметь имя");
  tools.set(tool.name, tool);
  return tool;
}

export function getTool(name) {
  return tools.get(name) || null;
}

export function listTools() {
  return Array.from(tools.values());
}

/** Инструмент, который ничего не рисует: обычная работа с графиком. */
export function isPassiveTool(name) {
  const tool = getTool(name);
  return !tool || tool.passive === true;
}

export function cursorFor(name) {
  return getTool(name)?.cursor || "default";
}

registerTool(hlineTool);
registerTool(eraserTool);