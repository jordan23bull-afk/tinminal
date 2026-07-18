const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2] || 'https://ru.tradingview.com/chart/?symbol=MOEX%3ASBER';
const WAIT_MS = 30000;
const OUT = path.join(__dirname, 'tv-capture.json');

(async () => {
  const capture = { http: [], ws: [] };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ru-RU',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Intercept HTTP
  page.on('request', req => {
    if (req.resourceType() === 'websocket') return;
    capture.http.push({
      ts: Date.now(),
      method: req.method(),
      url: req.url(),
      type: req.resourceType(),
      headers: req.headers(),
    });
  });

  page.on('response', async resp => {
    if (resp.request().resourceType() === 'websocket') return;
    const entry = capture.http.find(e => e.url === resp.url() && !e.status);
    if (entry) {
      entry.status = resp.status();
      try {
        const body = await resp.text();
        entry.bodyPreview = body.slice(0, 2000);
      } catch {}
    }
  });

  // Intercept WebSocket
  page.on('websocket', ws => {
    const wsEntry = { url: ws.url(), sent: [], received: [] };
    capture.ws.push(wsEntry);

    ws.on('framereceived', frame => {
      wsEntry.received.push({ ts: Date.now(), data: String(frame.payload).slice(0, 3000) });
    });
    ws.on('framesent', frame => {
      wsEntry.sent.push({ ts: Date.now(), data: String(frame.payload).slice(0, 3000) });
    });
    ws.on('close', () => { wsEntry.closedAt = Date.now(); });
  });

  console.log(`Opening ${URL} ...`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log(`Waiting ${WAIT_MS / 1000}s for data to load...`);
  await page.waitForTimeout(WAIT_MS);

  // Take a screenshot for reference
  await page.screenshot({ path: path.join(__dirname, 'tv-screenshot.png'), fullPage: false });
  console.log('Screenshot saved.');

  await browser.close();

  fs.writeFileSync(OUT, JSON.stringify(capture, null, 2));
  console.log(`Capture saved to ${OUT}`);
  console.log(`HTTP requests: ${capture.http.length}`);
  console.log(`WebSocket connections: ${capture.ws.length}`);
  capture.ws.forEach((ws, i) => {
    console.log(`  WS[${i}]: ${ws.url}`);
    console.log(`    sent: ${ws.sent.length}, received: ${ws.received.length}`);
  });
})();
