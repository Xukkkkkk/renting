'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server');

async function run() {
  const customFixture = `
    <div class="content__list--item" data-house_code="BJ1001">
      <div class="content__list--item--des">
        <p class="content__list--item--title"><a href="https://bj.lianjia.com/zufang/BJ1001.html">近地铁10号线双井站 精装一居</a></p>
        <p class="content__list--item--des">朝阳区 · 双井 / 50㎡ / 南 / 1室1厅1卫</p>
      </div>
      <span class="content__list--item-price"><em>5000</em> 元/月</span>
    </div>
    <div class="content__list--item" data-house_code="BJ1002">
      <div class="content__list--item--des">
        <p class="content__list--item--title"><a href="https://bj.lianjia.com/zufang/BJ1002.html">近地铁13号线望京西站 两居室合租</a></p>
        <p class="content__list--item--des">朝阳区 · 望京 / 25㎡ / 北 / 2室1厅1卫</p>
      </div>
      <span class="content__list--item-price"><em>3200</em> 元/月</span>
    </div>
    <div class="content__list--item" data-house_code="BJ1003">
      <div class="content__list--item--des">
        <p class="content__list--item--title"><a href="https://bj.lianjia.com/zufang/BJ1003.html">国贸大望路整租一居 近十号线</a></p>
        <p class="content__list--item--des">朝阳区 · 大望路 / 55㎡ / 南 / 1室1厅1卫</p>
      </div>
      <span class="content__list--item-price"><em>6500</em> 元/月</span>
    </div>
  `;

  let lastSearchBody = null;
  const server = createServer({
    minPlatformIntervalMs: 0,
    fetchText: async () => customFixture,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    page.on('request', req => {
      if (req.url().endsWith('/api/search') && req.method() === 'POST') {
        lastSearchBody = req.postDataJSON();
      }
    });

    await page.goto(origin);

    // Verify initial city input北京 populates subway lines
    await page.locator('#cityInput').fill('北京');
    await page.locator('#cityInput').dispatchEvent('input');

    const optionsCount = await page.locator('#subwaySelect option').count();
    assert.ok(optionsCount > 5, 'Subway select should be populated with Beijing subway lines');

    // Check quick tags are rendered
    const quickTags = await page.locator('#subwayQuickTags button').allInnerTexts();
    assert.ok(quickTags.length > 0, 'Subway quick tags should be displayed');
    assert.ok(quickTags.includes('10号线') || quickTags.includes('1号线/八通线'), 'Popular lines should appear in quick tags');

    // Click 10号线 quick tag or select it
    await page.locator('#subwaySelect').selectOption('10号线');
    await page.locator('#subwaySelect').dispatchEvent('change');

    // Check query preview shows subway
    const preview = await page.locator('#queryPreview').innerText();
    assert.match(preview, /10号线/, 'Query preview should show 10号线');

    // Trigger search
    // Uncheck other sources except 链家 to be fast
    await page.locator('[data-preset="none"]').click();
    await page.locator('input[value="链家"]').check();
    await page.locator('input[value="链家"]').dispatchEvent('change');

    await page.locator('#runSearchBtn').click();
    await page.waitForFunction(() => !document.querySelector('#runSearchBtn').disabled);

    assert.equal(lastSearchBody.subway, '10号线', 'Search request should contain subway: 10号线');

    // In fixture, BJ1001 (10号线) and BJ1003 (十号线) match, while BJ1002 (13号线) is filtered out by query
    const cards = await page.locator('.listing-card').count();
    assert.equal(cards, 2, 'Should match 2 listings along line 10 (including Chinese numeral alias 十号线)');

    // Verify subway chip is rendered on card
    const subwayChips = await page.locator('.subway-chip').allInnerTexts();
    assert.ok(subwayChips.length >= 2, 'Matching listings should show subway chip');

    // Change subway line to 13号线 - should show 0 because backend query only fetched 10号线
    // Now let's clear subway
    await page.locator('#clearSubway').click();
    // Re-fetch all
    await page.locator('#runSearchBtn').click();
    await page.waitForFunction(() => !document.querySelector('#runSearchBtn').disabled);
    assert.equal(await page.locator('.listing-card').count(), 3, 'All 3 listings should appear when subway filter is cleared');

    // Now filter locally by selecting 13号线
    await page.locator('#subwaySelect').selectOption('13号线');
    await page.locator('#subwaySelect').dispatchEvent('change');
    assert.equal(await page.locator('.listing-card').count(), 1, 'Local filtering should only show 13号线 listing');

    // Take screenshot of desktop
    fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../test-results/subway-desktop.png') });

    // Mobile check
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(__dirname, '../test-results/subway-mobile.png') });

    assert.equal(errors.length, 0, `No errors should occur: ${errors.join(', ')}`);
    console.log('Subway UI test passed successfully!');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
