// Стиль новых горизонтальных линий.
//
// У источника настройка линии запоминается: следующая линия рисуется тем же
// цветом, толщиной и типом. Ключ живёт в localStorage и, как остальные
// настройки, уезжает в data/settings.json через storage.js — поэтому стиль
// переживает и перезагрузку, и другую вкладку.

const KEY = "dash-line-style";

export const LINE_STYLE_DEFAULT = {
  color: "#2196F3",
  lineWidth: 1,
  lineStyle: 2,
};

function normalize(raw) {
  if (!raw || typeof raw !== "object") return { ...LINE_STYLE_DEFAULT };
  const width = Number(raw.lineWidth);
  const style = Number(raw.lineStyle);
  return {
    color: typeof raw.color === "string" && raw.color ? raw.color : LINE_STYLE_DEFAULT.color,
    lineWidth: width >= 1 && width <= 4 ? width : LINE_STYLE_DEFAULT.lineWidth,
    // 0 — сплошная, 1 — точки, 2 — штрихи, 3 — штрих-пунктир.
    lineStyle: [0, 1, 2, 3].includes(style) ? style : LINE_STYLE_DEFAULT.lineStyle,
  };
}

/** Стиль, с которым рисуется следующая линия. */
export function loadLineStyle() {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) || "null"));
  } catch {
    return { ...LINE_STYLE_DEFAULT };
  }
}

/** Запомнить вид линии: его унаследует следующая. */
export function saveLineStyle(style) {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalize(style)));
  } catch {
    /* приватный режим — стиль просто не переживёт перезагрузку */
  }
}
