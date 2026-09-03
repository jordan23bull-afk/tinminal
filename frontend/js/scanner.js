import { loadTickers, loadFlags, saveFlags } from "./tickers.js";

export function initScanner({ chartManager, renderWatchlist }) {
  const btn = document.getElementById("atr-scan-btn");
  if (!btn) return;

  function setFlagDirect(ticker, color) {
    const flags = loadFlags();
    flags[ticker] = color;
    saveFlags(flags);
  }

  const SCAN_FLAGS_KEY = "trading-scan-flags";
  function loadScanFlags() {
    try { return JSON.parse(localStorage.getItem(SCAN_FLAGS_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveScanFlags(flags) {
    try { localStorage.setItem(SCAN_FLAGS_KEY, JSON.stringify(flags)); }
    catch {}
  }
  function clearStaleScanFlags(nextScanFlags) {
    const old = loadScanFlags();
    const flags = loadFlags();
    for (const ticker of Object.keys(old)) {
      if (nextScanFlags[ticker]) continue;
      if (ticker in flags) {
        delete flags[ticker];
      }
    }
    saveFlags(flags);
    saveScanFlags(nextScanFlags);
  }

  function getWatchlistTickers() {
    return new Set(loadTickers().map(t => t.ticker));
  }

  btn.addEventListener("click", () => {
    if (document.querySelector("#atr-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "atr-overlay";
    overlay.className = "ind-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "ind-modal";
    modal.innerHTML = `
      <h3>ATR-сканер MOEX</h3>
      <label>Порог ATR (пункты)</label>
      <input type="number" id="atr-threshold" min="0" step="0.1" value="5" style="width:100%">
      <label>Дата торгов</label>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="date" id="atr-date" style="flex:1">
        <button type="button" class="tool-btn" id="atr-date-refresh" title="Обновить (последний торговый день)" style="padding:2px 8px;font-size:14px">🔄</button>
      </div>
      <div id="atr-result" style="margin-top:10px;font-size:12px;color:var(--text-secondary);min-height:18px"></div>
      <div class="ind-modal-btns">
        <button class="ind-cancel">Отмена</button>
        <button class="ind-save">Сканировать</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector(".ind-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    const dateInput = modal.querySelector("#atr-date");
    const refreshBtn = modal.querySelector("#atr-date-refresh");

    async function fillLastTradingDay() {
      try {
        const resp = await fetch("/api/scan/last-trading-day");
        const data = await resp.json();
        if (data.date) dateInput.value = data.date;
      } catch (e) { /* ignore */ }
    }
    fillLastTradingDay();
    refreshBtn.addEventListener("click", fillLastTradingDay);

    modal.querySelector(".ind-save").addEventListener("click", async () => {
      const threshold = parseFloat(modal.querySelector("#atr-threshold").value) || 0;
      const dateVal = dateInput.value || null;
      const resultEl = modal.querySelector("#atr-result");
      const scanBtn = modal.querySelector(".ind-save");
      scanBtn.disabled = true;
      scanBtn.textContent = "Загрузка...";
      resultEl.textContent = "";

      try {
        const resp = await fetch("/api/scan/atr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ atr_threshold: threshold, date: dateVal })
        });
        const data = await resp.json();
        if (data.error) {
          resultEl.textContent = data.error;
          resultEl.style.color = "#ef5350";
          scanBtn.disabled = false;
          scanBtn.textContent = "Сканировать";
          return;
        }

        const results = data.results || [];
        const wlTickers = getWatchlistTickers();
        let buyCount = 0, sellCount = 0, skipped = 0;
        const nextScanFlags = {};

        for (const r of results) {
          if (!r.direction) continue;
          if (!wlTickers.has(r.ticker)) { skipped++; continue; }
          const color = r.direction === "buy" ? "green" : "red";
          setFlagDirect(r.ticker, color);
          nextScanFlags[r.ticker] = color;
          if (r.high > 0 && r.low > 0) {
            chartManager.setAutoLevels(r.ticker, r.high, r.low, r.evening_high, r.evening_low);
          }
          if (r.direction === "buy") buyCount++;
          else sellCount++;
        }

        clearStaleScanFlags(nextScanFlags);
        renderWatchlist();

        const total = buyCount + sellCount;
        resultEl.style.color = "";
        resultEl.textContent = `Флаги проставлены: ${total} (${buyCount} покупка, ${sellCount} продажа) | линии+алерты мин/макс: ${total} | ${skipped} не в вочлисте | дата: ${data.date}`;
      } catch (e) {
        resultEl.textContent = "Ошибка: " + e.message;
        resultEl.style.color = "#ef5350";
      }
      scanBtn.disabled = false;
      scanBtn.textContent = "Сканировать";
    });
  });
}
