'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server');

async function run() {
  const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/platform-listings.html'), 'utf8');
  let searchRequests = 0;
  const server = createServer({
    minPlatformIntervalMs: 0,
    fetchText: async () => fixture,
    xhsAdapter: {
      fetchXhs: async () => ({ source: '小红书', status: 'blocked', message: '测试：平台需要验证', listings: [] }),
      openBrowser: async () => ({ status: 'unavailable', visible: false, message: '测试：没有可用浏览器' }),
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/api/search')) searchRequests += 1; });
    await page.goto(origin);
    assert.equal(await page.locator('.listing-card').count(), 0, 'a new browser must have no synthetic listings');
    assert.equal(await page.locator('textarea').count(), 0, 'automatic acquisition must be the only input workflow');
    await page.locator('#cityInput').fill('北京');
    await page.locator('#rentMin').fill('6000');
    await page.locator('#rentMax').fill('4000');
    await page.locator('#runSearchBtn').click();
    assert.match(await page.locator('#rentValidation').innerText(), /最低/);
    assert.equal(searchRequests, 0, 'invalid ranges must not send a search request');
    await page.locator('#rentMin').fill('');
    await page.locator('#rentMax').fill('');
    await page.locator('#runSearchBtn').click();
    await page.waitForFunction(() => !document.querySelector('#runSearchBtn').disabled);
    assert.equal(await page.locator('.listing-card').count(), 6, 'both working sources should return fixture cards');
    const xhsStatus = await page.locator('[data-platform="小红书"] .status-badge').innerText();
    assert.doesNotMatch(xhsStatus, /0 条|已获取/, 'a verification block is not an empty successful search');
    await page.locator('[data-action="xhs-login"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-action="xhs-login"]').disabled);
    assert.doesNotMatch(await page.locator('[data-platform="小红书"] .status-badge').innerText(), /已打开|已获取/, 'an unavailable browser must not be reported as open');
    await page.locator('.listing-card [data-action="favorite"]').first().click();
    assert.equal(await page.locator('#favoriteCount').innerText(), '1');
    await page.locator('#runSearchBtn').click();
    await page.waitForFunction(() => !document.querySelector('#runSearchBtn').disabled);
    assert.equal(await page.locator('.listing-card').count(), 6, 'refresh should not duplicate listings');
    assert.equal(await page.locator('#favoriteCount').innerText(), '1', 'refresh should preserve favorites');
    await page.reload();
    assert.equal(await page.locator('#favoriteCount').innerText(), '1', 'favorites should survive reload');
    await page.locator('#rentMax').fill('5500');
    await page.locator('#filtersForm button[type="submit"]').click();
    assert.equal(await page.locator('.listing-card').count(), 2, 'budget must exclude unknown and nonmatching rents');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportCsvBtn').click()]);
    const downloadPath = await download.path();
    const csv = fs.readFileSync(downloadPath, 'utf8');
    assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV must contain a real UTF-8 BOM');
    assert.equal(csv.split('\r\n').length, 3, 'CSV must contain real line separators');
    await page.locator('#commuteInput').fill('国贸');
    await page.locator('#commuteInput').blur();
    assert.doesNotMatch((await page.locator('.commute-chip').allTextContents()).join(' '), /\d+(?:\.\d+)?\s*km|\d+\s*分钟/, 'commute must not be fabricated');
    await page.locator('#cityInput').fill('上海');
    await page.locator('#filtersForm button[type="submit"]').click();
    assert.equal(await page.locator('.listing-card').count(), 0, 'other cities must not be shown');
    await page.locator('#cityInput').fill('北京');
    for (const checkbox of await page.locator('.source-checks input').all()) await checkbox.uncheck();
    await page.locator('#filtersForm button[type="submit"]').click();
    const previous = searchRequests;
    await page.locator('#runSearchBtn').click();
    assert.equal(searchRequests, previous, 'no selected sources must not request all sources');
    assert.equal(await page.locator('.listing-card').count(), 0);
    assert.deepEqual(errors, []);

    fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1040 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `no horizontal overflow at ${width}px`);
      await page.screenshot({ path: path.join(__dirname, `../test-results/ui-${width}.png`), fullPage: true });
    }
    console.log('UI checks passed: acquisition, validation, persistence, filters, CSV, truthful states, desktop/mobile.');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
