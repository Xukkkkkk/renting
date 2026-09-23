/*
 * Xiaohongshu search adapter.
 *
 * This adapter deliberately uses a normal Playwright browser context. It does
 * not export cookies, spoof a fingerprint, solve a captcha, or call an
 * undocumented API. `openBrowser` is the explicit, user initiated entry point
 * for a visible browser. `fetchXhs` can reuse that window; when no window is
 * open it uses a short lived headless context and reports access restrictions
 * truthfully.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const SEARCH_ORIGIN = 'https://www.xiaohongshu.com';
const MAX_LISTINGS = 90;
const MAX_DETAIL_PAGES = 3;
const NAVIGATION_TIMEOUT_MS = 35000;
const WAIT_AFTER_LOAD_MS = 1800;

let playwright;
let context = null;
let page = null;
let visibleContext = false;
let contextOwner = null;
let operation = Promise.resolve();

function text(value) {
  return value == null ? '' : String(value);
}

function clean(value) {
  return text(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPlaywright() {
  if (playwright) return playwright;
  try {
    // Keep this require dynamic: the local fallback/import view should still
    // work when Playwright has not been installed yet.
    // eslint-disable-next-line global-require, import/no-unresolved
    playwright = require('playwright');
    return playwright;
  } catch (firstError) {
    try {
      // playwright-core is useful in deployments that provide a system Edge
      // or Chrome but intentionally do not download a bundled browser.
      // eslint-disable-next-line global-require, import/no-unresolved
      playwright = require('playwright-core');
      return playwright;
    } catch (secondError) {
      const error = new Error('未安装 Playwright。请先运行 npm install playwright，或安装 playwright-core 并提供系统 Edge/Chrome。');
      error.code = 'PLAYWRIGHT_NOT_INSTALLED';
      error.cause = secondError || firstError;
      throw error;
    }
  }
}

function systemBrowserCandidates() {
  const env = process.env;
  const candidates = [];
  const add = (value) => {
    if (value && !candidates.includes(value) && fs.existsSync(value)) candidates.push(value);
  };

  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    roots.forEach((root) => {
      add(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      add(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      add(path.join(root, 'Chromium', 'Application', 'chrome.exe'));
    });
  } else if (process.platform === 'darwin') {
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].forEach(add);
  }
  return candidates;
}

function launchOptions(visible, candidate) {
  const options = {
    headless: !visible,
    // Null lets a visible Edge/Chrome window use its normal window size.
    viewport: null,
    locale: 'zh-CN',
    acceptDownloads: false,
    timeout: 15000,
  };
  if (candidate && candidate.kind === 'path') options.executablePath = candidate.value;
  if (candidate && candidate.kind === 'channel') options.channel = candidate.value;
  return options;
}

function launchCandidates() {
  const entries = systemBrowserCandidates().map((value) => ({ kind: 'path', value }));
  // Channels are tried after explicit system paths. They resolve through the
  // browser installation known by Playwright and are harmless if absent.
  entries.push({ kind: 'channel', value: 'msedge' });
  entries.push({ kind: 'channel', value: 'chrome' });
  entries.push({ kind: 'bundled' });
  return entries;
}

async function launchPersistent(visible) {
  let pw;
  try {
    pw = loadPlaywright();
  } catch (error) {
    return { error };
  }
  if (!pw || !pw.chromium || typeof pw.chromium.launchPersistentContext !== 'function') {
    const error = new Error('当前 Playwright 安装没有可用的 Chromium 启动器。');
    error.code = 'PLAYWRIGHT_CHROMIUM_UNAVAILABLE';
    return { error };
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  let lastError;
  for (const candidate of launchCandidates()) {
    try {
      const options = launchOptions(visible, candidate);
      if (candidate.kind === 'bundled') delete options.executablePath;
      const nextContext = await pw.chromium.launchPersistentContext(PROFILE_DIR, options);
      return { context: nextContext, candidate };
    } catch (error) {
      lastError = error;
      // A missing channel/executable is expected while trying the next
      // candidate. Keep the final message concise for the UI.
    }
  }
  const error = new Error('无法启动 Edge/Chrome。请确认浏览器已安装，并关闭占用租房工具浏览器配置目录的旧进程。');
  error.code = 'BROWSER_LAUNCH_FAILED';
  error.cause = lastError;
  return { error };
}

async function ensureContext(visible) {
  if (context) {
    // A visible context may only be reused as visible. A headless request can
    // always reuse it because it is already the user-authorized session.
    visibleContext = visibleContext || visible;
    return { context, reused: true };
  }
  const launched = await launchPersistent(visible);
  if (launched.error) return launched;
  context = launched.context;
  contextOwner = visible ? 'user' : 'fetch';
  visibleContext = visible;
  context.on('close', () => {
    context = null;
    page = null;
    visibleContext = false;
    contextOwner = null;
  });
  return { context, reused: false, candidate: launched.candidate };
}

function searchKeyword(query) {
  query = query || {};
  const city = text(query.city || query.cityName).trim();
  const region = text(query.region || query.district || query.areaName).trim();
  const layout = text(query.layout || query.houseType || query.roomType).trim();
  const terms = [city, region, '租房', layout].filter(Boolean);
  return terms.length ? terms.join(' ') : '租房';
}

function buildSearchUrl(query) {
  return `${SEARCH_ORIGIN}/search_result?keyword=${encodeURIComponent(searchKeyword(query))}`;
}

function hostAllowed(value) {
  try {
    const parsed = new URL(value);
    return /(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$/i.test(parsed.hostname);
  } catch (error) {
    return false;
  }
}

function stableId(url, title, raw, noteId) {
  let seed = noteId || '';
  if (!seed && url) {
    try {
      const parsed = new URL(url);
      seed = parsed.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([A-Za-z0-9_-]+)/)?.[1]
        || `${parsed.hostname}${parsed.pathname}`;
    } catch (error) { seed = url; }
  }
  seed = seed || `${title || ''}|${raw || ''}`;
  return `xhs-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 18)}`;
}

function parseNumber(pattern, raw) {
  const match = pattern.exec(text(raw));
  return match ? Number(String(match[1]).replace(/,/g, '')) : null;
}

function parseFields(raw, title, query) {
  const value = `${title || ''} ${raw || ''}`;
  let rent = parseNumber(/(?:月租|租金|价格|房租)?\s*[:：]?\s*([\d][\d,.]*)\s*(?:元|块|rmb)?\s*(?:\/|每)?\s*月/i, value);
  const rentWan = value.match(/([\d.]+)\s*万(?:元)?\s*\/??\s*月?/i);
  if (rent == null && rentWan) rent = Number(rentWan[1]) * 10000;
  const areaMatch = value.match(/([\d.]+)(?:\s*[-~至]\s*([\d.]+))?\s*(?:㎡|m²|平米|平方米|平)/i);
  const areaMin = areaMatch ? Number(areaMatch[1]) : null;
  const areaMax = areaMatch && areaMatch[2] ? Number(areaMatch[2]) : areaMin;
  const layoutMatch = value.match(/((?:[一二三四五六七八九十两\d]+)\s*室(?:\s*[一二三四五六七八九十两\d]+\s*厅)?|开间|一居|合租|主卧|次卧)/i);
  const city = text(query && (query.city || query.cityName)).trim();
  const addressMatch = value.match(/(?:地址|位置|坐标|小区)\s*[:：]\s*([^，,。；;|｜]{2,45})/);
  return {
    city,
    address: addressMatch && addressMatch[1] ? clean(addressMatch[1]) : '',
    rent,
    area: areaMin,
    areaMin,
    areaMax,
    layout: layoutMatch ? layoutMatch[1].replace(/\s+/g, '') : '',
  };
}

function normalizeCandidate(candidate, query, index) {
  const raw = clean(candidate.raw || candidate.text || candidate.description || '');
  const title = clean(candidate.title || candidate.name || '') || clean(raw.split(/[。！？.!?]/)[0]).slice(0, 120) || '小红书租房笔记';
  const url = candidate.url && /^https?:/i.test(candidate.url) ? candidate.url : '';
  const fields = parseFields(raw, title, query);
  return {
    id: stableId(url, title, raw, candidate.noteId),
    source: '小红书',
    title,
    city: fields.city,
    address: fields.address,
    location: fields.address,
    rent: fields.rent,
    rentMin: fields.rent,
    rentMax: fields.rent,
    area: fields.area,
    areaMin: fields.areaMin,
    areaMax: fields.areaMax,
    layout: fields.layout,
    url,
    link: url,
    raw,
    image: candidate.image || '',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Read public/rendered note cards and a few JSON state candidates. This code is
 * executed in the page only and returns plain serializable values.
 */
