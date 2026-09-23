'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommuteService, targetKey } = require('../commute');

const feature = (name, longitude = 116.4556474, latitude = 39.9070164, extras = {}) => ({ geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties: { countrycode: 'CN', city: '北京市', type: 'house', name, ...extras } });
const reply = (...features) => ({ ok: true, json: async () => ({ features }) });
const makeService = fetchImpl => createCommuteService({ amapKey: '', intervalMs: 0, fetchImpl });

test('explicit coordinates give real finite distances and stable target keys', async () => {
  const service = makeService(() => { throw new Error('unexpected geocoder request'); });
  const result = await service.calculate({ city: '北京', commute: '116.4,39.9', listings: [{ id: 'near', longitude: 116.41, latitude: 39.9 }, { id: 'far', coordinates: [116.5, 39.9] }, { id: 'null', coordinates: { latitude: null, longitude: null } }] });
  assert.ok(result.listings[0].distanceKm > 0.8 && result.listings[0].distanceKm < 0.9);
  assert.ok(result.listings[1].distanceKm > 8);
  assert.equal(result.listings[2].distanceKm, null);
  assert.equal(result.listings[2].geocodeStatus, 'not_found');
  assert.equal(result.target.key, targetKey('北京', '116.4,39.9'));
  assert.notEqual(result.target.key, targetKey('北京', '116.41,39.9'));
  assert.equal(targetKey(' 北京 ', '  A   B '), '["北京","a b"]');
});

test('geocoding strips region prefixes, caches targets and deduplicates matching addresses', async () => {
  const queries = [];
  const service = makeService(async url => {
    const q = new URL(url).searchParams.get('q');
    queries.push(q);
    return q.endsWith('国贸') ? reply(feature('国贸')) : reply(feature('九龙花园', 116.468, 39.889));
  });
  const input = { city: '北京', commute: '国贸', listings: [{ id: 'one', address: '朝阳区 - 双井 - 九龙花园' }, { id: 'two', location: '九龙花园' }] };
  const result = await service.calculate(input);
  assert.deepEqual(queries, ['北京 国贸', '北京 九龙花园']);
  assert.ok(result.listings.every(row => row.geocodeStatus === 'resolved' && row.distanceKm > 1));
  await service.calculate(input);
  assert.equal(queries.length, 2);
});

test('does not use administrative centres, mismatched names or a different city', async () => {
  const service = makeService(async url => {
    const q = new URL(url).searchParams.get('q');
    if (q.endsWith('模糊地点')) return reply(feature('模糊地点', 116.4, 39.9, { type: 'district' }));
    if (q.endsWith('别处')) return reply(feature('别处', 121.4, 31.2, { city: '上海市' }));
    return reply(feature('九龙花园便利店'));
  });
  await assert.rejects(service.calculate({ city: '北京', commute: '模糊地点', listings: [] }), { status: 422 });
  const result = await service.calculate({ city: '北京', commute: '116.4,39.9', listings: [{ id: 1, address: '别处' }, { id: 2, address: '九龙花园' }, { id: 3, address: '朝阳区' }] });
  assert.ok(result.listings.every(row => row.distanceKm === null && row.geocodeStatus === 'not_found'));
});

test('ambiguous same-name places far apart are left unresolved', async () => {
  const service = makeService(async () => reply(feature('万达广场', 116.4, 39.9), feature('万达广场', 116.5, 39.9)));
  await assert.rejects(service.calculate({ city: '北京', commute: '万达广场', listings: [] }), { status: 422 });
});

test('residential locality geometry takes precedence over a same-name bus stop', async () => {
  const service = makeService(async () => reply(feature('九龙花园', 116.46, 39.89, { type: 'house', osm_key: 'highway', osm_value: 'bus_stop' }), feature('九龙花园', 116.47, 39.89, { type: 'locality', osm_key: 'landuse', osm_value: 'residential' })));
  const result = await service.calculate({ city: '北京', commute: '九龙花园', listings: [] });
  assert.equal(result.target.longitude, 116.47);
});

test('estate names ending in the district character remain geocodable', async () => {
  const service = makeService(async () => reply(feature('幸福小区', 116.46, 39.89, { type: 'locality', osm_key: 'landuse', osm_value: 'residential' })));
  const result = await service.calculate({ city: '北京', commute: '幸福小区', listings: [] });
  assert.equal(result.target.label, '幸福小区');
});

