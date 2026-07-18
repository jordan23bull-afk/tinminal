const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  console.log('Opening http://localhost:5000 ...');
  await page.goto('http://localhost:5000', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Click LKOH in watchlist
  console.log('Looking for LKOH in watchlist...');
  const lkoh = page.locator('.watchlist-item[data-symbol="LKOH"]');
  if (await lkoh.count() > 0) {
    await lkoh.click();
    console.log('Clicked LKOH');
    await page.waitForTimeout(5000);
  } else {
    console.log('LKOH not found in watchlist, trying to find it...');
    const items = await page.locator('.watchlist-item').allTextContents();
    console.log('Watchlist items:', items.join(' | '));
  }

  await page.screenshot({ path: path.join(__dirname, 'lkoh-screenshot.png'), fullPage: false });
  console.log('Screenshot saved: scripts/lkoh-screenshot.png');

  await browser.close();
})();
