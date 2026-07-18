const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  console.log('Opening http://localhost:5000 ...');
  await page.goto('http://localhost:5000', { waitUntil: 'networkidle', timeout: 30000 });

  // Wait for chart to render
  console.log('Waiting for chart data...');
  await page.waitForTimeout(8000);

  await page.screenshot({ path: path.join(__dirname, 'local-screenshot.png'), fullPage: false });
  console.log('Screenshot saved: scripts/local-screenshot.png');

  // Check for console errors
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.waitForTimeout(2000);

  // Check chart elements
  const chartCount = await page.locator('.chart-wrapper').count();
  const hasCandles = await page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas');
    return canvases.length;
  });

  console.log(`Charts rendered: ${chartCount}`);
  console.log(`Canvas elements: ${hasCandles}`);
  if (errors.length) console.log('Console errors:', errors.join('\n'));

  await browser.close();
})();