test('invalid inputs and coordinates are rejected without network access', async () => {
  let called = false;
  const service = makeService(async () => { called = true; return reply(); });
  await assert.rejects(service.calculate({ city: '', commute: '国贸', listings: [] }), { status: 400 });
  await assert.rejects(service.calculate({ city: '北京', commute: '181,91', listings: [] }), { status: 422 });
  await assert.rejects(service.calculate({ city: '北京', commute: '国贸', listings: new Array(11).fill({}) }), { status: 400 });
  const result = await service.calculate({ city: '北京', commute: '116,39', listings: [{ id: 1, coordinates: { latitude: Infinity, longitude: 116 } }, { id: 2, longitude: '', latitude: '' }] });
  assert.ok(result.listings.every(row => row.distanceKm === null));
  assert.equal(called, false);
});

test('one geocoder failure does not prevent distances for other listings', async () => {
  const service = makeService(async url => {
    if (new URL(url).searchParams.get('q').endsWith('失败地点')) throw new Error('offline');
    return reply(feature('九龙花园'));
  });
  const result = await service.calculate({ city: '北京', commute: '116,39', listings: [{ id: 1, address: '失败地点' }, { id: 2, address: '九龙花园' }] });
  assert.equal(result.listings[0].geocodeStatus, 'error');
  assert.equal(result.listings[1].geocodeStatus, 'resolved');
  await assert.rejects(service.calculate({ city: '北京', commute: '失败地点', listings: [] }), { status: 503 });
});

test('provider requests are serialized and respect the minimum interval', async () => {
  let time = 0;
  const starts = [], waits = [];
  const service = createCommuteService({ amapKey: '', intervalMs: 1000, now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, fetchImpl: async url => {
    starts.push(time);
    return reply(feature(new URL(url).searchParams.get('q').replace('北京 ', '')));
  } });
  await service.calculate({ city: '北京', commute: '国贸', listings: [{ id: 1, address: '九龙花园' }, { id: 2, address: '金茂府' }] });
  assert.deepEqual(starts, [0, 1000, 2000]);
  assert.deepEqual(waits, [1000, 1000]);
});

test('cache expires and remains bounded', async () => {
  let time = 0, calls = 0;
  const service = createCommuteService({ amapKey: '', intervalMs: 0, now: () => time, cacheTtlMs: 10, maxCache: 1, fetchImpl: async url => {
    calls++;
    return reply(feature(new URL(url).searchParams.get('q').replace('北京 ', '')));
  } });
  const calculate = commute => service.calculate({ city: '北京', commute, listings: [] });
  await calculate('国贸'); await calculate('国贸'); assert.equal(calls, 1);
  time = 11;
  await calculate('国贸'); assert.equal(calls, 2);
  await calculate('金茂府'); await calculate('国贸'); assert.equal(calls, 4);
});

test('AMap administrative geocodes are rejected and GCJ02 points become WGS84', async () => {
  let broad = false;
  const service = createCommuteService({ amapKey: 'test-key', intervalMs: 0, fetchImpl: async () => ({ ok: true, json: async () => ({ status: '1', geocodes: [{ city: '北京市', province: '北京市', level: broad ? '区县' : '兴趣点', location: '116.410244,39.916404', formatted_address: '国贸' }] }) }) });
  const result = await service.calculate({ city: '北京', commute: '国贸', listings: [{ id: 1, longitude: 116.404, latitude: 39.915 }] });
  assert.equal(result.target.provider, 'amap');
  assert.equal(result.target.coordinateSystem, 'wgs84');
  assert.ok(result.listings[0].distanceKm < 0.02);
  broad = true;
  await assert.rejects(service.calculate({ city: '北京', commute: '新的地点', listings: [] }), { status: 422 });
});

test('reverseGeocode resolves coordinates to city, district and address', async () => {
  const service = makeService(async url => {
    assert.match(url, /reverse\?lat=39\.9042&lon=116\.4074/);
    return reply({
      properties: {
        city: '北京市',
        district: '东城区',
        street: '台基厂头条',
        name: '台基厂头条14号院-10号院',
      }
    });
  });
  const loc = await service.reverseGeocode({ latitude: 39.9042, longitude: 116.4074 });
  assert.equal(loc.city, '北京');
  assert.equal(loc.district, '东城区');
  assert.equal(loc.cityFormatted, '北京 · 东城区');
  assert.match(loc.address, /台基厂头条/);
  assert.equal(loc.latitude, 39.9042);
  assert.equal(loc.longitude, 116.4074);
  await assert.rejects(service.reverseGeocode({ latitude: 'invalid' }), { status: 400 });
});

test('targetCoordinates can bypass commute text geocoding and calculate distance directly', async () => {
  const service = makeService(() => { throw new Error('geocoder should not be called'); });
  const result = await service.calculate({
    city: '北京',
    commute: '我的定位地点',
    targetCoordinates: { latitude: 39.9, longitude: 116.4 },
    listings: [{ id: 1, longitude: 116.41, latitude: 39.9 }]
  });
  assert.equal(result.target.provider, 'coordinates');
  assert.ok(result.listings[0].distanceKm > 0.8 && result.listings[0].distanceKm < 0.9);
});

