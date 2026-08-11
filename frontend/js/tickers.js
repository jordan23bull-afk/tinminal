const STORAGE_KEY = "trading-dashboard-tickers";
const FLAGS_KEY = "trading-dashboard-flags";

const FORTS_MONTHS = new Set("FGHJKMNQUVXZ");
const FORTS_EXACT = new Set(["IMOEXF", "RTS", "RI", "BR"]);
const INDEX_TICKERS = new Set(["IMOEX", "IMOEX2", "MOEX", "MOEX2", "RTSI", "RTSI2"]);

function detectBoard(ticker) {
  const t = ticker.toUpperCase();
  if (INDEX_TICKERS.has(t) || (t.startsWith("IMO") && t.endsWith("X"))) return "INDEX";
  if (FORTS_EXACT.has(t)) return "FORTS";
  if (/^[A-Z]{2,5}[FGHJKMNQUVXZ]\d$/.test(t)) return "FORTS";
  if (/MOEXF/.test(t)) return "FORTS";
  return "TQBR";
}

const DEFAULT_TICKERS = [
  { ticker: "SBER", name: "Сбербанк", source: "tinkoff", board: "TQBR" },
  { ticker: "GAZP", name: "Газпром", source: "tinkoff", board: "TQBR" },
  { ticker: "LKOH", name: "Лукойл", source: "tinkoff", board: "TQBR" },
  { ticker: "YDEX", name: "Яндекс", source: "tinkoff", board: "TQBR" },
  { ticker: "GMKN", name: "Норникель", source: "tinkoff", board: "TQBR" },
  { ticker: "ROSN", name: "Роснефть", source: "tinkoff", board: "TQBR" },
  { ticker: "SNGS", name: "Сургутнефтегаз", source: "tinkoff", board: "TQBR" },
  { ticker: "VTBR", name: "ВТБ", source: "tinkoff", board: "TQBR" },
  { ticker: "WUSH", name: "Wildberries", source: "tinkoff", board: "TQBR" },
  { ticker: "PHOR", name: "ФосАгро", source: "tinkoff", board: "TQBR" },
  { ticker: "SBERP", name: "Сбербанк-П", source: "tinkoff", board: "TQBR" },
  { ticker: "SMLT", name: "Самолёт", source: "tinkoff", board: "TQBR" },
  { ticker: "TATN", name: "Татнефть", source: "tinkoff", board: "TQBR" },
];

let _tickers = null;

function loadTickers() {
  if (_tickers) return _tickers;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      _tickers = JSON.parse(raw);
      let changed = false;
      _tickers.forEach(t => {
        const correct = detectBoard(t.ticker);
        if (t.board !== correct) { t.board = correct; changed = true; }
        if (t.source !== "tinkoff") { t.source = "tinkoff"; changed = true; }
      });
      if (changed) saveTickers();
      return _tickers;
    }
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
  _tickers.push({ ticker, name: name || ticker, source: "tinkoff", board: detectBoard(ticker) });
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

export { loadTickers, saveTickers, addTicker, removeTicker, loadFlags, toggleFlag, getTickerFlag, buildSymbolItemEl, refreshAllSymbolDropdowns };