async function readPageSnapshot(targetPage) {
  return targetPage.evaluate(() => {
    const cleanText = (value) => String(value || '').replace(/[\t\r\n ]+/g, ' ').trim();
    const cards = [];
    const seen = new Set();
    const addCard = (node) => {
      if (!node) return;
      // Initial-state entries are plain objects rather than DOM nodes. Keep
      // them as a fallback when the feed is rendered from JSON without a
      // corresponding card element yet.
      if (!node.nodeType && typeof node === 'object' && (node.raw || node.title || node.name)) {
        const raw = cleanText(node.raw || node.description || node.content || node.text || node.title || '');
        const title = cleanText(node.title || node.name || '') || cleanText(raw.split(/[。！？.!?]/)[0]).slice(0, 120);
        const url = node.url || node.link || node.share_url || '';
        if (raw.length >= 4) {
          const key = url || `${title}|${raw.slice(0, 180)}`;
          if (!seen.has(key)) {
            seen.add(key);
            cards.push({ title, raw, url, noteId: node.noteId || '', image: node.image || node.cover || '' });
          }
        }
        return;
      }
      const linkNode = node.matches && node.matches('a[href]')
        ? node
        : node.querySelector && node.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"], a[href]');
      const url = linkNode && linkNode.href ? linkNode.href : '';
      const raw = cleanText(node.innerText || node.textContent || '');
      if (raw.length < 4) return;
      const titleNode = node.querySelector && node.querySelector('.title, .note-title, [class*="title"], h3, h4');
      const title = cleanText(titleNode && (titleNode.innerText || titleNode.textContent)) || cleanText(raw.split(/[。！？.!?]/)[0]).slice(0, 120);
      const imageNode = node.querySelector && node.querySelector('img');
      const image = imageNode && (imageNode.currentSrc || imageNode.src || imageNode.getAttribute('data-src')) || '';
      const key = url || `${title}|${raw.slice(0, 180)}`;
      if (seen.has(key)) return;
      seen.add(key);
      cards.push({ title, raw, url, image });
    };
    const selectors = [
      'section.note-item',
      'div.note-item',
      'article.note-item',
      '[class*="note-item"]',
      'a[href*="/explore/"]',
      'a[href*="/discovery/item/"]',
    ];
    selectors.forEach((selector) => document.querySelectorAll(selector).forEach((node) => {
      // A bare anchor is promoted to its nearest card-like parent where one
      // exists, preserving its title/text and avoiding nav links.
      const parent = node.matches && node.matches('a[href]')
        ? (node.closest('section,article,li,[class*="note-item"],[class*="feed"]') || node)
        : node;
      addCard(parent);
    }));

    const stateCandidates = [];
    const visited = new WeakSet();
    let visitCount = 0;
    const visit = (value, depth) => {
      if (!value || depth > 7 || visitCount > 25000) return;
      if (typeof value !== 'object') return;
      if (visited.has(value)) return;
      visited.add(value);
      visitCount += 1;
      if (Array.isArray(value)) {
        value.slice(0, 200).forEach((item) => visit(item, depth + 1));
        return;
      }
      const title = value.displayTitle || value.display_title || value.title || value.note_title || '';
      const raw = value.desc || value.description || value.content || value.text || value.title || '';
      const id = value.note_id || value.noteId || value.id || '';
      let href = value.url || value.share_url || value.shareUrl || value.link || '';
      const noteId = /^[a-f0-9]{24}$/i.test(String(id)) ? String(id) : '';
      if (!href && noteId) {
        const token = value.xsecToken || value.xsec_token || '';
        href = `https://www.xiaohongshu.com/explore/${noteId}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search` : ''}`;
      }
      const isNote = noteId || /\/(?:explore|discovery\/item)\//.test(String(href));
      if (title && isNote) {
        const cover = value.image || value.cover || '';
        const image = typeof cover === 'string' ? cover : (cover.urlDefault || cover.url_default || cover.url || '');
        stateCandidates.push({ title: cleanText(title), raw: cleanText(`${title} ${raw}`), noteId, url: href, image });
      }
      Object.keys(value).slice(0, 80).forEach((key) => visit(value[key], depth + 1));
    };
    ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', '__APOLLO_STATE__'].forEach((key) => {
      try { visit(window[key], 0); } catch (error) { /* inaccessible state is normal */ }
    });
    document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__').forEach((node) => {
      try { visit(JSON.parse(node.textContent || ''), 0); } catch (error) { /* unrelated JSON */ }
    });
    stateCandidates.slice(0, 80).forEach(addCard);

    const body = cleanText(document.body && (document.body.innerText || document.body.textContent));
    const title = cleanText(document.title);
    const location = window.location.href;
      return { cards: cards.slice(0, 90), body: body.slice(0, 12000), title, location };
  });
}

function accessStatus(snapshot, count) {
  const combined = `${snapshot && snapshot.location || ''} ${snapshot && snapshot.title || ''} ${snapshot && snapshot.body || ''}`;
  const blocked = /(验证码|安全验证|滑块|访问受限|操作频繁|请求过于频繁|风控|captcha|forbidden|verify|access denied)/i.test(combined);
  const login = /(请先登录|登录后查看|手机号登录|扫码登录|立即登录|登录\/注册)/i.test(combined);
  if (blocked && !count) return { status: 'blocked', message: '小红书返回了安全验证或访问限制，请在打开的官方页面中按站内提示处理。适配器不会绕过验证。' };
  if (login && !count) return { status: 'needs_login', message: '小红书搜索需要登录后查看，请点击“打开小红书”在可见浏览器中完成登录，再重试。' };
  if (count) return { status: 'ready', message: `已读取 ${count} 条小红书公开笔记。` };
  return { status: 'empty', message: '页面已打开，但没有读取到可公开访问的笔记卡片。可以在浏览器中完成登录后重试。' };
}

async function navigate(targetPage, searchUrl) {
  await targetPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await sleep(WAIT_AFTER_LOAD_MS);
  // Let the client-side feed settle when the first response was only a shell.
  try { await targetPage.waitForLoadState('networkidle', { timeout: 7000 }); } catch (error) { /* feeds may keep polling */ }
  await sleep(350);
}

async function enrichDetails(activeContext, listings, query) {
  const wantsDetails = Boolean(query && (query.fetchDetails || query.details || query.includeDetails));
  if (!wantsDetails || !listings.length) return listings;
  const maxDetails = Math.max(0, Math.min(Number(query.maxDetails || 2), MAX_DETAIL_PAGES));
  if (!maxDetails) return listings;
  let detailPage;
  try {
    detailPage = await activeContext.newPage();
    for (const item of listings.slice(0, maxDetails)) {
      if (!hostAllowed(item.url)) continue;
      try {
        await detailPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        await sleep(850);
        const snapshot = await readPageSnapshot(detailPage);
        if (snapshot && snapshot.body) {
          const fields = parseFields(snapshot.body, item.title, query);
          Object.keys(fields).forEach((key) => {
            if (fields[key] !== null && fields[key] !== '') item[key] = fields[key];
          });
          item.raw = snapshot.body;
        }
      } catch (error) {
        // A single restricted detail page should not discard the search feed.
      }
    }
  } finally {
    if (detailPage) await detailPage.close().catch(() => {});
  }
  return listings;
}

async function fetchInContext(activeContext, query, searchUrl) {
  let activePage = page;
  if (!activePage || activePage.isClosed()) activePage = await activeContext.newPage();
  page = activePage;
  await navigate(activePage, searchUrl);
  const batches = Math.max(1, Math.min(3, Math.floor(Number(query.pages) || 1)));
  const limit = Math.max(1, Math.min(MAX_LISTINGS, Math.floor(Number(query.limit) || batches * 30)));
  const collected = new Map();
  let snapshot;
  let batchesRead = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    if (batch > 0) {
      // The official feed uses infinite scrolling. Request at most one extra
      // visible batch per requested page and never circumvent a login gate.
      await activePage.evaluate(() => {
        const container = document.querySelector('.main-container, .search-container, .feeds-container');
        if (container && container.scrollHeight > container.clientHeight) container.scrollTop = container.scrollHeight;
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await sleep(1300);
    }
    snapshot = await readPageSnapshot(activePage);
    batchesRead += 1;
    for (const candidate of snapshot.cards || []) {
      const listing = normalizeCandidate(candidate, query);
      if (!collected.has(listing.id)) collected.set(listing.id, listing);
      if (collected.size >= limit) break;
    }
    const currentAccess = accessStatus(snapshot, collected.size);
    if (currentAccess.status === 'blocked' || currentAccess.status === 'needs_login' || collected.size >= limit) break;
  }
  const listings = Array.from(collected.values()).slice(0, limit);
  await enrichDetails(activeContext, listings, query);
  const access = accessStatus(snapshot, listings.length);
  return {
    source: '小红书',
    status: access.status,
    message: access.message,
    count: listings.length,
    listings,
    searchUrl,
    batchesRead,
    fetchedAt: new Date().toISOString(),
  };
}

function queue(task) {
  const next = operation.then(task, task);
  operation = next.catch(() => {});
  return next;
}

/**
 * Explicit user action: launch/reuse a visible Edge/Chrome window, navigate to
 * the official XHS search page and leave that window open for manual login.
 */
function openBrowser(query) {
  return queue(async () => {
    const searchUrl = buildSearchUrl(query || {});
    const ensured = await ensureContext(true);
    if (ensured.error) {
      return { source: '小红书', status: ensured.error.code === 'PLAYWRIGHT_NOT_INSTALLED' ? 'unavailable' : 'blocked', message: ensured.error.message, count: 0, listings: [], searchUrl };
    }
    try {
      if (!page || page.isClosed()) page = await ensured.context.newPage();
      await navigate(page, searchUrl);
      const snapshot = await readPageSnapshot(page);
      const access = accessStatus(snapshot, (snapshot.cards || []).length);
      return {
        source: '小红书',
        status: access.status,
        message: `${access.message} 浏览器窗口保持打开，可在其中登录后再次点击搜索。`,
        count: snapshot.cards ? snapshot.cards.length : 0,
        listings: [],
        searchUrl,
        visible: true,
      };
    } catch (error) {
      return { source: '小红书', status: 'blocked', message: `小红书页面打开失败：${error.message}`, count: 0, listings: [], searchUrl, visible: true };
    }
  });
}

/**
 * Fetch rendered cards. It never opens a visible browser on its own. If the
 * user already called openBrowser, that authorized session is reused.
 */
function fetchXhs(query) {
  return queue(async () => {
    const normalizedQuery = query || {};
    const searchUrl = buildSearchUrl(normalizedQuery);
    let temporary = false;
    if (!context) {
      const ensured = await ensureContext(false);
      if (ensured.error) {
        return { source: '小红书', status: ensured.error.code === 'PLAYWRIGHT_NOT_INSTALLED' ? 'unavailable' : 'blocked', message: ensured.error.message, count: 0, listings: [], searchUrl };
      }
      temporary = true;
    }
    try {
      return await fetchInContext(context, normalizedQuery, searchUrl);
    } catch (error) {
      return { source: '小红书', status: 'blocked', message: `小红书搜索失败：${error.message}`, count: 0, listings: [], searchUrl, fetchedAt: new Date().toISOString() };
    } finally {
      if (temporary && context && contextOwner === 'fetch') await closeBrowserInternal();
    }
  });
}

async function closeBrowserInternal() {
  const oldContext = context;
  context = null;
  page = null;
  visibleContext = false;
  contextOwner = null;
  if (oldContext) await oldContext.close().catch(() => {});
}

function closeBrowser() {
  return queue(async () => {
    await closeBrowserInternal();
    return { ok: true, source: '小红书', status: 'closed', message: '小红书浏览器窗口已关闭。' };
  });
}

module.exports = {
  fetchXhs,
  openBrowser,
  closeBrowser,
  buildSearchUrl,
  searchKeyword,
  PROFILE_DIR,
};
