import { log } from "./utils.js";

export const INDICATOR_TYPES = [
  { id: "sma", label: "SMA", params: [{ key: "period", label: "Период", default: 20 }] },
  { id: "ema", label: "EMA", params: [{ key: "period", label: "Период", default: 20 }] },
  { id: "rsi", label: "RSI", params: [{ key: "period", label: "Период", default: 14 }] },
  { id: "macd", label: "MACD", params: [
    { key: "fast", label: "Быстрый", default: 12 },
    { key: "slow", label: "Медленный", default: 26 },
    { key: "signal", label: "Сигнал", default: 9 }
  ]},
  { id: "bollinger", label: "Bollinger", params: [
    { key: "period", label: "Период", default: 20 },
    { key: "stddev", label: "Отклонение", default: 2 }
  ]},
  { id: "atr", label: "ATR", params: [{ key: "period", label: "Период", default: 14 }] },
  { id: "wma", label: "WMA", params: [{ key: "period", label: "Период", default: 20 }] },
  { id: "stoch", label: "Stochastic", params: [
    { key: "k", label: "%K", default: 14 },
    { key: "d", label: "%D", default: 3 }
  ]},
  { id: "poc", label: "POC", params: [
    { key: "period", label: "Период (0=авто)", default: 0 },
    { key: "bins", label: "Уровни", default: 30 }
  ], extra: [
    { key: "color", label: "Цвет", type: "color", default: "#FF5722" },
    { key: "lineWidth", label: "Толщина", type: "number", default: 2 },
    { key: "extendMode", label: "Режим", type: "select", options: [
      { value: "day", label: "Внутри дня" },
      { value: "cross", label: "До пересечения" }
    ]}
  ]},
];

export const INDICATORS = [];

