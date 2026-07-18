const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Capture console logs
  page.on('console', msg => {
    if (msg.text().includes('LKOH') || msg.text().includes('candle') || msg.text().includes('update') || msg.text().includes('error')) {
      console.log(`[BROWSER] ${msg.text()}`);
    }
  });

  await page.goto('http://localhost:5000', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Click LKOH
  const lkoh = page.locator('.watchlist-item[data-symbol="LKOH"]');
  if (await lkoh.count() > 0) {
    await lkoh.click();
    console.log('Clicked LKOH');
  }

  // Wait and check chart state
  await page.waitForTimeout(10000);

  const state = await page.evaluate(() => {
    const charts = document.querySelectorAll('.chart-wrapper');
    const active = document.querySelector('.chart-wrapper.active');
    const results = [];
    charts.forEach((ch, i) => {
      const header = ch.querySelector('.ch-symbol-btn');
      results.push({
        index: i,
        symbol: header?.textContent || '?',
        isActive: ch.classList.contains('active'),
        canvasCount: ch.querySelectorAll('canvas').length
      });
    });
    return { charts: results, activeSymbol: active?.querySelector('.ch-symbol-btn')?.textContent };
  });

  console.log('Active chart symbol:', state.activeSymbol);
  state.charts.forEach(c => {
    if (c.isActive) console.log(`  Chart ${c.index}: ${c.symbol} (active, ${c.canvasCount} canvases)`);
  });

  await browser.close();
})();
