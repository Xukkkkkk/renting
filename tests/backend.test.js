'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const search = require('../platform-search');
const { createServer, createContext, handleSearch, listingMatchesQuery } = require('../server');

const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/platform-listings.html'), 'utf8');

test('query encoding retains district, filters, share type, keyword, pagination', () => {
  const query = search.normalizeQuery({ city: '北京 · 朝阳区', rentMin: 4000, rentMax: 6000, area: '50,70', layout: '合租', keyword: '双井', pages: 3 });
  const url = new URL(search.makePlatformSearchUrl('链家', query, 2));
  assert.equal(query.city, '北京');
  assert.equal(query.district, '朝阳区');
  assert.equal(query.limit, 90);
  assert.match(url.pathname, /pg2/);
  assert.match(url.pathname, /brp4000erp6000bp50ep70/);
  assert.match(url.pathname, /rt200600000002/);
  assert.match(url.searchParams.get('keyword'), /双井/);
  assert.throws(() => search.normalizeQuery({ city: '火星' }), /不支持的城市/);
  assert.throws(() => search.normalizeQuery({ city: '北京', rentMin: 6000, rentMax: 4000 }), /最低值/);
});

test('HTML parser uses complete cards, stable house IDs and unknown numbers', () => {
  assert.equal(search.containsCaptcha(fixture), false);
  const rows = search.parsePlatformHtml(fixture, '链家', '北京', 'https://bj.lianjia.com/zufang/');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, '链家:北京:BJ100000001');
  assert.equal(rows[0].city, '北京');
  assert.equal(rows[0].rent, 5200);
  assert.equal(rows[0].area, 52.5);
  assert.equal(rows[0].layout, '1室1厅1卫');
  assert.match(rows[0].address, /九龙花园/);
  assert.equal(rows[1].rent, null);
  assert.equal(rows[1].rentMin, 6000);
  assert.equal(rows[1].rentMax, 6800);
  assert.equal(rows[2].rent, null);
  assert.equal(rows[2].area, null);
  assert.equal(rows[2].layout, null);
  assert.equal(search.containsCaptcha('<html><body>请完成滑块验证</body></html>'), true);
});

test('empty sources perform no reads, cached and concurrent queries reuse reads', async () => {
  let calls = 0;
  const context = createContext({ minPlatformIntervalMs: 0, fetchText: async () => { calls += 1; return fixture; } });
  const empty = await handleSearch({ city: '北京', sources: [] }, context);
  assert.deepEqual(empty.results, []);
  assert.equal(calls, 0);
  const query = { city: '北京', sources: ['链家'] };
  const [a, b] = await Promise.all([handleSearch(query, context), handleSearch(query, context)]);
  assert.equal(calls, 1);
  assert.equal(a.listings.length, 3);
  assert.deepEqual(a.results, b.results);
  await handleSearch(query, context);
  assert.equal(calls, 1);
});

test('a login-only condition path falls back once to public city list and filters', async () => {
  const urls = [];
  const context = createContext({ minPlatformIntervalMs: 0, fetchText: async (url) => { urls.push(url); return url.includes('brp') ? '<html><body>1123 LOGIN 请先登录</body></html>' : fixture; } });
  const result = await handleSearch({ city: '北京', rentMin: 5000, rentMax: 5500, sources: ['链家'] }, context);
  assert.equal(urls.length, 2);
  assert.equal(result.results[0].status, 'limited');
  assert.match(result.results[0].message, /非全量搜索/);
  assert.equal(result.listings.length, 1);
  assert.match(result.results[0].searchUrl, /brp5000erp5500/);
});

test('API rejects malformed/large JSON, unknown cities and hides server/profile files', async (t) => {
  const server = createServer({ minPlatformIntervalMs: 0, fetchText: async () => fixture });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${root}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post(JSON.stringify({ city: '火星' }))).status, 400);
  assert.equal((await post(JSON.stringify({ city: '北京', extra: 'x'.repeat(18000) }))).status, 413);
  assert.equal((await fetch(`${root}/api/search`)).status, 405);
  assert.equal((await fetch(`${root}/server.js`)).status, 404);
  assert.equal((await fetch(`${root}/.browser-profile/Cookies`)).status, 404);
  assert.equal((await fetch(`${root}/vendor/lucide.js`)).status, 200);
});

