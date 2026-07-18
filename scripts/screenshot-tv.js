const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  console.log('Opening TradingView chart...');
  await page.goto('https://ru.tradingview.com/chart/?symbol=MOEX%3ASBER', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });

  console.log('Waiting for chart to render...');
  await page.waitForTimeout(15000);

  await page.screenshot({ path: path.join(__dirname, 'tv-screenshot-compare.png'), fullPage: false });
  console.log('Screenshot saved: scripts/tv-screenshot-compare.png');

  await browser.close();
})();
