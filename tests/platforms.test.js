'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../platform-search');
const { createContext, handleSearch } = require('../server');

test('search URLs generate correct paths and query params for all 10 platforms', () => {
  const query = search.normalizeQuery({
    city: '北京 · 朝阳区',
    rentMin: 4000,
    rentMax: 6000,
    layout: '两室一厅',
    keyword: '望京',
    pages: 2,
    sources: ['链家', '贝壳', '安居客', '58同城', '自如', 'Wellcee', '小红书', '豆瓣租房', '闲鱼', '房天下'],
  });

  const lianjiaUrl = search.makePlatformSearchUrl('链家', query, 2);
  assert.match(lianjiaUrl, /bj\.lianjia\.com\/zufang\/pg2/);
  assert.match(lianjiaUrl, /brp4000erp6000/);

  const beikeUrl = search.makePlatformSearchUrl('贝壳', query, 2);
  assert.match(beikeUrl, /bj\.zu\.ke\.com\/zufang\/pg2/);

  const anjukeUrl = search.makePlatformSearchUrl('安居客', query, 2);
  assert.match(anjukeUrl, /bj\.zu\.anjuke\.com\/fangyuan\/fx2\/p2/);
  assert.match(anjukeUrl, /minprice=4000/);
  assert.match(anjukeUrl, /maxprice=6000/);

  const wellceeUrl = search.makePlatformSearchUrl('Wellcee', query, 2);
  assert.match(wellceeUrl, /wellcee\.com\/rent-house\/beijing/);
  assert.match(wellceeUrl, /min_price=4000/);
  assert.match(wellceeUrl, /max_price=6000/);
  assert.match(wellceeUrl, /page=2/);

  const ziroomUrl = search.makePlatformSearchUrl('自如', query, 2);
  assert.match(ziroomUrl, /bj\.ziroom\.com\/z\/r4000-6000\/p2/);

  const wubaiUrl = search.makePlatformSearchUrl('58同城', query, 2);
  assert.match(wubaiUrl, /bj\.58\.com\/chuzu\/pn2/);
  assert.match(wubaiUrl, /minprice=4000/);

  const doubanUrl = search.makePlatformSearchUrl('豆瓣租房', query, 2);
  assert.match(doubanUrl, /douban\.com\/group\/search/);
  assert.match(doubanUrl, /start=20/);

  const xianyuUrl = search.makePlatformSearchUrl('闲鱼', query, 2);
  assert.match(xianyuUrl, /goofish\.com\/search/);
  assert.match(xianyuUrl, /page=2/);

  const fangUrl = search.makePlatformSearchUrl('房天下', query, 2);
  assert.match(fangUrl, /zu\.fang\.com\/px2/);

  const xhsUrl = search.makePlatformSearchUrl('小红书', query, 2);
  assert.match(xhsUrl, /xiaohongshu\.com\/search_result/);
});

test('Anjuke parser correctly parses listing cards', () => {
  const anjukeHtml = `
    <div class="zu-itemmod" data-houseid="AJK998877">
      <a class="img" href="https://bj.zu.anjuke.com/fangyuan/998877.html">
        <img class="thumbnail" src="https://example.com/ajk.jpg" />
      </a>
      <div class="zu-info">
        <h3><a class="strong" href="https://bj.zu.anjuke.com/fangyuan/998877.html">朝阳望京SOHO精装两居</a></h3>
        <p class="details-item">2室1厅1卫 | 75平米 | 高楼层</p>
        <address class="details-item">朝阳 - 望京 - 望京西园</address>
      </div>
      <div class="zu-side">
        <p><strong class="num">5600</strong> 元/月</p>
      </div>
    </div>
  `;
  const items = search.parsePlatformHtml(anjukeHtml, '安居客', '北京', 'https://bj.zu.anjuke.com/fangyuan/');
  assert.equal(items.length, 1);
  assert.equal(items[0].source, '安居客');
  assert.equal(items[0].rent, 5600);
  assert.equal(items[0].area, 75);
  assert.equal(items[0].layout, '2室1厅1卫');
  assert.match(items[0].address, /望京西园/);
  assert.equal(items[0].id, '安居客:北京:AJK998877');
});

test('Wellcee parser correctly parses lifestyle and expat listings', () => {
  const wellceeHtml = `
    <div class="house-item" data-id="wellcee-8899">
      <a class="item-link" href="https://www.wellcee.com/rent-house/detail/8899">
        <img class="cover-img" src="https://example.com/wellcee.jpg" />
        <h3 class="title">Sanlitun Cozy 1BR Apartment (Pet Friendly)</h3>
      </a>
      <div class="location">Chaoyang · Sanlitun</div>
      <div class="price">¥ 6,800/月</div>
      <div class="type">整租 · 1室1厅 · 55㎡</div>
    </div>
  `;
  const items = search.parsePlatformHtml(wellceeHtml, 'Wellcee', '北京', 'https://www.wellcee.com/rent-house/beijing');
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'Wellcee');
  assert.equal(items[0].rent, 6800);
  assert.equal(items[0].area, 55);
  assert.equal(items[0].layout, '1室1厅');
  assert.match(items[0].title, /Sanlitun/);
  assert.equal(items[0].id, 'Wellcee:北京:8899');
});

