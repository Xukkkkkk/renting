'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const cheerio = require('cheerio');

const CITY_SLUGS = Object.freeze({
  北京: 'bj', 上海: 'sh', 广州: 'gz', 深圳: 'sz', 杭州: 'hz', 成都: 'cd',
  南京: 'nj', 武汉: 'wh', 西安: 'xa', 重庆: 'cq', 苏州: 'su', 天津: 'tj',
  郑州: 'zz', 长沙: 'cs', 青岛: 'qd', 厦门: 'xm', 合肥: 'hf', 济南: 'jn',
  佛山: 'fs', 东莞: 'dg', 宁波: 'nb', 无锡: 'wx', 昆明: 'km', 福州: 'fz',
  香港: 'hk',
});

const WELLCEE_CITY_SLUGS = Object.freeze({
  北京: 'beijing', 上海: 'shanghai', 广州: 'guangzhou', 深圳: 'shenzhen',
  杭州: 'hangzhou', 成都: 'chengdu', 南京: 'nanjing', 武汉: 'wuhan',
  西安: 'xian', 重庆: 'chongqing', 苏州: 'suzhou', 天津: 'tianjin',
  郑州: 'zhengzhou', 长沙: 'changsha', 青岛: 'qingdao', 厦门: 'xiamen',
  合肥: 'hefei', 济南: 'jinan', 佛山: 'foshan', 东莞: 'dongguan',
  宁波: 'ningbo', 无锡: 'wuxi', 昆明: 'kunming', 福州: 'fuzhou',
  香港: 'hongkong',
});

const SUPPORTED_SOURCES = Object.freeze([
  '链家', '贝壳', '安居客', '58同城', '自如', 'Wellcee', '小红书', '豆瓣租房', '闲鱼', '房天下'
]);

const SOURCE_ALIASES = Object.freeze({
  wellcee: 'Wellcee',
  Wellcee: 'Wellcee',
  '58': '58同城',
  '58同城': '58同城',
  豆瓣: '豆瓣租房',
  豆瓣租房: '豆瓣租房',
  闲鱼: '闲鱼',
  闲鱼租房: '闲鱼',
  房天下: '房天下',
  搜房: '房天下',
  自如: '自如',
  ziroom: '自如',
  安居客: '安居客',
  anjuke: '安居客',
  链家: '链家',
  贝壳: '贝壳',
  小红书: '小红书',
});

const SOURCE_HOSTS = Object.freeze({
  链家: (slug) => `https://${slug}.lianjia.com/zufang/`,
  贝壳: (slug) => `https://${slug}.zu.ke.com/zufang/`,
});

const LAYOUT_SEGMENTS = Object.freeze({
  开间: 'l0', 一居: 'l1', 一室: 'l1', 一室一厅: 'l1',
  两居: 'l2', 两室: 'l2', 两室一厅: 'l2',
  三居: 'l3', 三室: 'l3', 三室一厅: 'l3',
  四居: 'l4', 四室: 'l4', 五居: 'l5',
});

const MAX_PAGES = 3;
const MAX_ITEMS_PER_SOURCE = 90;

