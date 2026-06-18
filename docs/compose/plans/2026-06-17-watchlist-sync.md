# Watchlist Real-Time Price Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task.

**Goal:** Watchlist shows real MOEX prices instead of hardcoded values, polling every 5 seconds.

**Architecture:** Backend gets a batch price endpoint hitting MOEX ISS `marketdata`. Frontend polls it and updates watchlist DOM.

**Tech Stack:** Python/Flask, vanilla JS

---

### Task 1: Backend batch price endpoint

**Files:**
- Modify: `backend/data_sources/moex_source.py`
- Modify: `backend/core/app.py`

- [ ] **Step 1: Add `get_prices` method to MoexSource**

```python
def get_prices(self, symbols):
    tickers = [self._resolve_ticker(s) for s in symbols]
    url = (
        f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/"
        f"securities.json?iss.meta=off&iss.json=extended"
        f"&securities={','.join(tickers)}"
    )
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    md_list = data[1].get("marketdata", {}).get("data", [])
    md_cols = data[1].get("marketdata", {}).get("columns", [])
    result = {}
    if not md_list or not md_cols:
        return result
    sym_idx = md_cols.index("SECID") if "SECID" in md_cols else None
    last_idx = md_cols.index("LAST") if "LAST" in md_cols else None
    chg_idx = md_cols.index("LASTCHANGE") if "LASTCHANGE" in md_cols else None
    chgp_idx = md_cols.index("LASTTOPREVPRICE") if "LASTTOPREVPRICE" in md_cols else None
    for row in md_list:
        if sym_idx is None or last_idx is None:
            continue
        ticker = row[sym_idx]
        price = row[last_idx]
        if price is None:
            continue
        change = row[chg_idx] if chg_idx is not None else None
        pct = row[chgp_idx] if chgp_idx is not None else None
        result[ticker] = {
            "price": float(price),
            "change": float(change) if change is not None else None,
            "changePct": float(pct) if pct is not None else None,
        }
    return result
```

- [ ] **Step 2: Add `/api/prices` endpoint**

In `backend/core/app.py`, after the existing routes:

```python
@app.route("/api/prices")
def prices():
    try:
        symbols = request.args.get("symbols", "").split(",")
        symbols = [s.strip().upper() for s in symbols if s.strip()]
        if not symbols:
            return jsonify({"prices": {}})
        source = ModuleRegistry.get_data_source("moex")
        result = source.get_prices(symbols)
        return jsonify({"prices": result})
    except Exception as e:
        logger.error(f"Prices API error: {e}")
        return jsonify({"error": str(e)}), 500
```

- [ ] **Step 3: Verify backend starts**

Run: `cd backend && python -c "from data_sources.moex_source import MoexSource; s = MoexSource(); print(s.get_prices(['SBER', 'GAZP']))"`
Expected: dict with SBER and GAZP prices

---

### Task 2: Frontend watchlist price polling

**Files:**
- Modify: `frontend/js/app.js`

- [ ] **Step 1: Add price fetching and watchlist update logic**

At the end of `app.js` (before the final `log`), add:

```javascript
async function updateWatchlistPrices() {
  const items = document.querySelectorAll(".watchlist-item[data-symbol]");
  const symbols = Array.from(items).map(el => el.dataset.symbol);
  if (symbols.length === 0) return;
  try {
    const res = await fetch(`/api/prices?symbols=${symbols.join(",")}`);
    const data = await res.json();
    if (data.error) return;
    items.forEach(el => {
      const sym = el.dataset.symbol;
      const info = data.prices[sym];
      const priceEl = el.querySelector(".wl-price");
      const changeEl = el.querySelector(".wl-change");
      if (!info) {
        if (priceEl) priceEl.textContent = "—";
        if (changeEl) { changeEl.textContent = "—"; changeEl.className = "wl-change"; }
        return;
      }
      const priceStr = info.price >= 1000
        ? info.price.toLocaleString("ru-RU", { maximumFractionDigits: 0 })
        : info.price.toFixed(2);
      if (priceEl) priceEl.textContent = priceStr;
      if (changeEl) {
        if (info.changePct != null) {
          const pct = info.changePct.toFixed(2);
          changeEl.textContent = (info.changePct >= 0 ? "+" : "") + pct + "%";
          changeEl.className = "wl-change " + (info.changePct >= 0 ? "positive" : "negative");
        } else {
          changeEl.textContent = "—";
          changeEl.className = "wl-change";
        }
      }
    });
  } catch {}
}

updateWatchlistPrices();
setInterval(updateWatchlistPrices, 5000);
```

- [ ] **Step 2: Verify**

Open `http://localhost:5000`, check watchlist prices update with real MOEX data.