test('Ziroom parser correctly extracts furnished apartment details', () => {
  const ziroomHtml = `
    <div class="item" data-id="ZR123456">
      <h5 class="title"><a href="/z/vr/123456.html">自如友家·双井天之骄子3居室-南卧</a></h5>
      <div class="desc">
        <div>18㎡</div>
        <div>3室1厅</div>
        <div>南 / 8/18层</div>
      </div>
      <div class="location">朝阳区 · 双井</div>
      <div class="price"><span>3290</span> 元/月</div>
    </div>
  `;
  const items = search.parsePlatformHtml(ziroomHtml, '自如', '北京', 'https://bj.ziroom.com/z/');
  assert.equal(items.length, 1);
  assert.equal(items[0].source, '自如');
  assert.equal(items[0].rent, 3290);
  assert.equal(items[0].area, 18);
  assert.equal(items[0].layout, '3室1厅');
  assert.equal(items[0].rentType, '合租');
  assert.equal(items[0].id, '自如:北京:123456');
});

test('58同城 and Douban parsers extract rental posts correctly', () => {
  const doubanHtml = `
    <table class="olt">
      <tr class="th"><th>标题</th><th>作者</th></tr>
      <tr>
        <td class="title"><a href="https://www.douban.com/group/topic/123456789/">【朝阳大悦城】个人转租两居室 4500包暖气 无中介费</a></td>
        <td class="nowrap"><a href="/people/user1/">租客小张</a></td>
      </tr>
    </table>
  `;
  const doubanItems = search.parsePlatformHtml(doubanHtml, '豆瓣租房', '北京', 'https://www.douban.com');
  assert.equal(doubanItems.length, 1);
  assert.equal(doubanItems[0].source, '豆瓣租房');
  assert.equal(doubanItems[0].rent, 4500);
  assert.equal(doubanItems[0].layout, '两居');
  assert.match(doubanItems[0].title, /朝阳大悦城/);
  assert.equal(doubanItems[0].id, '豆瓣租房:北京:123456789');

  const wubaiHtml = `
    <ul class="listUl">
      <li data-id="WB776655">
        <div class="des">
          <h2><a href="https://bj.58.com/chuzu/776655x.shtml">房东直租 劲松一居室 家电齐全</a></h2>
          <p class="room">1室1厅1卫 48平米</p>
          <p class="add">朝阳 - 劲松</p>
        </div>
        <div class="money"><b>3800</b>元/月</div>
      </li>
    </ul>
  `;
  const wubaiItems = search.parsePlatformHtml(wubaiHtml, '58同城', '北京', 'https://bj.58.com');
  assert.equal(wubaiItems.length, 1);
  assert.equal(wubaiItems[0].source, '58同城');
  assert.equal(wubaiItems[0].rent, 3800);
  assert.equal(wubaiItems[0].area, 48);
  assert.equal(wubaiItems[0].layout, '1室1厅1卫');
});

test('handleSearch aggregates multiple new platforms concurrently', async () => {
  const context = createContext({
    minPlatformIntervalMs: 0,
    fetchText: async (url, options) => {
      if (options.source === 'Wellcee') {
        return '<div class="house-item"><a href="/detail/W1">Sanlitun Studio</a><span class="price">¥5000</span><div class="location">朝阳区</div></div>';
      }
      if (options.source === '安居客') {
        return '<div class="zu-itemmod"><a class="strong" href="/fangyuan/A1.html">望京阳光两居</a><strong class="num">6200</strong><address>望京</address></div>';
      }
      return '<html><body>未匹配</body></html>';
    },
  });

  const res = await handleSearch({
    city: '北京',
    sources: ['Wellcee', '安居客'],
  }, context);

  assert.equal(res.ok, true);
  assert.equal(res.results.length, 2);
  const wellceeResult = res.results.find(r => r.source === 'Wellcee');
  const ajkResult = res.results.find(r => r.source === '安居客');
  assert.equal(wellceeResult.status, 'ok');
  assert.equal(wellceeResult.listings[0].rent, 5000);
  assert.equal(ajkResult.status, 'ok');
  assert.equal(ajkResult.listings[0].rent, 6200);
  assert.equal(res.listings.length, 2);
});