function htmlDecode(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function clean(value = '') {
  return htmlDecode(String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
}

function attr(block, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = re.exec(block);
  return match ? htmlDecode(match[1]).trim() : '';
}

function firstMatch(text, regex, fallback = '') {
  const match = regex.exec(text);
  return match ? clean(match[1]) : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

/**
 * Parse a displayed rent without silently changing a range into one number.
 * `rent` is only set for a single value; ranges are represented by rentMin and rentMax.
 */
function parsePrice(value) {
  const text = clean(value).replace(/,/g, '');
  if (!text || /面议|待定|暂无|价格未知/i.test(text)) {
    return { rent: null, rentMin: null, rentMax: null };
  }
  const values = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((item) => Number(item[0]))
    .filter((item) => Number.isFinite(item));
  if (!values.length) return { rent: null, rentMin: null, rentMax: null };
  if (values.length >= 2 && /[-~至—–]|起|上下|到/.test(text)) {
    const rentMin = values[0];
    const rentMax = values[1];
    return rentMin <= rentMax
      ? { rent: null, rentMin, rentMax }
      : { rent: null, rentMin: rentMax, rentMax: rentMin };
  }
  const rent = values[0];
  return { rent, rentMin: rent, rentMax: rent };
}

function extractArea(value) {
  const match = clean(value).match(/(\d+(?:\.\d+)?)\s*(?:㎡|m²|平方米|平米|平)/i);
  return match ? numberOrNull(match[1]) : null;
}

function extractLayout(value) {
  const text = clean(value);
  const match = text.match(/(\d+\s*室\s*\d+\s*厅(?:\s*\d+\s*卫)?|[一二三四五六七八九十]+室[一二三四五六七八九十]+厅|开间|一居|两居|三居|四居|五居|合租)/i);
  return match ? match[1].replace(/\s+/g, '') : null;
}

function cityFromQuery(value) {
  const raw = typeof value === 'string' ? value : value?.city;
  const input = String(raw || '').trim();
  const city = Object.keys(CITY_SLUGS).find((name) => input === name || input.startsWith(`${name} `) || input.startsWith(`${name}·`) || input.startsWith(`${name} ·`) || input.includes(name));
  if (!city) {
    const error = new Error(`不支持的城市：${input || '未填写'}，请填写已支持的城市`);
    error.code = 'UNKNOWN_CITY';
    throw error;
  }
  return { name: city, slug: CITY_SLUGS[city] };
}

function parseRange(value, minValue, maxValue, label) {
  let min = minValue;
  let max = maxValue;
  if (typeof value === 'string' && value.includes(',')) {
    [min, max] = value.split(',', 2);
  }
  const parse = (item) => item === '' || item === undefined || item === null ? null : Number(item);
  min = parse(min); max = parse(max);
  if (min !== null && (!Number.isFinite(min) || min < 0)) throw new Error(`${label}最低值无效`);
  if (max !== null && (!Number.isFinite(max) || max < 0)) throw new Error(`${label}最高值无效`);
  if (min !== null && max !== null && min > max) throw new Error(`${label}最低值不能高于最高值`);
  return { min, max };
}

function normalizeQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('请求体必须是 JSON 对象'); error.code = 'INVALID_BODY'; throw error;
  }
  const cityInput = typeof input.city === 'string' ? input.city.trim() : '';
  const city = cityFromQuery(cityInput);
  const rent = parseRange(null, input.rentMin, input.rentMax, '租金');
  const area = parseRange(input.area, input.areaMin, input.areaMax, '面积');
  const layout = typeof input.layout === 'string' ? input.layout.trim().slice(0, 80) : '';
  const commute = typeof input.commute === 'string' ? input.commute.trim().slice(0, 120) : '';
  const keyword = typeof input.keyword === 'string' ? input.keyword.trim().slice(0, 120) : '';
  const subway = typeof input.subway === 'string' ? input.subway.trim().slice(0, 80) : '';
  const derivedDistrict = cityInput.replace(city.name, '').replace(/^[市\s·,，/|-]+|[\s·,，/|-]+$/g, '').trim();
  const district = typeof input.district === 'string' ? input.district.trim().slice(0, 80) : derivedDistrict.slice(0, 80);
  const pagesRaw = input.pages === undefined ? 1 : Number(input.pages);
  if (!Number.isInteger(pagesRaw) || pagesRaw < 1 || pagesRaw > MAX_PAGES) throw new Error(`pages 必须是 1-${MAX_PAGES} 的整数`);
  const limitRaw = input.limit === undefined ? Math.min(MAX_ITEMS_PER_SOURCE, pagesRaw * 30) : Number(input.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_ITEMS_PER_SOURCE) throw new Error(`limit 必须是 1-${MAX_ITEMS_PER_SOURCE} 的整数`);
  let sources;
  if (input.sources === undefined) sources = ['链家', '贝壳', '小红书'];
  else if (!Array.isArray(input.sources)) throw new Error('sources 必须是数组');
  else sources = [...new Set(input.sources.map((source) => SOURCE_ALIASES[String(source).trim()] || String(source).trim()))];
  const supported = new Set(SUPPORTED_SOURCES);
  const unsupported = sources.filter((source) => !supported.has(source));
  if (unsupported.length) throw new Error(`不支持的信息来源：${unsupported.join('、')}`);
  return {
    city: city.name,
    citySlug: city.slug,
    district,
    subway,
    rentMin: rent.min,
    rentMax: rent.max,
    areaMin: area.min,
    areaMax: area.max,
    layout,
    commute,
    keyword,
    pages: pagesRaw,
    limit: limitRaw,
    sources,
  };
}

function subwaySearchTerms(line) {
  if (!line) return [];
  const cleanLine = String(line).trim();
  const terms = new Set([cleanLine]);
  const numMatch = cleanLine.match(/(\d+)号线/);
  if (numMatch) {
    const num = numMatch[1];
    const cnDigits = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六', '7': '七', '8': '八', '9': '九', '10': '十', '11': '十一', '12': '十二', '13': '十三', '14': '十四', '15': '十五', '16': '十六', '17': '十七', '18': '十八', '19': '十九', '20': '二十', '21': '二十一', '22': '二十二' };
    if (cnDigits[num]) terms.add(`${cnDigits[num]}号线`);
  }
  const cnMatch = cleanLine.match(/([一二三四五六七八九十]+)号线/);
  if (cnMatch) {
    const cn = cnMatch[1];
    const numDigits = { '一': '1', '二': '2', '三': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '十': '10', '十一': '11', '十二': '12', '十三': '13', '十四': '14', '十五': '15', '十六': '16', '十七': '17', '十八': '18', '十九': '19', '二十': '20' };
    if (numDigits[cn]) terms.add(`${numDigits[cn]}号线`);
  }
  if (cleanLine.includes('/')) {
    cleanLine.split('/').forEach((part) => {
      if (part.trim()) terms.add(part.trim());
    });
  }
  return Array.from(terms);
}

function numericPath(value) {
  return value === null || value === undefined ? '' : String(value).replace(/\.0+$/, '');
}

function queryKeyword(query) {
  return [query.district, query.subway, query.keyword].filter(Boolean).join(' ').trim();
}

function makePlatformSearchUrl(source, query, page = 1) {
  const keyword = queryKeyword(query);
  const generalKeyword = keyword || `${query.city} 租房`;

  if (source === '链家' || source === '贝壳') {
    const hostFactory = SOURCE_HOSTS[source];
    const base = new URL(hostFactory(query.citySlug));
    const segments = [];
    if (query.rentMin !== null) segments.push(`brp${numericPath(query.rentMin)}`);
    if (query.rentMax !== null) segments.push(`erp${numericPath(query.rentMax)}`);
    if (query.areaMin !== null) segments.push(`bp${numericPath(query.areaMin)}`);
    if (query.areaMax !== null) segments.push(`ep${numericPath(query.areaMax)}`);
    if (query.layout) {
      if (query.layout === '合租') segments.push('rt200600000002');
      const layoutKey = Object.keys(LAYOUT_SEGMENTS).find((key) => query.layout.includes(key));
      if (layoutKey) segments.push(LAYOUT_SEGMENTS[layoutKey]);
    }
    if (page > 1) segments.unshift(`pg${page}`);
    base.pathname = `/zufang/${segments.length ? `${segments.join('')}/` : ''}`;
    if (keyword) base.searchParams.set('keyword', keyword);
    return base.href;
  }

  if (source === '安居客') {
    const slug = query.citySlug || 'bj';
    let layoutSeg = '';
    if (/合租/.test(query.layout)) layoutSeg = 'hz';
    else if (/一[室居]|开间|1室/.test(query.layout)) layoutSeg = 'fx1';
    else if (/二[室居]|两[室居]|2室/.test(query.layout)) layoutSeg = 'fx2';
    else if (/三[室居]|3室/.test(query.layout)) layoutSeg = 'fx3';
    else if (/四[室居]|4室/.test(query.layout)) layoutSeg = 'fx4';
    const pathParts = ['fangyuan'];
    if (layoutSeg) pathParts.push(layoutSeg);
    if (page > 1) pathParts.push(`p${page}`);
    const base = new URL(`https://${slug}.zu.anjuke.com/${pathParts.join('/')}/`);
    if (query.rentMin !== null) base.searchParams.set('minprice', String(query.rentMin));
    if (query.rentMax !== null) base.searchParams.set('maxprice', String(query.rentMax));
    if (keyword) base.searchParams.set('kw', keyword);
    return base.href;
  }

  if (source === 'Wellcee') {
    const citySlug = WELLCEE_CITY_SLUGS[query.city] || 'beijing';
    const base = new URL(`https://www.wellcee.com/rent-house/${citySlug}`);
    if (query.rentMin !== null) base.searchParams.set('min_price', String(query.rentMin));
    if (query.rentMax !== null) base.searchParams.set('max_price', String(query.rentMax));
    if (query.layout) {
      if (/合租|单间/.test(query.layout)) base.searchParams.set('rent_type', '2');
      else base.searchParams.set('rent_type', '1');
    }
    if (keyword) base.searchParams.set('keyword', keyword);
    if (page > 1) base.searchParams.set('page', String(page));
    return base.href;
  }

  if (source === '自如') {
    const slug = query.citySlug || 'bj';
    const pathParts = ['z'];
    if (query.rentMin !== null || query.rentMax !== null) {
      pathParts.push(`r${query.rentMin || 0}-${query.rentMax || ''}`);
    }
    if (page > 1) pathParts.push(`p${page}`);
    const base = new URL(`https://${slug}.ziroom.com/${pathParts.join('/')}/`);
    if (keyword) base.searchParams.set('q', keyword);
    return base.href;
  }

  if (source === '58同城') {
    const slug = query.citySlug || 'bj';
    const path = page > 1 ? `/chuzu/pn${page}/` : '/chuzu/';
    const base = new URL(`https://${slug}.58.com${path}`);
    if (query.rentMin !== null) base.searchParams.set('minprice', String(query.rentMin));
    if (query.rentMax !== null) base.searchParams.set('maxprice', String(query.rentMax));
    if (keyword) base.searchParams.set('key', keyword);
    return base.href;
  }

  if (source === '豆瓣租房') {
    const base = new URL('https://www.douban.com/group/search');
    base.searchParams.set('cat', '1019');
    base.searchParams.set('q', generalKeyword);
    if (page > 1) base.searchParams.set('start', String((page - 1) * 20));
    return base.href;
  }

  if (source === '闲鱼') {
    const base = new URL('https://www.goofish.com/search');
    base.searchParams.set('q', generalKeyword);
    if (page > 1) base.searchParams.set('page', String(page));
    return base.href;
  }

  if (source === '房天下') {
    const slug = query.citySlug || 'bj';
    const host = slug === 'bj' ? 'https://zu.fang.com/' : `https://zu.${slug}.fang.com/`;
    const path = page > 1 ? `px${page}/` : '';
    const base = new URL(`${host}${path}`);
    if (keyword) base.searchParams.set('keyword', keyword);
    return base.href;
  }

  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(generalKeyword)}`;
}

function makeSearchUrls(query) {
  return SUPPORTED_SOURCES.reduce((acc, source) => {
    acc[source] = makePlatformSearchUrl(source, query, 1);
    return acc;
  }, {});
}

function containsCaptcha(html = '') {
  const text = String(html);
  if (/class=["'][^"']*\b(?:content__list--item|zu-itemmod|house-item|room-item|Z_list-box)\b/i.test(text)) {
    return false;
  }
  const $ = cheerio.load(text);
  $('script,style,noscript').remove();
  const cleaned = `${$('title').text()} ${$('body').text()}`.replace(/\s+/g, ' ');
  return /验证码|滑块验证|安全验证|访问验证|请完成验证|access denied|robot check|captcha|geetest|security\.anjuke\.com|防刷|请输入验证码|系统检测到异常请求|sec\.douban\.com/i.test(cleaned);
}

function extractHouseCode(block, url = '') {
  const explicit = attr(block, 'data-housecode') || attr(block, 'data-house-code') || attr(block, 'data-id') || attr(block, 'data-house-id') || attr(block, 'data-houseid');
  if (explicit && /[A-Za-z0-9_-]{4,}/.test(explicit)) return explicit.match(/[A-Za-z0-9_-]{4,}/)[0];
  const candidates = [url, attr(block, 'href'), attr(block, 'data-url')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate, 'https://example.invalid');
      const parts = parsed.pathname.split('/').filter(Boolean);
      const last = parts.at(-1)?.replace(/\.html?$/i, '');
      if (last && /[A-Za-z0-9_-]{6,}/.test(last) && !/^pg\d+$/i.test(last)) return last;
    } catch (_) { /* ignore malformed card links */ }
  }
  return null;
}

function stableId(source, city, houseCode, url) {
  const code = houseCode || `url-${crypto.createHash('sha256').update(String(url || '')).digest('hex').slice(0, 20)}`;
  return `${source}:${city}:${code}`;
}

function cardChunks(html) {
  const $ = cheerio.load(String(html));
  return $('.content__list--item').toArray().map((element) => $.html(element));
}

function parseListingBlock(block, source, city, origin) {
  const $ = cheerio.load(String(block));
  const card = $('.content__list--item').first();
  const titleElement = card.find('.content__list--item--title a, a.twoline').first();
  const primaryLink = titleElement.length ? titleElement : card.find('a[href*="/zufang/"]').first();
  const href = primaryLink.attr('href') || card.find('a[href]').first().attr('href') || '';
  const url = href ? new URL(href, origin).href : origin;
  const title = primaryLink.text().trim();
  const descriptor = card.find('.content__list--item--des').first().text();
  const priceText = card.find('.content__list--item-price em').first().text().trim()
    || card.find('.content__list--item-price').first().text().trim();
  const wholeText = clean(block);
  const titleText = clean(title) || wholeText.slice(0, 80);
  const detail = clean(descriptor) || wholeText;
  const price = parsePrice(priceText);
  const area = extractArea(detail) ?? extractArea(wholeText);
  const layout = extractLayout(detail) || extractLayout(titleText) || extractLayout(wholeText);
  const detailParts = detail.split('/').map((part) => part.trim()).filter(Boolean);
  const address = detailParts[0] || firstMatch(block, /(?:地址|位置|小区|区域)[：:\s]*([^|｜<\n;,，。]+)/i) || titleText;
  const houseCode = card.attr('data-housecode') || card.attr('data-house-code') || extractHouseCode(block, url);
  if (!houseCode && !href && !titleText) return null;
  return {
    source,
    city,
    id: stableId(source, city, houseCode, url),
    title: titleText || `${address} ${layout || ''}`.trim(),
    address: clean(address),
    location: clean(address),
    rent: price.rent,
    rentMin: price.rentMin,
    rentMax: price.rentMax,
    area,
    layout,
    url,
    image: card.find('img').first().attr('data-src') || card.find('img').first().attr('src') || null,
    raw: wholeText,
    rentType: /合租/.test(titleText) ? '合租' : /整租/.test(titleText) ? '整租' : null,
    floor: detailParts.find((part) => /楼层|层/.test(part)) || null,
    contact: '打开平台查看',
    fetchedAt: new Date().toISOString(),
  };
}

function parseAnjukeHtml(html, source, city, origin, limit) {
  const $ = cheerio.load(String(html));
  const items = $('.zu-itemmod, div[class*="zu-item"], div.list-item, div.house-cell').toArray();
  const results = [];
  for (const el of items) {
    if (results.length >= limit) break;
    const card = $(el);
    const linkEl = card.find('h3 a, a.strong, a.title, a[href*="/fangyuan/"]').first();
    const href = linkEl.attr('href') || card.find('a[href]').first().attr('href') || '';
    const url = href ? new URL(href, origin).href : origin;
    const title = clean(linkEl.text()) || clean(card.find('h3, .title').first().text());
    const priceText = card.find('strong.num, b.strong, span.price, .price').first().text().trim();
    const price = parsePrice(priceText);
    const detailText = clean(card.find('p.details-item, .details-item, .comm-address').text());
    const area = extractArea(detailText) ?? extractArea(card.text());
    const layout = extractLayout(detailText) || extractLayout(title);
    const addressText = clean(card.find('address, .comm-address, span.comm-address').first().text())
      || firstMatch(card.text(), /(?:小区|地址|位置)[：:\s]*([^|｜<\n;,，。]+)/i)
      || detailText.split(/[\/|]/)[0]?.trim()
      || title;
    const houseCode = card.attr('data-houseid') || card.attr('data-id') || extractHouseCode(card.html(), url);
    const img = card.find('img.thumbnail, img[data-src], img[src]').first();
    const image = img.attr('data-src') || img.attr('src') || null;
    const wholeText = clean(card.text());
    if (!houseCode && !href && !title) continue;
    results.push({
      source,
      city,
      id: stableId(source, city, houseCode, url),
      title: title || `${addressText} ${layout || ''}`.trim(),
      address: addressText,
      location: addressText,
      rent: price.rent,
      rentMin: price.rentMin,
      rentMax: price.rentMax,
      area,
      layout,
      url,
      image,
      raw: wholeText,
      rentType: /合租/.test(title) ? '合租' : /整租/.test(title) ? '整租' : null,
      floor: firstMatch(detailText, /(\d+[\/-]\d+层|[高中低]楼层)/i) || null,
      contact: '安居客房源 · 打开平台查看',
      fetchedAt: new Date().toISOString(),
    });
  }
  return results.length ? results : parseGenericPlatformHtml(html, source, city, origin, limit);
}

function parseWellceeHtml(html, source, city, origin, limit) {
  const $ = cheerio.load(String(html));
  let items = $('.house-item, .room-item, .item-card, div[class*="house-item"], div[class*="room-item"]').toArray();
  if (!items.length) {
    items = $('a[href*="/rent-house/detail/"], a[href*="/house/detail/"]').toArray();
  }
  const results = [];
  const seenCodes = new Set();
  for (const el of items) {
    if (results.length >= limit) break;
    const card = $(el);
    const linkEl = card.is('a') ? card : card.find('a[href*="/detail/"], a[href]').first();
    const href = linkEl.attr('href') || '';
    const url = href ? new URL(href, origin).href : origin;
    const title = clean(card.find('.title, .house-title, h3, h4, .name').first().text()) || clean(linkEl.attr('title')) || clean(card.find('img').first().attr('alt'));
    const priceText = card.find('.price, .house-price, .money, [class*="price"]').first().text().trim() || firstMatch(card.text(), /(?:¥|￥|\$)\s*(\d+(?:,\d+)?)/i);
    const price = parsePrice(priceText);
    const wholeText = clean(card.text());
    const area = extractArea(card.find('.area, [class*="area"]').text()) ?? extractArea(wholeText);
    const layout = extractLayout(card.find('.type, .room-type, [class*="type"]').text()) || extractLayout(title) || extractLayout(wholeText);
    const address = clean(card.find('.address, .location, .house-location, [class*="location"]').first().text())
      || firstMatch(wholeText, /(?:朝阳|海淀|东城|西城|静安|徐汇|浦东|黄浦|南山|福田|天河|越秀|武侯|锦江|西湖|余杭)[^,，|\s]*/i)
      || title;
    const houseCode = firstMatch(url, /\/detail\/([a-zA-Z0-9_-]+)/i) || card.attr('data-id') || null;
    if (houseCode && seenCodes.has(houseCode)) continue;
    if (houseCode) seenCodes.add(houseCode);
    const img = card.find('img[src], img[data-src], .cover-img').first();
    const image = img.attr('data-src') || img.attr('src') || null;
    const rentType = /合租|单间|Flatmate|Shared/i.test(wholeText) ? '合租' : /整租|Entire/i.test(wholeText) ? '整租' : null;
    if (!houseCode && !href && !title) continue;
    results.push({
      source,
      city,
      id: stableId(source, city, houseCode, url),
      title: title || `${address} ${layout || ''}`.trim() || 'Wellcee 精选房源',
      address,
      location: address,
      rent: price.rent,
      rentMin: price.rentMin,
      rentMax: price.rentMax,
      area,
      layout,
      url,
      image,
      raw: wholeText,
      rentType,
      floor: null,
      contact: 'Wellcee 无中介费房源 · 直接沟通',
      fetchedAt: new Date().toISOString(),
    });
  }
  return results.length ? results : parseGenericPlatformHtml(html, source, city, origin, limit);
}

function parseZiroomHtml(html, source, city, origin, limit) {
  const $ = cheerio.load(String(html));
  const items = $('.item, .Z_list-box .item, .info-box, .room-detail').toArray();
  const results = [];
  for (const el of items) {
    if (results.length >= limit) break;
    const card = $(el);
    const linkEl = card.find('.title a, h5 a, h4 a, a[href*="/z/"]').first();
    const href = linkEl.attr('href') || card.find('a[href]').first().attr('href') || '';
    const url = href ? new URL(href, origin).href : origin;
    const title = clean(linkEl.text()) || clean(card.find('.title, h5').first().text());
    const priceText = card.find('.price span, .num, .price').first().text().trim();
    const price = parsePrice(priceText);
    const desc = clean(card.find('.desc, .detail').text());
    const area = extractArea(desc) ?? extractArea(card.text());
    const layout = extractLayout(desc) || extractLayout(title);
    const address = clean(card.find('.location, .community').first().text()) || title;
    const houseCode = firstMatch(url, /(?:vr|z)\/(\d+)/i) || card.attr('data-id') || null;
    const img = card.find('img.lazy, img[data-original], img[src]').first();
    const image = img.attr('data-original') || img.attr('src') || null;
    const wholeText = clean(card.text());
    if (!houseCode && !href && !title) continue;
    results.push({
      source,
      city,
      id: stableId(source, city, houseCode, url),
      title: title || `${address} ${layout || ''}`.trim(),
      address,
      location: address,
      rent: price.rent,
      rentMin: price.rentMin,
      rentMax: price.rentMax,
      area,
      layout,
      url,
      image,
      raw: wholeText,
      rentType: /合租|友家/.test(title) ? '合租' : /整租/.test(title) ? '整租' : null,
      floor: firstMatch(desc, /(\d+[\/-]\d+层|[高中低]楼层)/i) || null,
      contact: '自如品质公寓 · 在线签约',
      fetchedAt: new Date().toISOString(),
    });
  }
  return results.length ? results : parseGenericPlatformHtml(html, source, city, origin, limit);
}

function parse58Html(html, source, city, origin, limit) {
  const $ = cheerio.load(String(html));
  let items = $('ul.listUl > li, .list-box li').toArray();
  if (!items.length) {
    items = $('div.des').toArray();
  }
  const results = [];
  const seenCodes = new Set();
  for (const el of items) {
    if (results.length >= limit) break;
    const card = $(el);
    const linkEl = card.find('h2 a, h3 a, a[href*="58.com"]').first();
    const href = linkEl.attr('href') || '';
    const url = href ? new URL(href, origin).href : origin;
    const title = clean(linkEl.text()) || clean(card.find('h2, h3').first().text());
    const priceText = card.find('div.money b, .price').first().text().trim();
    const price = parsePrice(priceText);
    const roomText = clean(card.find('p.room, .room').text());
    const area = extractArea(roomText) ?? extractArea(card.text());
    const layout = extractLayout(roomText) || extractLayout(title);
    const address = clean(card.find('p.add, .add, .address').first().text()) || title;
    const houseCode = firstMatch(url, /(\d+)x?\.shtml/i) || card.attr('data-id') || null;
    if (houseCode && seenCodes.has(houseCode)) continue;
    if (houseCode) seenCodes.add(houseCode);
    const img = card.find('img[data-src], img[src]').first();
    const image = img.attr('data-src') || img.attr('src') || null;
    const wholeText = clean(card.text());
    if (!houseCode && !href && !title) continue;
    results.push({
      source,
      city,
      id: stableId(source, city, houseCode, url),
      title: title || `${address} ${layout || ''}`.trim(),
      address,
      location: address,
      rent: price.rent,
      rentMin: price.rentMin,
      rentMax: price.rentMax,
      area,
      layout,
      url,
      image,
      raw: wholeText,
      rentType: /合租/.test(title) ? '合租' : /整租/.test(title) ? '整租' : null,
      floor: null,
      contact: '打开 58 同城查看',
      fetchedAt: new Date().toISOString(),
    });
  }
  return results.length ? results : parseGenericPlatformHtml(html, source, city, origin, limit);
}

function parseDoubanHtml(html, source, city, origin, limit) {
  const $ = cheerio.load(String(html));
  const items = $('table.olt tr:not(.th), div.result, .topic-item').toArray();
  const results = [];
  for (const el of items) {
    if (results.length >= limit) break;
    const card = $(el);
    const linkEl = card.find('td.title a, div.title a, a[href*="/topic/"]').first();
    const href = linkEl.attr('href') || '';
    const url = href ? new URL(href, origin).href : origin;
    const title = clean(linkEl.text()) || clean(card.text());
    if (!title || /置顶|版规|管理员/.test(title)) continue;
    const price = parsePrice(title);
    const area = extractArea(title);
    const layout = extractLayout(title);
    const address = firstMatch(title, /【([^】]+)】/i) || firstMatch(title, /(?:朝阳|海淀|东城|西城|双井|望京|静安|徐汇|南山|福田)[^\s]*/i) || title.slice(0, 40);
    const houseCode = firstMatch(url, /\/topic\/(\d+)/i) || null;
    const wholeText = clean(card.text());
    if (!houseCode && !href) continue;
    results.push({
      source,
      city,
      id: stableId(source, city, houseCode, url),
      title,
      address,
      location: address,
      rent: price.rent,
      rentMin: price.rentMin,
      rentMax: price.rentMax,
      area,
      layout,
      url,
      image: null,
      raw: wholeText,
      rentType: /合租|主卧|次卧|单间/.test(title) ? '合租' : /整租/.test(title) ? '整租' : null,
      floor: null,
      contact: '豆瓣小组讨论帖 · 个人直租',
      fetchedAt: new Date().toISOString(),
    });
  }
  return results.length ? results : parseGenericPlatformHtml(html, source, city, origin, limit);
}

function parseFangHtml(html, source, city, origin, limit) {
  const $ = cheerio.load(String(html));
  const items = $('.houseList dl, .list.hidden-v2 dl, .list dl').toArray();
  const results = [];
  for (const el of items) {
    if (results.length >= limit) break;
    const card = $(el);
    const linkEl = card.find('p.title a, dt a, a[href*="/chuzu/"]').first();
    const href = linkEl.attr('href') || '';
    const url = href ? new URL(href, origin).href : origin;
    const title = clean(linkEl.text()) || clean(card.find('.title').first().text());
    const priceText = card.find('span.price, .price, span.more').first().text().trim();
    const price = parsePrice(priceText);
    const desc = clean(card.find('p.font16, dd p').text());
    const area = extractArea(desc) ?? extractArea(card.text());
    const layout = extractLayout(desc) || extractLayout(title);
    const address = clean(card.find('p.gray, address').first().text()) || title;
    const houseCode = firstMatch(url, /\/chuzu\/([a-zA-Z0-9_-]+)/i) || card.attr('data-id') || null;
    const img = card.find('dt img, img[data-original], img[src]').first();
    const image = img.attr('data-original') || img.attr('src') || null;
    const wholeText = clean(card.text());
    if (!houseCode && !href && !title) continue;
    results.push({
      source,
      city,
      id: stableId(source, city, houseCode, url),
      title: title || `${address} ${layout || ''}`.trim(),
      address,
      location: address,
      rent: price.rent,
      rentMin: price.rentMin,
      rentMax: price.rentMax,
      area,
      layout,
      url,
      image,
      raw: wholeText,
      rentType: /合租/.test(title) ? '合租' : /整租/.test(title) ? '整租' : null,
      floor: null,
      contact: '打开房天下查看',
      fetchedAt: new Date().toISOString(),
    });
  }
  return results.length ? results : parseGenericPlatformHtml(html, source, city, origin, limit);
}

function parseXianyuHtml(html, source, city, origin, limit) {
  const $ = cheerio.load(String(html));
  const items = $('.feeds-item, .idle-item, a[href*="item.htm"], div[class*="item"]').toArray();
  const results = [];
  for (const el of items) {
    if (results.length >= limit) break;
    const card = $(el);
    const linkEl = card.is('a') ? card : card.find('a[href]').first();
    const href = linkEl.attr('href') || '';
    const url = href ? new URL(href, origin).href : origin;
    const title = clean(card.find('.title, h4').first().text()) || clean(linkEl.text());
    const priceText = card.find('.price').first().text().trim();
    const price = parsePrice(priceText);
    const wholeText = clean(card.text());
    const area = extractArea(wholeText);
    const layout = extractLayout(wholeText);
    const address = clean(card.find('.location, .city').first().text()) || title;
    const houseCode = firstMatch(url, /id=(\d+)/i) || card.attr('data-id') || null;
    const img = card.find('img').first();
    const image = img.attr('src') || img.attr('data-src') || null;
    if (!houseCode && !href && !title) continue;
    results.push({
      source,
      city,
      id: stableId(source, city, houseCode, url),
      title: title || `${address} ${layout || ''}`.trim(),
      address,
      location: address,
      rent: price.rent,
      rentMin: price.rentMin,
      rentMax: price.rentMax,
      area,
      layout,
      url,
      image,
      raw: wholeText,
      rentType: /合租/.test(title) ? '合租' : /整租/.test(title) ? '整租' : null,
      floor: null,
      contact: '闲鱼个人转租 · 阿里信用担保',
      fetchedAt: new Date().toISOString(),
    });
  }
  return results.length ? results : parseGenericPlatformHtml(html, source, city, origin, limit);
}

function parseGenericPlatformHtml(html, source, city, origin, limit) {
  const $ = cheerio.load(String(html));
  if ($('.content__list--item').length) {
    const chunks = cardChunks(html);
    return chunks.slice(0, limit).map((chunk) => parseListingBlock(chunk, source, city, origin)).filter(Boolean);
  }
  const candidateElements = $('article, .card, [class*="item"], [class*="listing"], tr').toArray();
  const results = [];
  for (const el of candidateElements) {
    if (results.length >= limit) break;
    const item = $(el);
    const text = clean(item.text());
    const priceMatch = text.match(/(?:¥|￥|\$)?\s*(\d{3,5})\s*(?:元|\/月|元\/月)/) || text.match(/(\d{3,5})\s*元/);
    if (!priceMatch) continue;
    const linkEl = item.is('a') ? item : item.find('a[href]').first();
    const href = linkEl.attr('href');
    if (!href) continue;
    let url;
    try { url = new URL(href, origin).href; } catch (_) { continue; }
    const title = clean(linkEl.text()) || text.slice(0, 50);
    const price = parsePrice(priceMatch[0]);
    const area = extractArea(text);
    const layout = extractLayout(text);
    const address = firstMatch(text, /(?:小区|位置|地址|位于)[：:\s]*([^|｜<\n;,，。]+)/i) || title.slice(0, 30);
    const houseCode = extractHouseCode(item.html(), url);
    results.push({
      source,
      city,
      id: stableId(source, city, houseCode, url),
      title: title || `${address} ${layout || ''}`.trim(),
      address,
      location: address,
      rent: price.rent,
      rentMin: price.rentMin,
      rentMax: price.rentMax,
      area,
      layout,
      url,
      image: item.find('img').first().attr('src') || item.find('img').first().attr('data-src') || null,
      raw: text,
      rentType: /合租/.test(text) ? '合租' : /整租/.test(text) ? '整租' : null,
      floor: null,
      contact: '打开平台查看',
      fetchedAt: new Date().toISOString(),
    });
  }
  return results;
}

function parsePlatformHtml(html, source, city, origin, limit = MAX_ITEMS_PER_SOURCE) {
  const text = String(html || '');
  if (containsCaptcha(text)) {
    const error = new Error('平台返回验证码或访问验证页面'); error.code = 'CAPTCHA'; throw error;
  }
  let listings = [];
  if (source === '链家' || source === '贝壳') {
    const chunks = cardChunks(text);
    listings = chunks.slice(0, limit).map((chunk) => parseListingBlock(chunk, source, city, origin)).filter(Boolean);
  } else if (source === '安居客') {
    listings = parseAnjukeHtml(text, source, city, origin, limit);
  } else if (source === 'Wellcee') {
    listings = parseWellceeHtml(text, source, city, origin, limit);
  } else if (source === '自如') {
    listings = parseZiroomHtml(text, source, city, origin, limit);
  } else if (source === '58同城') {
    listings = parse58Html(text, source, city, origin, limit);
  } else if (source === '豆瓣租房') {
    listings = parseDoubanHtml(text, source, city, origin, limit);
  } else if (source === '房天下') {
    listings = parseFangHtml(text, source, city, origin, limit);
  } else if (source === '闲鱼') {
    listings = parseXianyuHtml(text, source, city, origin, limit);
  } else {
    listings = parseGenericPlatformHtml(text, source, city, origin, limit);
  }
  return listings;
}

module.exports = {
  CITY_SLUGS,
  WELLCEE_CITY_SLUGS,
  SUPPORTED_SOURCES,
  SOURCE_ALIASES,
  MAX_PAGES,
  MAX_ITEMS_PER_SOURCE,
  cityFromQuery,
  normalizeQuery,
  makePlatformSearchUrl,
  makeSearchUrls,
  parsePrice,
  extractArea,
  extractLayout,
  containsCaptcha,
  extractHouseCode,
  stableId,
  parseListingBlock,
  parseAnjukeHtml,
  parseWellceeHtml,
  parseZiroomHtml,
  parse58Html,
  parseDoubanHtml,
  parseFangHtml,
  parseXianyuHtml,
  parseGenericPlatformHtml,
  parsePlatformHtml,
  subwaySearchTerms,
  htmlDecode,
  clean,
};
