const STORAGE_KEY = "trading-dashboard-tickers";
const FLAGS_KEY = "trading-dashboard-flags";

const DEFAULT_TICKERS = [
  { ticker: "SBER", name: "Сбербанк", source: "moex" },
  { ticker: "GAZP", name: "Газпром", source: "moex" },
  { ticker: "LKOH", name: "Лукойл", source: "moex" },
  { ticker: "YDEX", name: "Яндекс", source: "moex" },
  { ticker: "GMKN", name: "Норникель", source: "moex" },
  { ticker: "ROSN", name: "Роснефть", source: "moex" },
  { ticker: "SNGS", name: "Сургутнефтегаз", source: "moex" },
  { ticker: "VTBR", name: "ВТБ", source: "moex" },
  { ticker: "WUSH", name: "Wildberries", source: "moex" },
  { ticker: "PHOR", name: "ФосАгро", source: "moex" },
  { ticker: "SBERP", name: "Сбербанк-П", source: "moex" },
  { ticker: "SMLT", name: "Самолёт", source: "moex" },
  { ticker: "TATN", name: "Татнефть", source: "moex" },
];

let _tickers = null;

function loadTickers() {
  if (_tickers) return _tickers;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { _tickers = JSON.parse(raw); return _tickers; }
  } catch {}
  _tickers = DEFAULT_TICKERS.map(t => ({ ...t }));
  return _tickers;
}

function saveTickers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_tickers));
}

function addTicker(ticker, name) {
  ticker = ticker.toUpperCase().trim();
  if (!ticker || _tickers.some(t => t.ticker === ticker)) return false;
  _tickers.push({ ticker, name: name || ticker, source: "moex" });
  saveTickers();
  return true;
}

function removeTicker(ticker) {
  _tickers = _tickers.filter(t => t.ticker !== ticker);
  saveTickers();
}

function loadFlags() {
  try {
    const raw = localStorage.getItem(FLAGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveFlags(flags) {
  localStorage.setItem(FLAGS_KEY, JSON.stringify(flags));
}

function toggleFlag(ticker, color) {
  const flags = loadFlags();
  if (flags[ticker] === color) {
    delete flags[ticker];
  } else {
    flags[ticker] = color;
  }
  saveFlags(flags);
  return flags[ticker] || null;
}

function getTickerFlag(ticker) {
  const flags = loadFlags();
  return flags[ticker] || null;
}

function buildSymbolItemEl(s) {
  const div = document.createElement("div");
  div.className = "ch-symbol-item";
  div.dataset.ticker = s.ticker;
  div.dataset.source = s.source;
  div.innerHTML = `<span class="ch-si-icon">${s.ticker.charAt(0)}</span><span class="ch-si-name">${s.name || s.ticker}</span><span class="ch-si-ticker">${s.ticker}</span>`;
  return div;
}

function refreshAllSymbolDropdowns() {
  document.querySelectorAll(".ch-symbol-dropdown").forEach(dropdown => {
    const list = dropdown.querySelector(".ch-symbol-list");
    if (!list) return;
    list.innerHTML = "";
    _tickers.forEach(s => list.appendChild(buildSymbolItemEl(s)));
  });
}

export { loadTickers, saveTickers, addTicker, removeTicker, loadFlags, saveFlags, toggleFlag, getTickerFlag, buildSymbolItemEl, refreshAllSymbolDropdowns };
