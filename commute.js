'use strict';

const { getDistance } = require('geolib');

const queues = new Map();
const compact = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const targetKey = (city, commute) => JSON.stringify([compact(city), compact(commute)]);
const nameKey = value => compact(value).replace(/[\s·・\-—()（）]/g, '').replace(/(?:小区|社区|住宅区)$/u, '');
const cityKey = value => compact(value).split(/[·・\s]/)[0].replace(/市$/u, '');

function apiError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function coordinates(value) {
  if (!value || typeof value !== 'object') return null;
  const longitude = Array.isArray(value) ? value[0] : value.longitude ?? value.lng ?? value.lon;
  const latitude = Array.isArray(value) ? value[1] : value.latitude ?? value.lat;
  if ([longitude, latitude].some(v => v === null || v === undefined || v === '' || typeof v === 'boolean')) return null;
  const point = { latitude: Number(latitude), longitude: Number(longitude) };
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) return null;
  return point;
}

function coordinateText(value) {
  const match = String(value || '').trim().match(/^([+-]?\d+(?:\.\d+)?)\s*[,，]\s*([+-]?\d+(?:\.\d+)?)$/);
  return match ? coordinates([match[1], match[2]]) : null;
}

// AMap returns GCJ-02. Convert to WGS84 before mixing with OpenStreetMap or
// explicit coordinates; the numerical inverse is accurate to a few metres.
function gcjToWgs(point) {
  const { longitude: lng, latitude: lat } = point;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return point;
  const offset = (lon, latitude) => {
    const x = lon - 105, y = latitude - 35, pi = Math.PI;
    let dy = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    let dx = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    const shared = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
    dy += shared + (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3 + (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
    dx += shared + (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3 + (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
    const rad = latitude / 180 * pi, magic = 1 - 0.00669342162296594323 * Math.sin(rad) ** 2;
    return { latitude: dy * 180 / ((6378245 * (1 - 0.00669342162296594323) / (magic * Math.sqrt(magic))) * pi), longitude: dx * 180 / (6378245 / Math.sqrt(magic) * Math.cos(rad) * pi) };
  };
  let result = { ...point };
  for (let i = 0; i < 3; i++) {
    const delta = offset(result.longitude, result.latitude);
    result = { latitude: lat - delta.latitude, longitude: lng - delta.longitude };
  }
  return result;
}

function addressQuery(value, city) {
  const original = String(value || '').trim();
  const last = original.split(/\s*[-—|｜·]\s*/).filter(Boolean).at(-1) || '';
  const cityName = cityKey(city);
  const query = last.startsWith(cityName) ? last.slice(cityName.length).replace(/^市?\s*/, '') : last;
  return query;
}

function chooseMatch(matches) {
  if (!matches.length) return null;
  const first = matches[0];
  // Identically named places in different neighbourhoods need a more specific address.
  if (matches.slice(1).some(match => getDistance(first, match) > 1500)) return null;
  return first;
}

function photonMatch(payload, city, query) {
  const wanted = nameKey(query);
  const matches = (payload.features || []).flatMap(feature => {
    const p = feature.properties || {};
    const point = coordinates(feature.geometry?.coordinates);
    const region = [p.city, p.state, p.county, p.district].map(cityKey).join(' ');
    if (!point || String(p.countrycode || '').toUpperCase() !== 'CN' || !region.includes(cityKey(city))) return [];
    const residential = p.osm_key === 'landuse' && p.osm_value === 'residential';
    if (['country', 'state', 'county', 'city', 'district', 'suburb'].includes(p.type) || (p.type === 'locality' && !residential) || p.osm_key === 'boundary' || ['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood', 'county', 'state'].includes(p.osm_value)) return [];
    const label = String(p.name || [p.street, p.housenumber].filter(Boolean).join(''));
    const found = nameKey(label);
    // Avoid interpreting a shop whose name merely contains the requested estate as the estate itself.
    if (!found || !wanted || !(wanted === found || (wanted.includes(found) && found.length >= 2))) return [];
    return [{ ...point, label, provider: 'photon', coordinateSystem: 'wgs84', residential }];
  });
  const residential = matches.filter(match => match.residential);
  const selected = chooseMatch(residential.length ? residential : matches);
  if (selected) delete selected.residential;
  return selected;
}

function amapMatch(payload, city) {
  if (String(payload.status) !== '1') throw apiError(503, '高德地址服务暂不可用，请检查服务配置。', 'GEOCODE_UNAVAILABLE');
  return chooseMatch((payload.geocodes || []).flatMap(result => {
    if (!['门牌号', '兴趣点', '道路', '交叉路口'].includes(result.level)) return [];
    if (!cityKey([result.city, result.province].flat().filter(Boolean).join(' ')).includes(cityKey(city))) return [];
    const point = coordinateText(result.location);
    return point ? [{ ...gcjToWgs(point), label: result.formatted_address, provider: 'amap', coordinateSystem: 'wgs84' }] : [];
  }));
}

function createCommuteService(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const apiKey = options.amapKey ?? process.env.AMAP_WEB_SERVICE_KEY ?? process.env.AMAP_KEY ?? '';
  const provider = apiKey ? 'amap' : 'photon';
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = Math.min(options.timeoutMs || 8000, 8000);
  const ttlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
  const maxCache = Math.max(1, options.maxCache ?? 1500);
  const cache = new Map(), pending = new Map();
  if (!queues.has(provider)) queues.set(provider, { tail: Promise.resolve(), lastStart: -Infinity });
  const queue = options.fetchImpl ? { tail: Promise.resolve(), lastStart: -Infinity } : queues.get(provider);

  function request(url) {
    const job = queue.tail.then(async () => {
      const wait = Math.max(0, queue.lastStart + intervalMs - now());
      if (wait) await sleep(wait);
      queue.lastStart = now();
      const controller = new AbortController();
      let timer;
      try {
        // Race as well as abort so custom fetch implementations cannot hang the queue.
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'RentRadar/0.1 (local rental distance lookup)' }, signal: controller.signal });
            if (!response.ok) throw new Error(`Geocoder HTTP ${response.status}`);
            return response.json();
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Geocoder timed out')); }, timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    });
    queue.tail = job.catch(() => {});
    return job;
  }

  async function geocode(city, query) {
    const explicit = coordinateText(query);
    if (explicit) return { ...explicit, label: query, provider: 'coordinates', coordinateSystem: 'wgs84' };
    if (!query || /^[\d\s,+.，-]+$/.test(query) || query.length > 200 || cityKey(query) === cityKey(city)) return null;
    const key = targetKey(city, query);
    const old = cache.get(key);
    if (old && old.expires > now()) return old.value;
    if (old) cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    const promise = (async () => {
      const url = new URL(apiKey ? 'https://restapi.amap.com/v3/geocode/geo' : 'https://photon.komoot.io/api/');
      if (apiKey) {
        url.searchParams.set('key', apiKey);
        url.searchParams.set('city', cityKey(city));
        url.searchParams.set('address', query);
      } else {
        url.searchParams.set('q', `${cityKey(city)} ${query}`);
        url.searchParams.set('limit', '3');
      }
      const payload = await request(url.toString());
      const result = apiKey ? amapMatch(payload, city) : photonMatch(payload, city, query);
      cache.set(key, { value: result, expires: now() + (result ? ttlMs : Math.min(ttlMs, 5 * 60 * 1000)) });
      while (cache.size > maxCache) cache.delete(cache.keys().next().value);
      return result;
    })();
    pending.set(key, promise);
    try { return await promise; } finally { pending.delete(key); }
  }

  async function calculate(input = {}) {
    const city = compact(input.city), commute = String(input.commute || '').trim();
    if (!city || city.length > 80 || !commute || commute.length > 200 || !Array.isArray(input.listings)) throw apiError(400, '请填写城市、通勤地点和房源列表。', 'INVALID_COMMUTE_INPUT');
    if (input.listings.length > 10) throw apiError(400, '每次最多计算 10 套房源的距离。', 'COMMUTE_BATCH_LIMIT');
    let target;
    try { target = await geocode(city, commute); }
    catch (_) { throw apiError(503, '地址服务暂不可用，请稍后重试，或填写通勤地点的“经度,纬度”。', 'GEOCODE_UNAVAILABLE'); }
    if (!target) throw apiError(422, '无法准确定位通勤地点，请填写具体地址、地标，或“经度,纬度”。', 'COMMUTE_NOT_FOUND');
    const key = targetKey(input.city, input.commute);
    const results = await Promise.all(input.listings.map(async listing => {
      const row = { id: listing?.id, distanceKm: null, distanceTarget: key, geocodeStatus: 'not_found' };
      if (!listing || typeof listing !== 'object') return row;
      try {
        const raw = listing.coordinates || listing;
        let point = coordinates(raw);
        if (point && (raw.coordinateSystem === 'gcj02' || raw.coordinateSystem === 'gcj-02' || (raw.provider === 'amap' && raw.coordinateSystem !== 'wgs84'))) point = gcjToWgs(point);
        if (!point) point = await geocode(listing.city || city, addressQuery(listing.address || listing.location, listing.city || city));
        if (point) {
          row.distanceKm = getDistance(target, point) / 1000;
          row.geocodeStatus = 'resolved';
          row.coordinates = { latitude: point.latitude, longitude: point.longitude, coordinateSystem: 'wgs84', provider: point.provider || 'coordinates' };
        }
      } catch (_) { row.geocodeStatus = 'error'; }
      return row;
    }));
    return { target: { ...target, key, city: input.city, query: commute }, listings: results, message: '距离为直线距离；无法准确定位的房源不计入距离范围。' };
  }

  return { calculate };
}

module.exports = { createCommuteService, targetKey };