export function loadCustomIndicators() {
  try {
    const raw = localStorage.getItem("trading-dashboard-custom-indicators");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveCustomIndicators(list) {
  localStorage.setItem("trading-dashboard-custom-indicators", JSON.stringify(list));
}

export function getDeletedIndicators() {
  try {
    const raw = localStorage.getItem("trading-dashboard-deleted-indicators");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function mergeIndicators() {
  const custom = loadCustomIndicators();
  const deleted = getDeletedIndicators();
  const builtins = [
    { id: "rsi", label: "RSI" },
    { id: "macd", label: "MACD" },
    { id: "sma", label: "SMA" },
  ];
  INDICATORS.length = 0;
  builtins.forEach(b => {
    if (!deleted.includes(b.id)) INDICATORS.push(b);
  });
  custom.forEach(c => {
    if (!INDICATORS.find(i => i.id === c.id)) {
      INDICATORS.push({ id: c.id, label: c.label, params: c.params });
    }
  });
}

export function calcIndicator(indId, candles) {
  const custom = loadCustomIndicators().find(c => c.id === indId);
  const params = custom ? custom.params : {};
  const period = params.period || 20;

  const emaCalc = (data, p) => {
    const k = 2 / (p + 1);
    let prev = data[0].value;
    return data.map(d => { prev = d.value * k + prev * (1 - k); return { time: d.time, value: prev }; });
  };

  if (custom && custom.type === "custom" && custom.formula) {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    let prev = { value: closes[0] || 0 };
    try {
      const fn = new Function("candles", "i", "c", "params", "closes", "highs", "lows", "volumes", "prev", "emaCalc", "return (" + custom.formula + ")");
      return candles.map((c, i) => ({ time: c.time, value: fn(candles, i, c, params, closes, highs, lows, volumes, prev, emaCalc) || 0 }));
    } catch(e) {
      log(`Formula error for ${indId}:`, e.message);
      return candles.map(c => ({ time: c.time, value: 0 }));
    }
  }

  if (indId === "sma" || (custom && custom.type === "sma")) {
    return candles.map((c, i) => {
      if (i < period - 1) return { time: c.time, value: c.close };
      const slice = candles.slice(i - period + 1, i + 1);
      return { time: c.time, value: slice.reduce((s, x) => s + x.close, 0) / period };
    });
  }
  if (indId === "ema" || (custom && custom.type === "ema")) {
    const closes = candles.map(c => ({ time: c.time, value: c.close }));
    return emaCalc(closes, period);
  }
  if (indId === "rsi" || (custom && custom.type === "rsi")) {
    const p = period;
    const result = [];
    for (let i = 0; i < candles.length; i++) {
      if (i < p) { result.push({ time: candles[i].time, value: 50 }); continue; }
      let gains = 0, losses = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const diff = candles[j].close - candles[j].open;
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const rs = losses === 0 ? 100 : gains / losses;
      result.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
    }
    return result;
  }
  if (indId === "macd" || (custom && custom.type === "macd")) {
    const fast = params.fast || 12, slow = params.slow || 26;
    const closes = candles.map(c => ({ time: c.time, value: c.close }));
    const ema12 = emaCalc(closes, fast);
    const ema26 = emaCalc(closes, slow);
    return ema12.map((d, i) => ({ time: d.time, value: d.value - ema26[i].value }));
  }
  if (custom && custom.type === "bollinger") {
    const p = params.period || 20, mult = params.stddev || 2;
    const upper = [], lower = [];
    for (let i = 0; i < candles.length; i++) {
      if (i < p - 1) { upper.push({ time: candles[i].time, value: candles[i].close }); lower.push({ time: candles[i].time, value: candles[i].close }); continue; }
      const slice = candles.slice(i - p + 1, i + 1);
      const avg = slice.reduce((s, x) => s + x.close, 0) / p;
      const std = Math.sqrt(slice.reduce((s, x) => s + (x.close - avg) ** 2, 0) / p);
      upper.push({ time: candles[i].time, value: avg + mult * std });
      lower.push({ time: candles[i].time, value: avg - mult * std });
    }
    return upper;
  }
  if (custom && custom.type === "atr") {
    const p = period;
    return candles.map((c, i) => {
      if (i === 0) return { time: c.time, value: c.high - c.low };
      const tr = Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close));
      if (i < p) return { time: c.time, value: tr };
      const slice = candles.slice(i - p + 1, i + 1);
      return { time: c.time, value: slice.reduce((s, x) => s + (x.high - x.low), 0) / p };
    });
  }
  if (custom && custom.type === "wma") {
    const p = period;
    const denom = p * (p + 1) / 2;
    return candles.map((c, i) => {
      if (i < p - 1) return { time: c.time, value: c.close };
      let sum = 0;
      for (let j = 0; j < p; j++) sum += candles[i - p + 1 + j].close * (j + 1);
      return { time: c.time, value: sum / denom };
    });
  }
  if (custom && custom.type === "stoch") {
    const kPeriod = params.k || 14, dPeriod = params.d || 3;
    const kValues = [];
    for (let i = 0; i < candles.length; i++) {
      if (i < kPeriod - 1) { kValues.push(50); continue; }
      const slice = candles.slice(i - kPeriod + 1, i + 1);
      const high = Math.max(...slice.map(c => c.high));
      const low = Math.min(...slice.map(c => c.low));
      kValues.push(high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100);
    }
    return kValues.map((v, i) => ({ time: candles[i].time, value: v }));
  }
  if (indId === "poc" || (custom && custom.type === "poc")) {
    const p = period;
    const numBins = params.bins || 30;
    const extendMode = (custom && custom.extra && custom.extra.extendMode) || "day";

    const calcPocForSlice = (slice) => {
      if (slice.length < 2) return null;
      const minP = Math.min(...slice.map(x => x.low));
      const maxP = Math.max(...slice.map(x => x.high));
      if (maxP === minP) return null;
      const binSize = (maxP - minP) / numBins;
      const volAtPrice = new Array(numBins).fill(0);
      for (const candle of slice) {
        const avgPrice = (candle.high + candle.low + candle.close) / 3;
        let bin = Math.floor((avgPrice - minP) / binSize);
        if (bin >= numBins) bin = numBins - 1;
        if (bin < 0) bin = 0;
        volAtPrice[bin] += candle.volume;
      }
      let maxVol = 0, pocBin = 0;
      for (let b = 0; b < numBins; b++) {
        if (volAtPrice[b] > maxVol) { maxVol = volAtPrice[b]; pocBin = b; }
      }
      return minP + (pocBin + 0.5) * binSize;
    };

    if (p === 0) {
      const dayStart = {};
      candles.forEach((c, i) => {
        const d = new Date(c.time * 1000).toISOString().slice(0, 10);
        if (!(d in dayStart)) dayStart[d] = i;
      });
      const result = [];
      const days = Object.keys(dayStart).sort();
      for (let di = 0; di < days.length; di++) {
        const startIdx = dayStart[days[di]];
        const endIdx = di < days.length - 1 ? dayStart[days[di + 1]] : candles.length;
        const daySlice = candles.slice(startIdx, endIdx);
        const poc = calcPocForSlice(daySlice);
        for (let i = startIdx; i < endIdx; i++) {
          result.push({ time: candles[i].time, value: poc !== null ? poc : candles[i].close });
        }
      }
      if (extendMode === "cross") {
        let lastPoc = result[0].value;
        return result.map((r, i) => {
          if (candles[i].close < lastPoc && candles[i].low <= lastPoc) lastPoc = r.value;
          else if (candles[i].close > lastPoc && candles[i].high >= lastPoc) lastPoc = r.value;
          return { time: r.time, value: lastPoc };
        });
      }
      return result;
    }

    const rawPoc = candles.map((c, i) => {
      const start = Math.max(0, i - p + 1);
      const slice = candles.slice(start, i + 1);
      const poc = calcPocForSlice(slice);
      return poc !== null ? poc : c.close;
    });
    if (extendMode === "cross") {
      let lastPoc = rawPoc[0];
      return candles.map((c, i) => {
        if (c.close < lastPoc && c.low <= lastPoc) {
          lastPoc = rawPoc[i];
        } else if (c.close > lastPoc && c.high >= lastPoc) {
          lastPoc = rawPoc[i];
        }
        return { time: c.time, value: lastPoc };
      });
    }
    return rawPoc.map((v, i) => ({ time: candles[i].time, value: v }));
  }
  return null;
}
