'use strict';

/*
 * Local-only connector service for Rent Radar.
 *
 * Public HTML readers and a user-controlled local XHS browser share one API.
 * Browser profile files are never served over HTTP.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const search = require('./platform-search');
const { createCommuteService } = require('./commute');

const ROOT = __dirname;
const PORT = Number(process.env.RENT_RADAR_PORT || 8787);
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 16 * 1024;
const CACHE_TTL_MS = 60 * 1000;
const MIN_PLATFORM_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 12 * 1000;
const MAX_ITEMS_PER_SOURCE = search.MAX_ITEMS_PER_SOURCE;

const STATIC_FILES = Object.freeze({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/styles.css': 'styles.css',
  '/vendor/lucide.js': 'node_modules/lucide/dist/umd/lucide.js',
});

const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

const SOURCE_NAMES = new Set(search.SUPPORTED_SOURCES);

class ApiError extends Error {
  constructor(status, message, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function loadXhsAdapter() {
  try {
    // Kept as a runtime require so the XHS adapter can be developed or
    // deployed independently from this local connector.
    const adapter = require('./xhs-adapter');
    return {
      fetchXhs: typeof adapter.fetchXhs === 'function' ? adapter.fetchXhs : null,
      openBrowser: typeof adapter.openBrowser === 'function' ? adapter.openBrowser : null,
      closeBrowser: typeof adapter.closeBrowser === 'function' ? adapter.closeBrowser : null,
    };
  } catch (_) {
    return { fetchXhs: null, openBrowser: null, closeBrowser: null };
  }
}

function isLoopback(address) {
  if (!address) return true;
  const normalized = String(address).replace(/^::ffff:/i, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function canonicalQuery(query) {
  const keys = Object.keys(query).sort();
  return JSON.stringify(keys.reduce((result, key) => {
    result[key] = query[key];
    return result;
  }, {}));
}

function createContext(options = {}) {
  return {
    cache: new Map(),
    inflight: new Map(),
    lastFetch: new Map(),
    platformQueues: new Map(),
    fetchText: options.fetchText || fetchText,
    xhsAdapter: options.xhsAdapter || loadXhsAdapter(),
    commuteService: options.commuteService || createCommuteService(),
    now: options.now || (() => Date.now()),
    cacheTtlMs: options.cacheTtlMs || CACHE_TTL_MS,
    minPlatformIntervalMs: options.minPlatformIntervalMs ?? MIN_PLATFORM_INTERVAL_MS,
    requestTimeoutMs: options.requestTimeoutMs || REQUEST_TIMEOUT_MS,
  };
}

function errorMessage(error) {
  if (error?.code === 'CAPTCHA') return '平台返回验证码或访问验证页面，请打开官方入口完成查看';
  if (error?.name === 'AbortError') return '平台请求超时，请稍后重试或打开官方入口';
  return error?.message || '平台请求失败';
}

function platformResult(source, status, message, searchUrl, listings = []) {
  return {
    source,
    status,
    message,
    count: listings.length,
    listings,
    searchUrl,
  };
}

function looksLikeLoginPage(html = '') {
  const text = String(html);
  if (/class=["'][^"']*\bcontent__list--item(?:\s|["'])/i.test(text)) return false;
  return /(?:^|\D)(?:1123|401|403)(?:\D|$)/.test(text)
    || /登录后查看|请先登录|passport\/login|login\.html|登录验证/i.test(text);
}

function listingMatchesQuery(listing, query) {
  const rentMin = listing.rentMin ?? listing.rent;
  const rentMax = listing.rentMax ?? listing.rent;
  if (query.rentMin !== null && (rentMax === null || rentMax === undefined || rentMax < query.rentMin)) return false;
  if (query.rentMax !== null && (rentMin === null || rentMin === undefined || rentMin > query.rentMax)) return false;
  if (query.areaMin !== null && (listing.area === null || listing.area === undefined || listing.area < query.areaMin)) return false;
  if (query.areaMax !== null && (listing.area === null || listing.area === undefined || listing.area > query.areaMax)) return false;
  const normalizeLayout = (value) => String(value || '').replace(/一/g, '1').replace(/二|两/g, '2').replace(/三/g, '3').replace(/四/g, '4').replace(/五/g, '5');
  if (query.layout === '合租') {
    if (!/合租/.test(`${listing.rentType || ''} ${listing.title || ''}`)) return false;
  } else if (query.layout === '开间') {
    if (!/开间|一居|1室0厅/.test(String(listing.layout || ''))) return false;
  } else if (query.layout) {
    const wanted = normalizeLayout(query.layout).match(/(\d+)室(?:(\d+)厅)?/);
    const actual = normalizeLayout(listing.layout).match(/(\d+)室(?:(\d+)厅)?/);
    if (wanted && (!actual || actual[1] !== wanted[1] || (wanted[2] && actual[2] !== wanted[2]))) return false;
    if (!wanted && normalizeLayout(listing.layout) !== normalizeLayout(query.layout)) return false;
  }
  const locationText = `${listing.address || ''} ${listing.location || ''}`;
  const district = String(query.district || '').replace(/[区县市]$/, '');
  if (district && !locationText.includes(district)) return false;
  if (query.keyword && !`${listing.title || ''} ${locationText} ${listing.raw || ''}`.includes(query.keyword)) return false;
  return true;
}

function normalizeListing(item, source, city, index = 0) {
  const url = typeof item?.url === 'string' ? item.url : '';
  const code = item?.id && String(item.id).includes(':') ? null : (item?.houseCode || item?.house_code || item?.id);
  const id = item?.id || search.stableId(source, city, code, url || `${source}:${city}:${index}`);
  const rent = item?.rent === null || item?.rent === undefined || item?.rent === '' ? null : Number(item.rent);
  const area = item?.area === null || item?.area === undefined || item?.area === '' ? null : Number(item.area);
  return {
    source,
    city,
    id: String(id),
    title: item?.title ? String(item.title) : '未命名房源',
    address: item?.address ? String(item.address) : (item?.location ? String(item.location) : ''),
    location: item?.location ? String(item.location) : (item?.address ? String(item.address) : ''),
    rent: Number.isFinite(rent) ? rent : null,
    area: Number.isFinite(area) ? area : null,
    layout: item?.layout ? String(item.layout) : null,
    url,
    fetchedAt: item?.fetchedAt || new Date().toISOString(),
    ...(item?.rentMin !== undefined ? { rentMin: item.rentMin } : {}),
    ...(item?.rentMax !== undefined ? { rentMax: item.rentMax } : {}),
    ...(['image', 'raw', 'rentType', 'floor', 'contact'].reduce((extra, field) => {
      if (item?.[field] !== undefined) extra[field] = item[field];
      return extra;
    }, {})),
  };
}

async function waitForPlatform(context, source) {
  const now = context.now();
  const last = context.lastFetch.get(source) || 0;
  const wait = context.minPlatformIntervalMs - (now - last);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  context.lastFetch.set(source, context.now());
}

async function readPlatformPage(context, source, url, options = {}) {
  const previous = context.platformQueues.get(source) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    await waitForPlatform(context, source);
    return context.fetchText(url, { requestTimeoutMs: context.requestTimeoutMs, source, ...options });
  });
  context.platformQueues.set(source, current);
  try { return await current; } finally {
    if (context.platformQueues.get(source) === current) context.platformQueues.delete(source);
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'RentRadar/0.1 (local public-page reader)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
      },
    });
    if (!response.ok) {
      const error = new Error(`平台返回 HTTP ${response.status}`);
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function xhsSearchResult(query, adapterResult) {
  const fallbackUrl = search.makePlatformSearchUrl('小红书', query, 1);
  if (Array.isArray(adapterResult)) adapterResult = { listings: adapterResult };
  const sourceResult = adapterResult && typeof adapterResult === 'object' ? adapterResult : {};
  const listings = Array.isArray(sourceResult.listings)
    ? sourceResult.listings.map((item, index) => normalizeListing(item, '小红书', query.city, index))
    : [];
  return platformResult(
    '小红书',
    sourceResult.status || (listings.length ? 'ok' : 'entry'),
    sourceResult.message || (listings.length ? `已获取 ${listings.length} 条公开房源` : '小红书需要在平台内完成授权或搜索'),
    sourceResult.searchUrl || fallbackUrl,
    listings.slice(0, query.limit),
  );
}

async function fetchSourceUncached(source, query, context) {
  const searchUrl = search.makePlatformSearchUrl(source, query, 1);
  if (source === '小红书') {
    if (!context.xhsAdapter.fetchXhs) {
      return platformResult(source, 'entry', '小红书暂无可用授权适配器，已生成官方搜索入口', searchUrl);
    }
    try {
      const result = await context.xhsAdapter.fetchXhs({ ...query });
      return xhsSearchResult(query, result);
    } catch (error) {
      return platformResult(source, 'error', errorMessage(error), searchUrl);
    }
  }

  const allListings = [];
  const seen = new Set();
  let lastUrl = searchUrl;
  try {
    for (let page = 1; page <= query.pages; page += 1) {
      const url = search.makePlatformSearchUrl(source, query, page);
      lastUrl = url;
      const html = await readPlatformPage(context, source, url, { page });
      const challenged = search.containsCaptcha(html);
      let pageListings = challenged ? [] : search.parsePlatformHtml(html, source, query.city, url, query.limit);
      // Some public city pages redirect condition URLs to a login page (for
      // example HTTP 1123). Read the unfiltered public city index once and
      // apply the requested fields locally. This remains a public-page read;
      // no login, token, or challenge bypass is attempted.
      if ((challenged || looksLikeLoginPage(html) || !pageListings.length) && (query.rentMin !== null || query.rentMax !== null || query.areaMin !== null || query.areaMax !== null || query.layout || query.district || query.keyword)) {
        const rootQuery = { ...query, rentMin: null, rentMax: null, areaMin: null, areaMax: null, layout: '', district: '', keyword: '', pages: 1 };
        const rootUrl = search.makePlatformSearchUrl(source, rootQuery, 1);
        const rootHtml = await readPlatformPage(context, source, rootUrl, { page: 1, fallback: true });
        if (search.containsCaptcha(rootHtml) || looksLikeLoginPage(rootHtml)) {
          return platformResult(source, 'blocked', '平台返回登录或访问验证页面，请打开官方入口完成查看', searchUrl, []);
        }
        const rootListings = search.parsePlatformHtml(rootHtml, source, query.city, rootUrl, MAX_ITEMS_PER_SOURCE);
        pageListings = rootListings.filter((listing) => listingMatchesQuery(listing, query));
        for (const listing of pageListings) {
          if (!seen.has(listing.id)) {
            seen.add(listing.id);
            allListings.push(listing);
            if (allListings.length >= query.limit) break;
          }
        }
        if (!allListings.length) return platformResult(source, 'limited', '仅公开城市首页可读取，其中没有符合条件的房源（已在本地筛选，非全量搜索）', searchUrl, []);
        return platformResult(source, 'limited', `仅公开城市首页可读取，本地筛选出 ${allListings.length} 条房源（非全量搜索）`, searchUrl, allListings.slice(0, query.limit));
      }
      if (challenged || looksLikeLoginPage(html)) {
        return platformResult(source, allListings.length ? 'limited' : 'blocked', allListings.length ? `已读取 ${allListings.length} 条；后续页面需要登录，结果范围有限` : '平台返回登录或访问验证页面，请打开官方入口完成查看', searchUrl, allListings);
      }
      for (const listing of pageListings) {
        if (!seen.has(listing.id) && listingMatchesQuery(listing, query)) {
          seen.add(listing.id);
          allListings.push(listing);
          if (allListings.length >= query.limit) break;
        }
      }
      if (allListings.length >= query.limit || pageListings.length === 0) break;
    }
    if (!allListings.length) return platformResult(source, 'empty', '页面已返回，但未解析到公开房源卡片', searchUrl, []);
    return platformResult(source, 'ok', `已获取 ${allListings.length} 条公开房源`, searchUrl, allListings.slice(0, query.limit));
  } catch (error) {
    return platformResult(source, allListings.length ? 'limited' : error?.code === 'CAPTCHA' ? 'blocked' : 'error', allListings.length ? `已读取 ${allListings.length} 条；后续页面获取失败：${errorMessage(error)}` : errorMessage(error), lastUrl, allListings);
  }
}

async function fetchSource(source, query, context) {
  const key = `${source}|${canonicalQuery(query)}`;
  const now = context.now();
  const cached = context.cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (context.inflight.has(key)) return context.inflight.get(key);
  const promise = fetchSourceUncached(source, query, context)
    .then((value) => {
      if (['ok', 'ready', 'limited', 'partial', 'empty'].includes(value.status)) {
        context.cache.set(key, { value, expiresAt: context.now() + context.cacheTtlMs });
      }
      return value;
    })
    .finally(() => context.inflight.delete(key));
  context.inflight.set(key, promise);
  return promise;
}

async function handleSearch(body, context = createContext()) {
  let query;
  try {
    query = search.normalizeQuery(body);
  } catch (error) {
    throw new ApiError(400, error.message, error.code || 'INVALID_QUERY');
  }
  // An explicitly empty source list is useful when the UI only wants to
  // validate a query. It must not silently turn into “all platforms”.
  if (query.sources.length === 0) {
    return { ok: true, query, fetchedAt: new Date().toISOString(), results: [], listings: [] };
  }
  const results = await Promise.all(query.sources.map((source) => fetchSource(source, query, context)));
  return {
    ok: true,
    query,
    fetchedAt: new Date().toISOString(),
    results,
    listings: results.flatMap((result) => result.listings || []),
  };
}

async function readJsonBody(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new ApiError(413, `请求体不能超过 ${MAX_BODY_BYTES} 字节`, 'BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw new ApiError(400, '请求参数不是有效 JSON', 'INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '请求体必须是 JSON 对象', 'INVALID_BODY');
  return value;
}

function sanitizeBrowserResult(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeBrowserResult(item, depth + 1));
  if (typeof value !== 'object') return value;
  const blocked = /^(?:cookie|cookies|token|authorization|profile|profiledir|profilepath|browserpath|serverpath|executablepath)$/i;
  return Object.keys(value).reduce((result, key) => {
    if (!blocked.test(key)) result[key] = sanitizeBrowserResult(value[key], depth + 1);
    return result;
  }, {});
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendApiError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  sendJson(response, status, { ok: false, error: { code: error?.code || 'SERVER_ERROR', message: error?.message || '服务器错误' }, message: error?.message || '服务器错误' });
}

function serveStatic(request, response) {
  const parsed = new URL(request.url || '/', 'http://127.0.0.1');
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch (_) { response.writeHead(400); response.end('Bad request'); return; }
  const relative = STATIC_FILES[pathname];
  if (!relative) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); return; }
  const target = path.join(ROOT, relative);
  fs.readFile(target, (error, data) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    if (request.method !== 'HEAD') response.end(data); else response.end();
  });
}

function createApiHandler(options = {}) {
  const context = options.context || createContext(options);
  const xhsAdapter = context.xhsAdapter;
  return async function api(request, response) {
    if (!isLoopback(request.socket?.remoteAddress)) {
      sendJson(response, 403, { ok: false, error: { code: 'LOOPBACK_ONLY', message: '连接层只接受本机请求' }, message: '连接层只接受本机请求' });
      return;
    }
    try {
      const parsed = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end(); return;
      }
      if (parsed.pathname === '/api/health') {
        if (request.method !== 'GET') throw new ApiError(405, '只支持 GET /api/health', 'METHOD_NOT_ALLOWED');
        sendJson(response, 200, { ok: true, service: 'rent-radar-connector', host: HOST, time: new Date().toISOString() }); return;
      }
      if (parsed.pathname === '/api/search') {
        if (request.method !== 'POST') throw new ApiError(405, '只支持 POST /api/search', 'METHOD_NOT_ALLOWED');
        const body = await readJsonBody(request);
        sendJson(response, 200, await handleSearch(body, context)); return;
      }
      if (parsed.pathname === '/api/commute') {
        if (request.method !== 'POST') throw new ApiError(405, '只支持 POST /api/commute', 'METHOD_NOT_ALLOWED');
        const body = await readJsonBody(request);
        let city;
        try { city = search.cityFromQuery(body.city).name; }
        catch (error) { throw new ApiError(400, error.message, 'UNKNOWN_CITY'); }
        const result = await context.commuteService.calculate({ ...body, city });
        sendJson(response, 200, { ok: true, ...result }); return;
      }
      if (parsed.pathname === '/api/browser/open' || parsed.pathname === '/api/browser/close') {
        if (request.method !== 'POST') throw new ApiError(405, `只支持 POST ${parsed.pathname}`, 'METHOD_NOT_ALLOWED');
        const contentType = request.headers['content-type'] || '';
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new ApiError(415, '浏览器接口只接受 application/json', 'UNSUPPORTED_MEDIA_TYPE');
        const origin = request.headers.origin;
        if (origin) {
          let originUrl;
          try { originUrl = new URL(origin); } catch (_) { throw new ApiError(403, '浏览器接口只接受本服务页面请求', 'INVALID_ORIGIN'); }
          const expectedPort = String(request.socket?.localPort || PORT);
          if (!['127.0.0.1', 'localhost', '[::1]'].includes(originUrl.hostname) || originUrl.protocol !== 'http:' || (originUrl.port || '80') !== expectedPort) {
            throw new ApiError(403, '浏览器接口只接受本服务页面请求', 'INVALID_ORIGIN');
          }
        }
        const body = await readJsonBody(request);
        const method = parsed.pathname.endsWith('/open') ? 'openBrowser' : 'closeBrowser';
        if (typeof xhsAdapter[method] !== 'function') throw new ApiError(503, '小红书浏览器适配器尚未安装', 'XHS_ADAPTER_UNAVAILABLE');
        const result = await xhsAdapter[method]({ ...body });
        if (method === 'openBrowser') {
          for (const key of context.cache.keys()) if (key.startsWith('小红书|')) context.cache.delete(key);
        }
        sendJson(response, 200, { ok: true, result: sanitizeBrowserResult(result) }); return;
      }
      if (parsed.pathname.startsWith('/api/')) throw new ApiError(404, '接口不存在', 'NOT_FOUND');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, '只支持 GET/HEAD 静态资源请求', 'METHOD_NOT_ALLOWED');
      serveStatic(request, response);
    } catch (error) {
      sendApiError(response, error);
    }
  };
}

function createServer(options = {}) {
  return http.createServer(createApiHandler(options));
}

const defaultApi = createApiHandler();

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => console.log(`Rent Radar running at http://${HOST}:${PORT}`));
}

module.exports = {
  api: defaultApi,
  createApiHandler,
  createContext,
  createServer,
  fetchText,
  handleSearch,
  normalizeListing,
  listingMatchesQuery,
  readJsonBody,
  sanitizeBrowserResult,
  constants: { HOST, PORT, MAX_BODY_BYTES, CACHE_TTL_MS, MIN_PLATFORM_INTERVAL_MS, STATIC_FILES },
};
