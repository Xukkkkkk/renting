'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server');

async function run() {
  const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/platform-listings.html'), 'utf8');
  const server = createServer({
    minPlatformIntervalMs: 0,
    fetchText: async () => fixture,
    xhsAdapter: {
      fetchXhs: async () => ({ source: '\u5c0f\u7ea2\u4e66', status: 'blocked', message: 'Fixture verification required', listings: [] }),
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const city = '\u5317\u4eac';
  const destination = '\u56fd\u8d38';
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    const distances = new Map();
    const held = [];
    let holdResponses = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://example.com/**', route => route.abort());
    await page.route('**/api/commute', async route => {
      const body = route.request().postDataJSON();
      requests.push(body);
      assert.equal(body.city, city, 'the commute API must receive the canonical city');
      assert.ok(body.listings.length > 0 && body.listings.length <= 5, 'commute requests must use bounded nonempty batches');
      const query = String(body.commute).trim().replace(/\s+/g, ' ').toLowerCase();
      const key = JSON.stringify([body.city, query]);
      const response = {
        target: { key, city: body.city, query, label: query },
        listings: body.listings.map(item => {
          assert.ok(distances.has(item.id), 'commute IDs must match the stored listing stable keys');
          const distanceKm = distances.get(item.id);
          return { id: item.id, distanceKm, distanceTarget: key, geocodeStatus: distanceKm === null ? 'not_found' : 'resolved' };
        }),
      };
      const respond = () => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
      if (holdResponses) held.push({ query, respond });
      else await respond();
    });

    const countCards = count => page.waitForFunction(expected => document.querySelectorAll('.listing-card').length === expected, count);
    const setField = async (selector, value) => {
      await page.locator(selector).fill(value);
      await page.locator(selector).dispatchEvent('change');
    };
    const calculate = async () => {
      await page.locator('#calculateCommuteBtn').click();
      await page.waitForFunction(() => !document.querySelector('#calculateCommuteBtn').disabled);
    };
    const storedListings = () => page.evaluate(() => JSON.parse(localStorage.getItem('renting-radar-listings-v3') || '[]'));

    await page.goto(origin);
    await setField('#cityInput', city);
    await page.locator('#runSearchBtn').click();
    await page.waitForFunction(() => !document.querySelector('#runSearchBtn').disabled);
    await countCards(6);
    const originals = await storedListings();
    const values = [0, 1, 3, 10, 10.1, null];
    originals.forEach((item, index) => distances.set(item.id, values[index]));
    const favoriteId = originals[0].id;
    await page.locator(`.listing-card[data-id=${JSON.stringify(favoriteId)}] [data-action="favorite"]`).click();
    assert.equal(await page.locator('#favoriteCount').innerText(), '1');

    await setField('#commuteInput', destination);
    assert.equal(requests.length, 0, 'a destination alone must not automatically request distances');
    await calculate();
    const targetKey = JSON.stringify([city, destination]);
    await page.waitForFunction(key => JSON.parse(localStorage.getItem('renting-radar-listings-v3')).every(item => item.distanceTarget === key), targetKey);
    assert.ok(requests.length >= 2, 'six listings must be calculated in at least two bounded batches');
    assert.match((await page.locator('.commute-chip').allTextContents()).join(' '), /\u516c\u91cc/, 'resolved distances must be shown without travel-time fabrication');
    await countCards(6);

    await setField('#commuteMaxKm', '1');
    await countCards(2);
    await page.locator('[data-distance="3"]').click();
    await countCards(3);
    await setField('#commuteMaxKm', '10');
    await countCards(4);
    assert.equal(await page.locator('#favoriteCount').innerText(), '1', 'distance filtering must preserve favorites');
    await page.locator('#clearCommuteRange').click();
    assert.equal(await page.locator('#commuteMaxKm').inputValue(), '', 'clearing the radius must restore an unlimited search');
    await countCards(6);

    const beforeInvalid = requests.length;
    await setField('#commuteMaxKm', '0');
    assert.equal(await page.locator('#commuteValidation').isVisible(), true, 'zero is an invalid radius, not an unlimited search');
    assert.equal(requests.length, beforeInvalid, 'an invalid radius must not trigger geocoding');
    await setField('#commuteMaxKm', '101');
    assert.equal(await page.locator('#commuteValidation').isVisible(), true, 'a radius above 100 km must be rejected');
    await setField('#commuteMaxKm', '3');
    await countCards(3);

    await page.reload();
    await countCards(3);
    assert.equal(await page.locator('#commuteMaxKm').inputValue(), '3', 'radius should survive reload');
    assert.equal(await page.locator('#favoriteCount').innerText(), '1', 'favorites should survive reload');
    await page.locator('#runSearchBtn').click();
    await page.waitForFunction(() => !document.querySelector('#runSearchBtn').disabled);
    await countCards(3);
    assert.equal((await storedListings()).length, 6, 'refresh must not duplicate listings');
    assert.equal(await page.locator('#favoriteCount').innerText(), '1', 'refresh must preserve favorites');

    holdResponses = true;
    const pendingCommute = page.waitForRequest(request => request.url().endsWith('/api/commute'));
    await setField('#commuteInput', '\u671b\u4eac SOHO');
    await countCards(0);
    await pendingCommute;
    // Let the first destination request complete only after a second destination is active.
    await setField('#commuteInput', '\u4e2d\u5173\u6751');
    assert.equal(await page.locator('.listing-card').count(), 0, 'old destination distances must immediately stop matching');
    const stale = held.filter(item => item.query === '\u671b\u4eac soho');
    for (const item of stale) {
      held.splice(held.indexOf(item), 1);
      await item.respond();
    }
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.listing-card').count(), 0, 'a stale destination response must not become current');
    holdResponses = false;
    for (const item of held.splice(0)) await item.respond();
    await setField('#commuteMaxKm', '');
    await countCards(6);
    await calculate();
    await setField('#commuteMaxKm', '3');
    await countCards(3);

    await setField('#cityInput', '\u4e0a\u6d77');
    await countCards(0);
    await setField('#commuteMaxKm', '');
    await countCards(0);
    await setField('#cityInput', city);
    await countCards(6);
    assert.equal((await storedListings()).find(item => item.id === favoriteId).favorite, true, 'changing city or destination must preserve the original favorite');
    await setField('#commuteInput', '\u897f\u76f4\u95e8');
    await page.locator('#showFavorites').click();
    await countCards(1);
    await setField('#commuteMaxKm', '3');
    await page.waitForFunction(() => !document.querySelector('#calculateCommuteBtn').disabled);
    await countCards(1);
    await page.locator('#showFavorites').click();
    await countCards(3);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#toast')).opacity === '0');

    fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1040 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow at ${width}px`);
      await page.screenshot({ path: path.join(__dirname, `../test-results/commute-${width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('Commute UI checks passed: bounded calculation, inclusive radius, unknown exclusion, validation, persistence, stale responses, city changes, favorites, desktop/mobile.');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
