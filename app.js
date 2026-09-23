(() => {
  "use strict";

  const STORAGE_KEY = "renting-radar-listings-v3";
  const FILTER_KEY = "renting-radar-filters-v2";
  const API_BASE = (window.RENTAL_CONFIG && window.RENTAL_CONFIG.apiBase) || "";
  const SOURCES = ["链家", "贝壳", "安居客", "58同城", "自如", "Wellcee", "小红书", "豆瓣租房", "闲鱼", "房天下"];
  const DEFAULT_SOURCES = ["链家", "贝壳", "小红书"];
  const CITY_SLUGS = { 北京: "bj", 上海: "sh", 广州: "gz", 深圳: "sz", 杭州: "hz", 成都: "cd", 南京: "nj", 武汉: "wh", 西安: "xa", 重庆: "cq", 天津: "tj", 苏州: "su", 厦门: "xm", 济南: "jn", 郑州: "zz", 青岛: "qd", 宁波: "nb", 无锡: "wx", 昆明: "km", 福州: "fz", 长沙: "cs", 合肥: "hf", 佛山: "fs", 东莞: "dg", 香港: "hk" };
  const CITIES = Object.keys(CITY_SLUGS);

  const CITY_SUBWAYS = Object.freeze({
    北京: ["1号线/八通线", "2号线", "4号线/大兴线", "5号线", "6号线", "7号线", "8号线", "9号线", "10号线", "11号线", "13号线", "14号线", "15号线", "16号线", "17号线", "19号线", "昌平线", "房山线", "亦庄线", "燕房线", "S1线", "首都机场线", "大兴机场线"],
    上海: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "7号线", "8号线", "9号线", "10号线", "11号线", "12号线", "13号线", "14号线", "15号线", "16号线", "17号线", "18号线", "浦江线", "磁浮线"],
    广州: ["1号线", "2号线", "3号线", "3号线北延段", "4号线", "5号线", "6号线", "7号线", "8号线", "9号线", "13号线", "14号线", "18号线", "21号线", "22号线", "广佛线", "APM线"],
    深圳: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "6号线支线", "7号线", "8号线", "9号线", "10号线", "11号线", "12号线", "14号线", "16号线", "20号线"],
    杭州: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "7号线", "8号线", "9号线", "10号线", "16号线", "19号线"],
    成都: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "7号线", "8号线", "9号线", "10号线", "17号线", "18号线", "19号线", "有轨电车蓉2号线"],
    武汉: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "7号线", "8号线", "11号线", "16号线", "阳逻线"],
    南京: ["1号线", "2号线", "3号线", "4号线", "7号线", "10号线", "S1号线", "S3号线", "S6号线", "S7号线", "S8号线", "S9号线"],
    西安: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "9号线", "14号线", "16号线"],
    重庆: ["环线", "1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "9号线", "10号线", "国博线"],
    天津: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "8号线", "9号线", "10号线"],
    苏州: ["1号线", "2号线", "3号线", "4号线", "5号线", "11号线"],
    长沙: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "磁浮快线"],
    郑州: ["1号线", "2号线", "3号线", "4号线", "5号线", "14号线", "城郊线"],
    青岛: ["1号线", "2号线", "3号线", "4号线", "8号线", "11号线", "13号线"],
    合肥: ["1号线", "2号线", "3号线", "4号线", "5号线"],
    佛山: ["广佛线", "2号线", "3号线"],
    东莞: ["2号线"],
    宁波: ["1号线", "2号线", "3号线", "4号线", "5号线"],
    无锡: ["1号线", "2号线", "3号线", "4号线", "S1线"],
    昆明: ["1号线", "2号线", "3号线", "4号线", "5号线", "6号线"],
    福州: ["1号线", "2号线", "4号线", "5号线", "6号线"],
    厦门: ["1号线", "2号线", "3号线"],
    济南: ["1号线", "2号线", "3号线"],
    香港: ["港岛线", "荃湾线", "观塘线", "南港岛线", "将军澳线", "东涌线", "迪士尼线", "机场快线", "东铁线", "屯马线"]
  });

  function subwaySearchTerms(line) {
    if (!line) return [];
    const cleanLine = String(line).trim();
    const terms = new Set([cleanLine]);
    const numMatch = cleanLine.match(/(\d+)号线/);
    if (numMatch) {
      const num = numMatch[1];
      const cnDigits = { "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六", "7": "七", "8": "八", "9": "九", "10": "十", "11": "十一", "12": "十二", "13": "十三", "14": "十四", "15": "十五", "16": "十六", "17": "十七", "18": "十八", "19": "十九", "20": "二十", "21": "二十一", "22": "二十二" };
      if (cnDigits[num]) terms.add(`${cnDigits[num]}号线`);
    }
    const cnMatch = cleanLine.match(/([一二三四五六七八九十]+)号线/);
    if (cnMatch) {
      const cn = cnMatch[1];
      const numDigits = { "一": "1", "二": "2", "三": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "十": "10", "十一": "11", "十二": "12", "十三": "13", "十四": "14", "十五": "15", "十六": "16", "十七": "17", "十八": "18", "十九": "19", "二十": "20" };
      if (numDigits[cn]) terms.add(`${numDigits[cn]}号线`);
    }
    if (cleanLine.includes("/")) {
      cleanLine.split("/").forEach(part => {
        if (part.trim()) terms.add(part.trim());
      });
    }
    return Array.from(terms);
  }

  function extractSubway(text = "") {
    const match = String(text).match(/(?:(?:近|距离|距)?(?:地铁)?([0-9一二三四五六七八九十]+号线|[^\s/，,·|]+线)(?:[^\s/，,·|]+站)?(?:[0-9]+米)?)/);
    return match ? match[0].trim() : "";
  }

  function matchesSubway(item, wanted) {
    if (!wanted) return true;
    const terms = subwaySearchTerms(wanted);
    const content = `${item.subway || ""} ${item.title || ""} ${item.location || ""} ${item.address || ""} ${item.raw || ""}`;
    return terms.some(term => content.includes(term));
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const numberOrNull = value => value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  const safeInt = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const sourceClass = source => ({
    链家: "lianjia",
    贝壳: "beike",
    安居客: "anjuke",
    "58同城": "wubai",
    自如: "ziroom",
    Wellcee: "wellcee",
    小红书: "xiaohongshu",
    豆瓣租房: "douban",
    闲鱼: "xianyu",
    房天下: "fang"
  }[source] || "manual");
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const updateIcons = () => {
    window.lucide?.createIcons({ attrs: { 'stroke-width': 1.7 } });
    $$('svg[data-lucide]').forEach(svg => svg.removeAttribute('data-lucide'));
  };

  function normalizeLayout(value) {
    const text = String(value || "").replace(/[零一二两三四五六七八九十]/g, digit => ({ 零: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10" }[digit]));
    if (/开间/.test(text)) return { rooms: 1, halls: 0 };
    const rooms = text.match(/(\d+)\s*(?:室|居)/); const halls = text.match(/(\d+)\s*厅/);
    return { rooms: rooms ? Number(rooms[1]) : null, halls: halls ? Number(halls[1]) : null };
  }

  function matchesLayout(item, wanted) {
    if (!wanted) return true;
    if (wanted === "合租") return /合租/.test(`${item.rentType || ""} ${item.title || ""} ${item.layout || ""}`);
    const layout = normalizeLayout(item.layout); const target = normalizeLayout(wanted);
    return layout.rooms === target.rooms && layout.halls === target.halls;
  }

  const state = {
    listings: loadListings(),
    filters: loadFilters(),
    sort: "default",
    view: "cards",
    favoriteOnly: false,
    connectorOnline: false,
    platformLinks: {},
    searchStatus: "idle",
    searching: false,
    commuteRun: null,
    commuteTarget: null,
    commuteCoordinates: null,
    commuteError: ""
  };

  function stableKey(item) {
    if (item.stableKey) return item.stableKey;
    const source = item.source || "未知来源";
    const original = item.url || item.link || "";
    const signature = original || [item.title, item.location || item.address, item.rent, item.area, item.layout].filter(Boolean).join("|");
    return `${source}|${String(signature).trim().toLowerCase()}`;
  }

  function normalizeStoredListing(item) {
    if (!item || typeof item !== "object" || !SOURCES.includes(item.source)) return null;
    if (String(item.id || "").startsWith("sample-")) return null;
    const wholeRaw = `${item.raw || ""} ${item.title || ""} ${item.location || ""} ${item.address || ""}`;
    const subway = item.subway || extractSubway(wholeRaw);
    return { ...item, id: stableKey(item), stableKey: stableKey(item), city: cityParts(item.city || "").city || item.city || "", subway: subway || "", rent: numberOrNull(item.rent), rentMin: numberOrNull(item.rentMin), rentMax: numberOrNull(item.rentMax), favorite: Boolean(item.favorite), createdAt: item.createdAt || Date.now() };
  }

  function dedupeListings(list) {
    const byKey = new Map();
    list.map(normalizeStoredListing).filter(Boolean).forEach(item => {
      const key = stableKey(item);
      const previous = byKey.get(key);
      byKey.set(key, previous ? { ...previous, ...item, favorite: previous.favorite || item.favorite, stableKey: key, id: previous.id || item.id } : { ...item, stableKey: key });
    });
    return Array.from(byKey.values());
  }

  function loadListings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return Array.isArray(saved) ? dedupeListings(saved) : [];
    } catch (_) { return []; }
  }

  function loadFilters() {
    const defaults = { city: "", subway: "", rentMin: "", rentMax: "", layout: "", area: "", areaMin: "", areaMax: "", commute: "", commuteMaxKm: "", pages: "1", sources: [...DEFAULT_SOURCES] };
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY));
      const filters = saved && typeof saved === "object" ? { ...defaults, ...saved } : defaults;
      filters.sources = Array.isArray(filters.sources) ? filters.sources.filter(source => SOURCES.includes(source)) : [...DEFAULT_SOURCES];
      filters.pages = String(Math.min(3, Math.max(1, safeInt(filters.pages) || 1)));
      return filters;
    } catch (_) { return defaults; }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dedupeListings(state.listings)));
      localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters));
    } catch (_) { /* local storage may be unavailable in private browsing */ }
  }

  function updateSubwayOptions(cityName) {
    const city = cityParts(cityName).city || "";
    const select = $("#subwaySelect");
    const container = $("#subwayQuickTags");
    if (!select) return;
    const current = state.filters.subway || select.value || "";
    const lines = CITY_SUBWAYS[city] || [];
    select.innerHTML = `<option value="">${lines.length ? "不限地铁线路" : "该城市暂无预设地铁线"}</option>` +
      lines.map(line => `<option value="${escapeHtml(line)}">${escapeHtml(line)}</option>`).join("");
    if (lines.includes(current)) {
      select.value = current;
    } else {
      select.value = "";
      state.filters.subway = "";
    }
    if (container) {
      const popular = lines.slice(0, 4);
      container.innerHTML = popular.map(line => `<button type="button" data-subway="${escapeHtml(line)}">${escapeHtml(line)}</button>`).join("");
    }
  }

  function applyFiltersToForm() {
    const f = state.filters;
    $("#cityInput").value = f.city;
    updateSubwayOptions(f.city);
    if ($("#subwaySelect")) $("#subwaySelect").value = f.subway || "";
    $("#rentMin").value = f.rentMin;
    $("#rentMax").value = f.rentMax;
    $("#layoutSelect").value = f.layout;
    $("#areaSelect").value = f.area;
    $("#areaMin").value = f.areaMin;
    $("#areaMax").value = f.areaMax;
    $("#commuteInput").value = f.commute;
    $("#commuteMaxKm").value = f.commuteMaxKm;
    $("#pagesSelect").value = f.pages;
    $$('input[type="checkbox"]', $(".source-checks")).forEach(input => { input.checked = f.sources.includes(input.value); });
  }

  function readFilters() {
    const previousTarget = currentCommuteKey();
    state.filters = {
      city: $("#cityInput").value.trim(),
      subway: $("#subwaySelect")?.value || "",
      rentMin: $("#rentMin").value,
      rentMax: $("#rentMax").value,
      layout: $("#layoutSelect").value,
      area: $("#areaSelect").value,
      areaMin: $("#areaMin").value,
      areaMax: $("#areaMax").value,
      commute: $("#commuteInput").value.trim(),
      commuteMaxKm: $("#commuteMaxKm").value,
      pages: $("#pagesSelect").value || "1",
      sources: $$('input[type="checkbox"]:checked', $(".source-checks")).map(input => input.value)
    };
    if (previousTarget !== currentCommuteKey()) {
      cancelCommute();
      state.commuteTarget = null;
      state.commuteCoordinates = null;
      state.commuteError = "";
    }
    persist();
    updateQueryPreview();
  }

  function setValidation(id, message) {
    const element = $(`#${id}`);
    if (!element) return;
    element.textContent = message || "";
    element.hidden = !message;
    const control = id === "cityValidation" ? $("#cityInput") : id === "rentValidation" ? $("#rentMin") : id === "commuteValidation" ? $("#commuteMaxKm") : $("#areaMin");
    control?.closest(".field-group")?.classList.toggle("has-error", Boolean(message));
  }

  function validateFilters(requireCity = false) {
    const f = state.filters;
    setValidation("cityValidation", requireCity && !f.city ? "请输入城市或区域后再开始获取" : "");
    const rentMin = numberOrNull(f.rentMin); const rentMax = numberOrNull(f.rentMax);
    const area = getAreaBounds();
    const rentError = (rentMin !== null && rentMin < 0) || (rentMax !== null && rentMax < 0) ? "租金不能为负数" : rentMin !== null && rentMax !== null && rentMin > rentMax ? "最低租金不能高于最高租金" : "";
    const areaError = (area.min !== null && area.min < 0) || (area.max !== null && area.max < 0) ? "面积不能为负数" : area.min !== null && area.max !== null && area.min > area.max ? "最小面积不能高于最大面积" : "";
    setValidation("rentValidation", rentError);
    setValidation("areaValidation", areaError);
    const radius = numberOrNull(f.commuteMaxKm);
    const commuteError = radius !== null && (radius < 0.1 || radius > 100) ? "距离须在 0.1–100 公里之间" : radius !== null && !f.commute ? "请先填写通勤地点" : radius !== null && !cityParts(f.city).city ? "请先填写目标城市" : "";
    setValidation("commuteValidation", commuteError);
    if (requireCity && !f.city) return false;
    if (rentError || areaError || commuteError) return false;
    return true;
  }

  function getAreaBounds() {
    const f = state.filters;
    const customMin = numberOrNull(f.areaMin); const customMax = numberOrNull(f.areaMax);
    if (customMin !== null || customMax !== null) return { min: customMin, max: customMax };
    if (!f.area) return { min: null, max: null };
    const [min, max] = f.area.split(",").map(numberOrNull);
    return { min, max };
  }

  function rentBounds(item) {
    const exact = numberOrNull(item.rent); const low = numberOrNull(item.rentMin); const high = numberOrNull(item.rentMax);
    return { min: low ?? exact ?? high, max: high ?? exact ?? low };
  }

  function formatRent(item) {
    const { min, max } = rentBounds(item);
    if (min === null) return "待确认";
    const format = number => Number(number).toLocaleString("zh-CN");
    return min === max ? `¥${format(min)}` : `¥${format(min)}–${format(max)}`;
  }

  function compareKnown(a, b, descending = false) {
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return descending ? b - a : a - b;
  }
  function formatTime(timestamp) {
    const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp || "") || Date.now();
    const minutes = Math.max(1, Math.round((Date.now() - time) / 60000));
    if (minutes < 60) return `${minutes} 分钟前`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
    return `${Math.round(minutes / 1440)} 天前`;
  }

  function cityParts(value) {
    const text = String(value || "").trim();
    const city = CITIES.find(name => text.includes(name)) || "";
    const remainder = city ? text.replace(city, "").replace(/^市/, "") : text;
    const region = remainder.split(/[·,，\s]+/).map(item => item.trim()).filter(Boolean).join(" ");
    return { city, region };
  }

  function matchesCity(item, cityQuery) {
    if (!cityQuery) return true;
    const wanted = cityParts(cityQuery);
    if (!wanted.city) return `${item.location || ""} ${item.title || ""}`.includes(wanted.region);
    const itemCity = cityParts(item.city || "").city || cityParts(item.location || "").city;
    if (itemCity && itemCity !== wanted.city) return false;
    if (!itemCity && !(item.location || "").includes(wanted.city)) return false;
    return !wanted.region || wanted.region.split(/\s+/).every(term => `${item.location || ""} ${item.title || ""}`.includes(term));
  }

  function currentCommuteKey() {
    return JSON.stringify([cityParts(state.filters.city).city, state.filters.commute.trim().replace(/\s+/g, " ").toLowerCase()]);
  }

  function commuteAddress(item) {
    return JSON.stringify([item.city || "", item.location || item.address || "", item.coordinates || null]);
  }

  function cancelCommute() {
    if (state.commuteRun) state.commuteRun.controller.abort();
    state.commuteRun = null;
  }

  function renderCommuteStatus() {
    const button = $("#calculateCommuteBtn");
    const status = $("#commuteStatus");
    const candidates = getFilteredListings(true);
    const resolved = candidates.filter(item => distanceValue(item) !== null).length;
    const missing = candidates.length - resolved;
    button.disabled = Boolean(state.commuteRun) || !state.filters.commute || !cityParts(state.filters.city).city || !candidates.length;
    button.innerHTML = `${icon(state.commuteRun ? "loader-circle" : "locate-fixed")} ${state.commuteRun ? "正在计算距离" : "计算通勤距离"}`;
    status.classList.toggle("is-error", Boolean(state.commuteError));
    if (state.commuteError) status.textContent = state.commuteError;
    else if (state.commuteRun) status.textContent = `正在定位 ${state.commuteRun.done}/${state.commuteRun.total} 条房源`;
    else if (!state.filters.commute) status.textContent = "距离未计算";
    else if (!candidates.length) status.textContent = "暂无可计算的房源";
    else {
      const target = state.commuteTarget?.key === currentCommuteKey() ? state.commuteTarget.label : state.filters.commute;
      status.textContent = `${target} · 已定位 ${resolved}/${candidates.length} 条${missing ? `；${missing} 条距离未知${numberOrNull(state.filters.commuteMaxKm) !== null ? "，已排除" : ""}` : ""}`;
    }
  }

  async function calculateCommute(force = false) {
    if (state.commuteRun || !state.filters.commute || !cityParts(state.filters.city).city) return;
    const key = currentCommuteKey();
    const candidates = getFilteredListings(true).filter(item => distanceValue(item) === null && (force || item.distanceTarget !== key || item.distanceAddress !== commuteAddress(item) || !item.geocodeStatus));
    if (!candidates.length) { renderCommuteStatus(); updateIcons(); return; }
    const run = { key, done: 0, total: candidates.length, controller: new AbortController() };
    state.commuteRun = run;
    state.commuteError = "";
    const city = cityParts(state.filters.city).city;
    const commute = state.filters.commute;
    render();
    try {
      // Small batches keep geocoder rate limits and request timeouts bounded.
      for (let offset = 0; offset < candidates.length; offset += 5) {
        if (state.commuteRun !== run || currentCommuteKey() !== key) return;
        const batch = candidates.slice(offset, offset + 5);
        const signatures = new Map(batch.map(item => [item.id, commuteAddress(item)]));
        const batchBody = {
          city, commute,
          listings: batch.map(item => ({ id: item.id, city: item.city, address: item.location, ...(item.coordinates ? { coordinates: item.coordinates } : {}) }))
        };
        if (state.commuteCoordinates) {
          batchBody.targetCoordinates = state.commuteCoordinates;
        }
        const payload = await fetchJson("/api/commute", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: run.controller.signal,
          body: JSON.stringify(batchBody)
        });
        if (state.commuteRun !== run || currentCommuteKey() !== key) return;
        if (payload.target?.key !== key || !Array.isArray(payload.listings)) throw new Error("定位结果与当前通勤地点不一致，请重试");
        if (batch.some(item => !payload.listings.some(result => result.id === item.id && result.distanceTarget === key))) throw new Error("部分房源未返回定位状态，请重试");
        state.commuteTarget = payload.target;
        for (const result of payload.listings) {
          const item = state.listings.find(listing => listing.id === result.id);
          if (!item || signatures.get(item.id) !== commuteAddress(item) || result.distanceTarget !== key) continue;
          item.distanceKm = numberOrNull(result.distanceKm);
          item.distanceTarget = key;
          item.distanceAddress = commuteAddress(item);
          item.geocodeStatus = ["resolved", "not_found", "error"].includes(result.geocodeStatus) ? result.geocodeStatus : "error";
        }
        run.done += batch.length;
        persist();
        render();
      }
    } catch (error) {
      if (state.commuteRun === run && !run.controller.signal.aborted) state.commuteError = `距离计算未完成：${error.message}`;
    } finally {
      if (state.commuteRun === run) {
        state.commuteRun = null; render();
        if (!state.commuteError && state.filters.commute && cityParts(state.filters.city).city && validateFilters(false)) void calculateCommute();
      }
    }
  }

  function distanceValue(item) {
    if (!state.filters.commute || item.distanceTarget !== currentCommuteKey() || item.distanceAddress !== commuteAddress(item)) return null;
    const value = numberOrNull(item.distanceKm);
    return value !== null && value >= 0 ? value : null;
  }

  function commuteText(item) {
    if (!state.filters.commute) return "未填写通勤地";
    const distance = distanceValue(item);
    if (distance !== null) return `直线 ${distance.toFixed(2)} 公里`;
    if (item.distanceTarget === currentCommuteKey() && item.distanceAddress === commuteAddress(item) && item.geocodeStatus === "not_found") return "地址无法定位";
    return "距离待计算";
  }

  function commuteLink(item) {
    const destination = `${state.filters.commute} ${item.location || item.title || ""}`.trim();
    return `https://map.baidu.com/search/${encodeURIComponent(destination)}`;
  }

  function getFilteredListings(ignoreDistance = false) {
    const f = state.filters; const area = getAreaBounds();
    let list = state.listings.filter(item => {
      if (state.favoriteOnly && !item.favorite) return false;
      if (f.sources.length === 0 || !f.sources.includes(item.source)) return false;
      if (!matchesCity(item, f.city)) return false;
      if (!matchesSubway(item, f.subway)) return false;
      const rent = rentBounds(item); const budgetMin = numberOrNull(f.rentMin); const budgetMax = numberOrNull(f.rentMax);
      if ((budgetMin !== null || budgetMax !== null) && rent.min === null) return false;
      if (budgetMin !== null && rent.max < budgetMin) return false;
      if (budgetMax !== null && rent.min > budgetMax) return false;
      if (!matchesLayout(item, f.layout)) return false;
      if (area.min !== null && (item.area === null || item.area === undefined || item.area < area.min)) return false;
      if (area.max !== null && (item.area === null || item.area === undefined || item.area > area.max)) return false;
      const radius = numberOrNull(f.commuteMaxKm);
      if (!ignoreDistance && radius !== null) {
        const distance = distanceValue(item);
        if (distance === null || distance > radius) return false;
      }
      return true;
    });
    if (state.sort === "rentAsc") list.sort((a, b) => compareKnown(rentBounds(a).min, rentBounds(b).min));
    if (state.sort === "rentDesc") list.sort((a, b) => compareKnown(rentBounds(a).max, rentBounds(b).max, true));
    if (state.sort === "areaDesc") list.sort((a, b) => compareKnown(numberOrNull(a.area), numberOrNull(b.area), true));
    if (state.sort === "distanceAsc") list.sort((a, b) => compareKnown(distanceValue(a), distanceValue(b)));
    if (state.sort === "default") list.sort((a, b) => (Date.parse(b.createdAt || "") || Number(b.createdAt) || 0) - (Date.parse(a.createdAt || "") || Number(a.createdAt) || 0));
    return list;
  }

  function render() {
    const visible = getFilteredListings();
    const listEl = $("#resultsList");
    $("#totalCount").textContent = state.listings.length;
    $("#filteredCount").textContent = visible.length;
    const rents = visible.map(rentBounds).filter(rent => rent.min !== null && rent.min === rent.max).map(rent => rent.min);
    $("#avgRent").textContent = rents.length ? `¥${Math.round(rents.reduce((a, b) => a + b, 0) / rents.length).toLocaleString("zh-CN")}` : "—";
    $("#favoriteCount").textContent = state.listings.filter(item => item.favorite).length;
    $("#listCountLabel").textContent = `${visible.length} 条`;
    $("#showFavorites").textContent = state.favoriteOnly ? "查看全部" : "查看";
    $("#exportCsvBtn").disabled = visible.length === 0;
    listEl.classList.toggle("table-view", state.view === "table");
    listEl.innerHTML = visible.map(renderCard).join("");
    const emptyState = $("#emptyState");
    emptyState.hidden = visible.length > 0;
    if (!visible.length) {
      $("h3", emptyState).textContent = state.listings.length ? "当前条件没有匹配房源" : state.searchStatus === "empty" ? "本次没有找到房源" : state.searchStatus === "error" ? "本次获取未完成" : "暂无房源";
      $("p", emptyState).textContent = state.listings.length ? "可调整筛选条件。" : state.searchStatus === "idle" ? "尚未开始搜索。" : "各平台返回状态见上方。";
    }
    updateQueryPreview();
    renderCommuteStatus();
    updateIcons();
  }

  function renderCard(item) {
    const link = item.link || state.platformLinks[item.source] || platformUrl(item.source, item.location || item.title);
    const commute = state.filters.commute ? `<a class="commute-chip" href="${escapeHtml(commuteLink(item))}" target="_blank" rel="noopener noreferrer" title="在地图中查看通勤地点">${icon("map-pin")}${escapeHtml(commuteText(item))}</a>` : `<span class="commute-chip">通勤待设置</span>`;
    const subway = item.subway ? `<span class="subway-chip" title="${escapeHtml(item.subway)}">${icon("train-front")}${escapeHtml(item.subway)}</span>` : "";
    const photo = /^https?:\/\//i.test(item.image || "") ? `<a class="listing-photo" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" /></a>` : "";
    const favoriteTitle = item.favorite ? "取消收藏" : "收藏房源";
    return `<article class="listing-card" data-id="${escapeHtml(item.id)}">
      ${photo}<div class="listing-content"><div class="card-top"><span class="source-pill ${sourceClass(item.source)}">${escapeHtml(item.source)}</span><span class="card-time">${formatTime(item.createdAt)}</span><button class="icon-button favorite-btn ${item.favorite ? "active" : ""}" type="button" data-action="favorite" title="${favoriteTitle}" aria-label="${favoriteTitle}">${icon("star")}</button></div>
      <strong class="listing-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
      <div class="listing-location">${icon("map-pin")}<span title="${escapeHtml(item.location)}">${escapeHtml(item.location || "位置待补充")}</span></div>
      <div class="card-details"><div class="detail-item"><small>月租</small><strong class="rent">${formatRent(item)}</strong></div><div class="detail-item"><small>户型</small><strong>${escapeHtml(item.layout || "待确认")}</strong></div><div class="detail-item"><small>面积</small><strong>${item.area !== null && item.area !== undefined ? `${item.area}㎡` : "待确认"}</strong></div></div>
      <div class="card-bottom"><div class="card-chips">${commute}${subway}</div><div class="card-actions"><button class="icon-button" type="button" data-action="remove" aria-label="移除房源" title="移除房源">${icon("trash-2")}</button><a class="icon-button" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" aria-label="打开原始房源" title="打开原始房源">${icon("external-link")}</a></div></div></div>
    </article>`;
  }

  function updateQueryPreview() {
    const f = state.filters; const city = f.city || "未填写城市";
    const subwayText = f.subway ? `　🚇 ${f.subway}` : "";
    const rent = f.rentMin || f.rentMax ? `　${f.rentMin || 0}–${f.rentMax || "不限"} 元/月` : "　不限预算";
    const layout = f.layout || "不限户型"; const area = getAreaBounds();
    const areaText = area.min !== null || area.max !== null ? `　${area.min ?? 0}–${area.max ?? "不限"}㎡` : "";
    const commuteText = f.commute && numberOrNull(f.commuteMaxKm) !== null ? `　${f.commute} · 直线 ${f.commuteMaxKm} 公里内` : "";
    $("#queryPreview").textContent = `${city}${subwayText}${rent}　${layout}${areaText}${commuteText}`;
  }

  function platformUrl(platform, query = "") {
    const { city } = cityParts(state.filters.city);
    const slug = CITY_SLUGS[city] || "bj";
    const encoded = encodeURIComponent(query || `${state.filters.city} 租房`);
    if (platform === "链家") return `https://${slug}.lianjia.com/zufang/`;
    if (platform === "贝壳") return `https://${slug}.zu.ke.com/zufang/`;
    if (platform === "安居客") return `https://${slug}.zu.anjuke.com/fangyuan/?kw=${encoded}`;
    if (platform === "58同城") return `https://${slug}.58.com/chuzu/?key=${encoded}`;
    if (platform === "自如") return `https://${slug}.ziroom.com/z/?q=${encoded}`;
    if (platform === "Wellcee") {
      const wellceeSlugs = {
        北京: "beijing", 上海: "shanghai", 广州: "guangzhou", 深圳: "shenzhen",
        杭州: "hangzhou", 成都: "chengdu", 南京: "nanjing", 武汉: "wuhan",
        西安: "xian", 重庆: "chongqing", 苏州: "suzhou", 天津: "tianjin",
        郑州: "zhengzhou", 长沙: "changsha", 青岛: "qingdao", 厦门: "xiamen",
        合肥: "hefei", 济南: "jinan", 佛山: "foshan", 东莞: "dongguan",
        宁波: "ningbo", 无锡: "wuxi", 昆明: "kunming", 福州: "fuzhou", 香港: "hongkong"
      };
      return `https://www.wellcee.com/rent-house/${wellceeSlugs[city] || "beijing"}?keyword=${encoded}`;
    }
    if (platform === "豆瓣租房") return `https://www.douban.com/group/search?cat=1019&q=${encoded}`;
    if (platform === "闲鱼") return `https://www.goofish.com/search?q=${encoded}`;
    if (platform === "房天下") return slug === "bj" ? `https://zu.fang.com/?keyword=${encoded}` : `https://zu.${slug}.fang.com/?keyword=${encoded}`;
    return `https://www.xiaohongshu.com/search_result?keyword=${encoded}`;
  }

  function setPlatformState(platform, status, message, label = "", searchUrl = "") {
    const card = $(`.platform-card[data-platform="${platform}"]`); if (!card) return;
    const badge = $(".status-badge", card);
    badge.className = `status-badge status-${status}`;
    badge.textContent = label || ({ working: "获取中", ok: "已获取", ready: "待搜索", partial: "部分完成", limited: "范围有限", empty: "0 条结果", needs_login: "需登录", blocked: "访问受限", error: "连接失败", unavailable: "不可用", unselected: "未选择", idle: "待连接" }[status] || "状态未知");
    $(".platform-message", card).textContent = message;
    const link = $(".platform-link", card); const href = searchUrl || state.platformLinks[platform] || platformUrl(platform, `${state.filters.city} ${state.filters.layout} 租房`);
    state.platformLinks[platform] = href; link.href = href; link.target = "_blank";
  }

  function normalizeRemoteListing(item, source, index, city) {
    const wholeRaw = `${item.raw || ""} ${item.title || ""} ${item.address || item.district || item.location || ""}`;
    const subway = item.subway || item.tags?.find?.(tag => /地铁|号线/.test(tag)) || extractSubway(wholeRaw);
    const normalized = {
      id: item.id || `${source}-${item.url || item.link || item.title || index}`,
      source,
      title: item.title || `${item.address || item.district || "公开房源"} · ${item.layout || "待确认"}`,
      location: item.address || item.district || item.location || "位置待补充",
      city: item.city || city,
      rent: numberOrNull(item.rent), rentMin: numberOrNull(item.rentMin), rentMax: numberOrNull(item.rentMax), layout: item.layout || "待确认", area: numberOrNull(item.area), rentType: item.rentType || "", image: item.image || "",
      subway: subway || "",
      contact: item.contact || "打开平台查看", link: item.url || item.link || platformUrl(source),
      distanceKm: numberOrNull(item.distanceKm), distanceTarget: item.distanceTarget || "", travelMinutes: numberOrNull(item.travelMinutes),
      coordinates: item.coordinates || null,
      createdAt: item.createdAt || Date.now() - index, raw: item.raw || "", favorite: false
    };
    normalized.stableKey = stableKey(normalized);
    normalized.id = normalized.stableKey;
    return normalized;
  }

  async function fetchJson(path, options = {}) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 75000);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const response = await fetch(`${API_BASE.replace(/\/$/, "")}${path}`, { ...options, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      if (!payload) throw new Error("服务端没有返回有效 JSON");
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超过 75 秒，请稍后重试");
      throw error;
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  }

  async function requestRemoteSearch() {
    const f = state.filters; const area = getAreaBounds();
    return fetchJson("/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: f.city, subway: f.subway, layout: f.layout, areaMin: area.min, areaMax: area.max, rentMin: numberOrNull(f.rentMin), rentMax: numberOrNull(f.rentMax), commute: f.commute, sources: f.sources, pages: Number(f.pages) || 1 })
    });
  }

  function mergeListings(incoming) {
    const existing = new Map(state.listings.map(item => [stableKey(item), item]));
    incoming.forEach(item => {
      const key = stableKey(item); const old = existing.get(key);
      const merged = { ...(old || {}), ...item, stableKey: key, id: old?.id || item.id, favorite: Boolean(old?.favorite || item.favorite) };
      if (old && commuteAddress(old) === commuteAddress(item)) {
        for (const field of ["distanceKm", "distanceTarget", "distanceAddress", "geocodeStatus"]) merged[field] = old[field];
      } else {
        merged.distanceKm = null; merged.distanceTarget = ""; merged.distanceAddress = ""; merged.geocodeStatus = "";
      }
      existing.set(key, merged);
    });
    state.listings = Array.from(existing.values());
  }

  async function runSearchTask() {
    if (state.searching) return;
    readFilters();
    if (!validateFilters(true)) { showToast("请先修正筛选条件"); return; }
    render();
    if (state.filters.sources.length === 0) { SOURCES.forEach(platform => setPlatformState(platform, "unselected", "本次未选择")); $("#lastRun").textContent = "未开始 · 没有选择来源"; showToast("至少选择一个信息来源"); return; }
    state.searching = true;
    const button = $("#runSearchBtn"); button.disabled = true; button.innerHTML = `${icon("loader-circle")} 正在获取`; updateIcons();
    const selected = [...state.filters.sources]; const queryCity = cityParts(state.filters.city).city;
    SOURCES.forEach(platform => setPlatformState(platform, selected.includes(platform) ? "working" : "unselected", selected.includes(platform) ? "正在请求本地连接层…" : "本次未选择", selected.includes(platform) ? "准备中" : "未选择"));
    $("#lastRun").textContent = "正在获取 · 刚刚";
    try {
      const payload = await requestRemoteSearch(); const results = Array.isArray(payload?.results) ? payload.results : []; const remoteListings = []; const problems = [];
      selected.forEach(platform => {
        const result = results.find(item => item.source === platform);
        if (!result) { setPlatformState(platform, "error", "服务端没有返回该平台状态"); problems.push(`${platform}没有返回状态`); return; }
        const incoming = Array.isArray(result.listings) ? result.listings : []; const searchUrl = result.searchUrl || result.search_url || "";
        const known = ["ok", "ready", "partial", "limited", "empty", "needs_login", "blocked", "error", "unavailable"];
        const status = result.status === "ready" && incoming.length ? "ok" : known.includes(result.status) ? result.status : "error";
        const message = result.message || (status === "empty" ? "没有符合条件的房源" : status === "ok" ? `返回 ${incoming.length} 条房源` : "平台尚未完成获取");
        remoteListings.push(...incoming.map((item, index) => normalizeRemoteListing(item, platform, index, queryCity)));
        const label = status === "ok" ? `已获取 ${incoming.length} 条` : status === "partial" ? `部分获取 ${incoming.length} 条` : "";
        setPlatformState(platform, status, message, label, searchUrl);
        if (!["ok", "empty"].includes(status)) problems.push(`${platform}：${message}`);
      });
      if (remoteListings.length) { mergeListings(remoteListings); persist(); }
      state.searchStatus = problems.length ? "error" : remoteListings.length ? "ok" : "empty";
      render(); $("#lastRun").textContent = `${problems.length ? "部分平台未完成" : "已完成"} · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
      showToast(problems.length ? `${remoteListings.length ? `已收到 ${remoteListings.length} 条房源。` : ""}${problems.join("；")}` : remoteListings.length ? `已获取 ${remoteListings.length} 条房源` : "本次搜索没有找到匹配房源");
    } catch (error) {
      selected.forEach(platform => setPlatformState(platform, "error", error.message || "本地连接层不可用"));
      state.searchStatus = "error"; render(); $("#lastRun").textContent = "获取失败"; showToast(`获取失败：${error.message}`);
    } finally {
      state.searching = false; button.disabled = false; button.innerHTML = `${icon("search")} 开始自动获取`; updateIcons();
      if (state.filters.commute && cityParts(state.filters.city).city && validateFilters(false)) await calculateCommute();
    }
  }

  async function locateUser() {
    const buttons = [$("#locateCityBtn"), $("#locateCommuteBtn")].filter(Boolean);
    buttons.forEach(btn => {
      btn.disabled = true;
      btn.innerHTML = `${icon("loader-circle")} 正在定位…`;
    });
    updateIcons();

    function getBrowserCoords() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error("浏览器不支持定位功能"));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 60000,
        });
      });
    }

    try {
      let location = null;
      let geoError = null;
      try {
        const position = await getBrowserCoords();
        const payload = await fetchJson("/api/location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          })
        });
        location = payload?.location;
      } catch (err) {
        geoError = err;
      }

      if (!location) {
        try {
          const payload = await fetchJson("/api/location", { method: "GET" });
          location = payload?.location;
        } catch (_) {
          throw geoError || new Error("网络定位服务不可用");
        }
      }

      if (!location || !location.cityFormatted) {
        throw new Error("未能识别出当前城市，请手动输入");
      }

      $("#cityInput").value = location.cityFormatted;
      updateSubwayOptions(location.cityFormatted);
      if (location.address || location.formatted) {
        $("#commuteInput").value = location.address || location.formatted;
      }
      if (!$("#commuteMaxKm").value) {
        $("#commuteMaxKm").value = "5";
      }

      if (location.latitude && location.longitude) {
        state.commuteCoordinates = {
          latitude: location.latitude,
          longitude: location.longitude,
        };
      }

      readFilters();
      if (validateFilters(false)) {
        persist();
        render();
        const addrDesc = location.address ? ` ${location.address}` : "";
        showToast(`已成功定位：${location.cityFormatted}${addrDesc}，已设置 5km 距离范围`);
        if (state.listings.length > 0) {
          void calculateCommute(true);
        }
      }
    } catch (error) {
      showToast(`定位获取失败：${error.message || "请检查浏览器权限或手动输入地点"}`);
    } finally {
      buttons.forEach(btn => {
        btn.disabled = false;
        btn.innerHTML = `${icon("locate-fixed")} 定位当前地点`;
      });
      updateIcons();
    }
  }

  async function openXhsLogin() {
    readFilters();
    if (!validateFilters(true)) { showToast("请先填写城市"); return; }
    const button = $("[data-action=\"xhs-login\"]"); if (button) { button.disabled = true; button.textContent = "正在打开…"; }
    try {
      const payload = await fetchJson("/api/browser/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "小红书", city: state.filters.city, layout: state.filters.layout }) });
      const result = payload.result;
      if (!result) throw new Error("服务端未返回浏览器状态");
      const status = ["ok", "ready", "needs_login", "blocked", "error", "unavailable"].includes(result.status) ? result.status : "error";
      const visible = result.visible === true;
      const opened = visible && ["ok", "ready", "needs_login"].includes(status);
      const message = result.message || (opened ? "本地浏览器已打开，请完成登录后重新获取" : "浏览器没有打开，请检查连接层状态");
      const displayStatus = !visible && ["ok", "ready"].includes(status) ? "unavailable" : opened && status !== "needs_login" ? "ready" : status;
      setPlatformState("小红书", displayStatus, message, opened ? (status === "needs_login" ? "需登录" : "浏览器已打开") : "", result.searchUrl || "");
      showToast(message);
    } catch (error) { setPlatformState("小红书", "error", error.message); showToast(`打开失败：${error.message}`); }
    finally { if (button) { button.disabled = false; button.innerHTML = `${icon("log-in")} 打开小红书`; updateIcons(); } }
  }

  function exportCsv() {
    const rows = getFilteredListings(); if (!rows.length) return;
    const header = ["来源", "标题", "城市", "位置", "地铁线路", "月租", "户型", "面积㎡", "通勤地点", "直线距离（公里）", "链接"];
    const csvRows = [header, ...rows.map(item => [item.source, item.title, item.city, item.location, item.subway || "", formatRent(item), item.layout, item.area ?? "", state.filters.commute, distanceValue(item) ?? "", item.link || ""] )];
    const cell = value => { const text = String(value ?? ""); const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text; return `"${safe.replace(/"/g, '""')}"`; };
    const csv = String.fromCharCode(0xfeff) + csvRows.map(row => row.map(cell).join(",")).join(String.fromCharCode(13, 10));
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `租住雷达-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showToast(message) { const toast = $("#toast"); toast.textContent = message; toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 3400); }

  async function checkConnector() {
    try {
      await fetchJson("/api/health", { headers: { Accept: "application/json" } }); state.connectorOnline = true;
      $(".adapter-label").textContent = "本地服务已连接";
      if (!state.searching && state.searchStatus === "idle") {
        SOURCES.forEach(source => {
          if (source === "小红书") setPlatformState(source, "needs_login", "在本地浏览器登录后获取搜索结果");
          else setPlatformState(source, "ready", "公开房源搜索就绪");
        });
      }
    } catch (error) {
      state.connectorOnline = false; $(".adapter-label").textContent = "本地服务未连接";
      if (!state.searching && state.searchStatus === "idle") SOURCES.forEach(source => setPlatformState(source, "unavailable", error.message));
    }
  }

  function bindEvents() {
    $$('[data-preset]').forEach(button => button.addEventListener("click", () => {
      const preset = button.dataset.preset;
      let targetSources = [];
      if (preset === "all") targetSources = [...SOURCES];
      else if (preset === "mainstream") targetSources = ["链家", "贝壳", "安居客", "58同城", "房天下"];
      else if (preset === "quality") targetSources = ["自如", "Wellcee"];
      else if (preset === "direct") targetSources = ["小红书", "豆瓣租房", "闲鱼"];
      else if (preset === "none") targetSources = [];
      $$('input[type="checkbox"]', $(".source-checks")).forEach(input => {
        input.checked = targetSources.includes(input.value);
      });
      readFilters();
      render();
    }));
    $("#filtersForm").addEventListener("submit", event => {
      event.preventDefault(); readFilters(); if (!validateFilters(false)) { showToast("请先修正筛选条件"); return; }
      state.favoriteOnly = false; render(); showToast("筛选条件已应用");
      if (numberOrNull(state.filters.commuteMaxKm) !== null || state.filters.commute) void calculateCommute();
    });
    $("#resetFilters").addEventListener("click", () => {
      cancelCommute(); state.commuteError = ""; state.commuteTarget = null; state.commuteCoordinates = null;
      state.filters = { city: "", subway: "", rentMin: "", rentMax: "", layout: "", area: "", areaMin: "", areaMax: "", commute: "", commuteMaxKm: "", pages: "1", sources: [...SOURCES] }; state.favoriteOnly = false; applyFiltersToForm(); validateFilters(false); persist(); render(); showToast("筛选条件已重置");
    });
    const applyQuietly = () => {
      readFilters();
      if (validateFilters(false)) {
        render();
        if (numberOrNull(state.filters.commuteMaxKm) !== null || state.filters.commute) void calculateCommute();
      }
    };
    $$('[data-city]').forEach(button => button.addEventListener("click", () => {
      $("#cityInput").value = button.dataset.city;
      updateSubwayOptions(button.dataset.city);
      applyQuietly();
    }));
    $$('[data-rent]').forEach(button => button.addEventListener("click", () => { const [min, max] = button.dataset.rent.split(","); $("#rentMin").value = min === "0" ? "" : min; $("#rentMax").value = max === "20000" ? "" : max; applyQuietly(); }));
    $$("input, select", $("#filtersForm")).forEach(control => control.addEventListener("change", applyQuietly));
    $("#cityInput").addEventListener("input", () => {
      updateSubwayOptions($("#cityInput").value);
      readFilters();
      render();
    });
    $("#commuteInput").addEventListener("input", () => { readFilters(); render(); });
    $("#subwaySelect")?.addEventListener("change", applyQuietly);
    $("#clearSubway")?.addEventListener("click", () => {
      if ($("#subwaySelect")) $("#subwaySelect").value = "";
      applyQuietly();
    });
    $("#subwayQuickTags")?.addEventListener("click", event => {
      const btn = event.target.closest("[data-subway]");
      if (!btn) return;
      if ($("#subwaySelect")) {
        $("#subwaySelect").value = btn.dataset.subway;
        applyQuietly();
      }
    });
    $$('[data-distance]').forEach(button => button.addEventListener("click", () => { $("#commuteMaxKm").value = button.dataset.distance; applyQuietly(); }));
    $("#clearCommuteRange").addEventListener("click", () => { $("#commuteMaxKm").value = ""; applyQuietly(); });
    $("#calculateCommuteBtn").addEventListener("click", () => { readFilters(); if (validateFilters(false)) void calculateCommute(true); });
    $("#locateCityBtn")?.addEventListener("click", locateUser);
    $("#locateCommuteBtn")?.addEventListener("click", locateUser);
    $("#runSearchBtn").addEventListener("click", runSearchTask);
    $("#sortSelect").addEventListener("change", event => { state.sort = event.target.value; render(); });
    $$('[data-view]').forEach(button => button.addEventListener("click", () => { state.view = button.dataset.view; $$('[data-view]').forEach(item => item.classList.toggle("active", item === button)); render(); }));
    $("#showFavorites").addEventListener("click", () => {
      state.favoriteOnly = !state.favoriteOnly; render();
      if (numberOrNull(state.filters.commuteMaxKm) !== null || state.filters.commute) void calculateCommute();
    });
    $("#exportCsvBtn").addEventListener("click", exportCsv);
    $("#resultsList").addEventListener("click", event => { const action = event.target.closest("[data-action]"); if (!action) return; const card = event.target.closest("[data-id]"); const item = state.listings.find(listing => listing.id === card?.dataset.id); if (!item) return; if (action.dataset.action === "favorite") { item.favorite = !item.favorite; persist(); render(); showToast(item.favorite ? "已收藏房源" : "已取消收藏"); } if (action.dataset.action === "remove") { state.listings = state.listings.filter(listing => listing.id !== item.id); persist(); render(); showToast("房源已移除"); } });
    $("#resultsList").addEventListener("error", event => { if (event.target.tagName === "IMG") event.target.closest(".listing-photo").hidden = true; }, true);
    $$('[data-search-platform]').forEach(link => link.addEventListener("click", event => { const platform = link.dataset.searchPlatform; const href = state.platformLinks[platform] || platformUrl(platform, `${state.filters.city} ${state.filters.layout} 租房`); link.href = href; if (href === "#") event.preventDefault(); }));
    $("[data-action=\"xhs-login\"]").addEventListener("click", openXhsLogin);
  }

  applyFiltersToForm(); bindEvents(); render(); checkConnector();
})();