test('browser open forwards JSON and exposes adapter response without secrets', async (t) => {
  let seen;
  const server = createServer({ xhsAdapter: { openBrowser: async (query) => { seen = query; return { opened: true, token: 'secret' }; } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/browser/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: '北京', keyword: '租房' }) });
  assert.equal(response.status, 200);
  assert.equal(seen.city, '北京');
  const body = await response.json();
  assert.deepEqual(body.result, { opened: true });
  const denied = await fetch(`http://127.0.0.1:${server.address().port}/api/browser/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(denied.status, 403);
});

test('partial pagination retains fetched results when a later page is blocked', async () => {
  const context = createContext({ minPlatformIntervalMs: 0, fetchText: async url => url.includes('pg2') ? '<html><body>请完成滑块验证</body></html>' : fixture });
  const result = await handleSearch({ city: '北京', sources: ['链家'], pages: 2 }, context);
  assert.equal(result.results[0].status, 'limited');
  assert.equal(result.listings.length, 3);
});

test('layout and budget matching use known values and exact room counts', () => {
  const query = search.normalizeQuery({ city: '北京', layout: '两室一厅', rentMax: 6000 });
  assert.equal(listingMatchesQuery({ layout: '2室1厅1卫', rent: 5200 }, query), true);
  assert.equal(listingMatchesQuery({ layout: '12室1厅1卫', rent: 5200 }, query), false);
  assert.equal(listingMatchesQuery({ layout: '2室1厅1卫', rent: null }, query), false);
  assert.equal(listingMatchesQuery({ title: '合租·主卧', layout: '3室1厅', rent: 3000 }, { ...query, layout: '合租' }), true);
  assert.equal(listingMatchesQuery({ layout: '1室0厅1卫', rent: 3000 }, { ...query, layout: '开间' }), true);
});

test('blocked login results are not cached', async () => {
  let calls = 0;
  const context = createContext({ xhsAdapter: { fetchXhs: async () => { calls += 1; return { status: 'needs_login', listings: [] }; } } });
  await handleSearch({ city: '北京', sources: ['小红书'] }, context);
  await handleSearch({ city: '北京', sources: ['小红书'] }, context);
  assert.equal(calls, 2);
});

test('commute API uses the canonical city and preserves unresolved distances', async (t) => {
  let input;
  const server = createServer({ commuteService: { calculate: async body => {
    input = body;
    return { target: { key: '["北京","国贸"]' }, listings: [{ id: 'saved-id', distanceKm: null, geocodeStatus: 'not_found' }] };
  } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(`${root}/api/commute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: '北京 · 朝阳区', commute: '国贸', listings: [{ id: 'saved-id', address: '九龙花园' }] }) });
  assert.equal(result.status, 200);
  assert.equal(input.city, '北京');
  assert.equal(input.commute, '国贸');
  const payload = await result.json();
  assert.equal(payload.listings[0].distanceKm, null);
  assert.equal((await fetch(`${root}/api/commute`)).status, 405);
});

test('location API returns reverse geocoded location from coordinates or IP', async (t) => {
  let queriedCoords;
  const server = createServer({
    commuteService: {
      reverseGeocode: async (coords) => {
        queriedCoords = coords;
        return { city: '北京', district: '东城区', cityFormatted: '北京 · 东城区', address: '王府井' };
      },
      locateIp: async () => {
        return { city: '上海', district: '黄浦区', cityFormatted: '上海 · 黄浦区', address: '南京路' };
      }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;

  const res1 = await fetch(`${root}/api/location`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: 39.9, longitude: 116.4 })
  });
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.ok, true);
  assert.equal(data1.location.cityFormatted, '北京 · 东城区');
  assert.deepEqual(queriedCoords, { latitude: 39.9, longitude: 116.4 });

  const res2 = await fetch(`${root}/api/location`, { method: 'GET' });
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.ok, true);
  assert.equal(data2.location.cityFormatted, '上海 · 黄浦区');

  assert.equal((await fetch(`${root}/api/location`, { method: 'DELETE' })).status, 405);
});

test('subway normalization, aliases and listing subway filtering', () => {
  const query = search.normalizeQuery({ city: '北京', subway: '10号线' });
  assert.equal(query.subway, '10号线');

  const terms = search.subwaySearchTerms('10号线');
  assert.ok(terms.includes('10号线'));
  assert.ok(terms.includes('十号线'));

  const slashTerms = search.subwaySearchTerms('1号线/八通线');
  assert.ok(slashTerms.includes('1号线'));
  assert.ok(slashTerms.includes('八通线'));

  assert.equal(listingMatchesQuery({ title: '近地铁十号线双井站', address: '双井' }, query), true);
  assert.equal(listingMatchesQuery({ title: '近地铁10号线双井站', address: '双井' }, query), true);
  assert.equal(listingMatchesQuery({ title: '近地铁13号线望京西站', address: '望京' }, query), false);
  assert.equal(listingMatchesQuery({ title: '普通住宅无地铁信息', address: '平谷' }, query), false);

  const lianjiaUrl = search.makePlatformSearchUrl('链家', query, 1);
  assert.match(decodeURIComponent(lianjiaUrl), /10号线/);
});

