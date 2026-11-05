// page.test.mjs — functional smoke test for the inline script inside src/page.js.
//
// The page is one self-contained document, so there is no module to import. Instead we extract its
// <script> and run it inside node:vm with a minimal DOM stub + stubbed same-origin fetch, then
// assert what actually lands in the room list: ordering, action buttons, escaping, hostile-URL
// fallback and the offline state. This is the cheapest gate that would catch a broken renderer.
//
// 大厅数据来源 (v1.1): the page merges four sources — the local board (/api/rooms) plus the three
// community stations relayed by /api/community?src=rainya|lunar|rinko. The harness routes fetches
// per URL, so a test can make any single source fail or carry rooms and assert what the page does.
//
// 提交房间 (v0.2) is covered the same way: the page exposes its pure helpers + the board actions on
// `window.__SP_PAGE`, so the tests drive real requests through the stubbed fetch and then assert on
// the re-rendered room row (badges / 改备注 / 销毁) and on the localStorage token store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PAGE_HTML } from './src/page.js';
import { BLOCKED_TEXT_HINT } from './src/names.js';

function makeEl(id) {
  return {
    id: id,
    textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, className: '',
    style: {}, _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    setAttribute() {}, getAttribute() { return null; },
    querySelectorAll: () => [], querySelector: () => null,
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: () => Promise.resolve(body),
  };
}

/** vm-realm objects have their own Object.prototype — normalise before deepStrictEqual. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Run the page script against fixed source payloads.
 * @param {object} payload      GET /api/rooms body
 * @param {object} [opts]
 * @param {boolean} [opts.failFetch]  make every fetch reject
 * @param {(url:string, options:object) => object} [opts.fetch]  custom responder (records calls)
 * @param {Record<string, object[]>} [opts.community]  rows per relayed community source
 * @param {object} [opts.seed]  initial localStorage contents
 * @param {boolean} [opts.hidden]  start with document.hidden = true (background tab)
 * @returns {Promise<{list:object, els:object, api:object, calls:object[], store:Map<string,string>, doc:object}>}
 */
async function runPage(payload, { failFetch = false, fetch: fetchImpl = null, community = {}, seed = {}, hidden = false } = {}) {
  const script = PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const el = (id) => (els[id] = els[id] || makeEl(id));
  const store = new Map(Object.entries(seed));
  const calls = [];
  const fetchStub = (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    if (fetchImpl) return Promise.resolve(fetchImpl(String(url), options || {}));
    if (failFetch) return Promise.reject(new Error('offline'));
    const relay = String(url).match(/^\/api\/community\?src=([a-z,]+)$/);
    if (relay) {
      // 合并形态（v6）：把每个源的 mock 行拼起来并逐行打 src；值写成 'error' 表示该源上游失败。
      const keys = relay[1].split(',');
      const rooms = [];
      const errors = {};
      for (const key of keys) {
        if (community[key] === 'error') { errors[key] = 'UPSTREAM'; continue; }
        for (const row of community[key] || []) rooms.push(Object.assign({}, row, { src: key }));
      }
      if (Object.keys(errors).length === keys.length) {
        return Promise.resolve(jsonRes({ ok: false, error: 'UPSTREAM' }, 502));
      }
      const body = { ok: true, src: relay[1], fetchedAt: 0, rooms };
      if (Object.keys(errors).length) body.errors = errors;
      return Promise.resolve(jsonRes(body));
    }
    return Promise.resolve(jsonRes(payload));
  };
  const ctx = {
    document: {
      getElementById: (id) => el(id),
      addEventListener: () => {},
      hidden: hidden,
    },
    window: { open: () => { throw new Error('window.open must only fire on a real click'); } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    setInterval: () => 0,
    fetch: fetchStub,
    URL, Date, Math, Number, String, Array, Object, JSON, RegExp, Error, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the fetch microtask chain settle
  return { list: el('list'), els, api: ctx.window.__SP_PAGE, calls, store, doc: ctx.document };
}

// 行数据与线上同形：board 不外泄 createdAt，只给 ageSec（这里故意混用两种形态，覆盖两条时间路径）。
const NOW = 1_751_000_500_000;
const ROOM_OPEN = {
  code: 'AAAA', serverId: 's1', serverName: 'raiya服', occupied: 2, capacity: 4,
  difficulty: 'ABYSS', note: '来玩', status: 'waiting', createdAt: 1_751_000_000_000, ageSec: 500,
  url: 'https://game.example.com/play',
};
const ROOM_LIVE = {
  code: 'BBBB', serverId: 's2', serverName: 'Lunar', occupied: 4, capacity: 4,
  inMatch: true, status: 'playing', ageSec: 400,
  url: 'https://stronghold.lunar.ag/',
};
const ROOM_FULL = {
  code: 'CCCC', serverId: 's3', serverName: '梨子湖', occupied: 4, capacity: 4,
  status: 'full', ageSec: 400, url: 'https://xn--rlr.rinko.ai/',
};
const ROOM_HOSTILE = {
  code: 'DDDD', serverId: 's4', serverName: 'evil', occupied: 1, capacity: 4, ageSec: 10,
  note: '<img src=x onerror=alert(1)>',
  url: 'http://127.0.0.1:3000/steal',
};
const ROOM_NOSEAT = {
  code: 'EEEE', serverId: 's5', serverName: '老条目服', ageSec: 300, url: 'https://game.example.com/',
};

// 社区源行（中转归一后的形状）：rainya 是门户原样行，lunar/rinko 带 live + 人数。
const COMMUNITY_RAINYA = {
  code: 'KKKK', server: 'raiya', note: '门户房间', ageSec: 20, leftSec: 580, url: 'https://game.rainya.me/?room=KKKK',
};
const COMMUNITY_LUNAR = {
  code: 'LLLL', server: 'Lunar', serverName: 'Lunar', serverId: 'lunar', occupied: 3, capacity: 4,
  url: 'https://stronghold.lunar.ag/?room=LLLL', leftSec: 600, live: true, status: 'waiting', note: '房主：阿米娅',
};

test('page: 审核被拒的中文提示与策略模块一致（防漂移）', async () => {
  const { api } = await runPage({ ok: true, now: NOW, rooms: [] });
  assert.equal(api.errorText('BLOCKED_TEXT'), BLOCKED_TEXT_HINT);
  assert.match(PAGE_HTML, /内容含违规词/, '页面内联脚本里也要有这条文案（单文件页不能 import 模块）');
});

test('page: renders joinable first, 观战 for in-match, disabled 满员, escaped notes', async () => {
  const { list, els } = await runPage({ ok: true, now: NOW, ttlSec: 600, visitors: 7, rooms: [ROOM_FULL, ROOM_LIVE, ROOM_OPEN, ROOM_HOSTILE, ROOM_NOSEAT] });

  const html = list.innerHTML;
  // Ordering: joinable rooms first, newest (smallest ageSec) first, then playing, then full.
  assert.ok(html.indexOf('DDDD') < html.indexOf('AAAA'), 'freshest open room leads');
  assert.ok(html.indexOf('AAAA') < html.indexOf('BBBB'), 'open rooms sort before the in-match room');
  assert.ok(html.indexOf('BBBB') < html.indexOf('CCCC'), 'in-match sorts before full');

  // Freshness labels: ageSec drives them (createdAt never leaves the board).
  assert.match(html, /刚刚/);      // DDDD, ageSec 10
  assert.match(html, /5 分钟前/);   // EEEE, ageSec 300

  // Actions: 加入 for open rooms, 观战 for the in-match room, disabled 满员 for the full one.
  // v8：加入目标 = 上报时提交的原链接本身，逐字节（路径 / 额外参数都不动），不再拼 ?room=
  assert.match(html, /class="btn btn--primary btn--sm" data-href="https:\/\/game\.example\.com\/play"/);
  // 观战 = 原链接 + spectate=1（客户端深链约定）；已有的 spectate 不会被清掉以外的参数影响
  assert.match(html, /class="btn btn--amber btn--sm" data-href="https:\/\/stronghold\.lunar\.ag\/\?spectate=1"/);
  assert.match(html, /class="btn btn--sm" disabled><span class="btn__label">满员<\/span><\/button>/);

  // Server names are shown verbatim (never hidden); difficulty uses the panel's label table.
  assert.match(html, /raiya服/);
  assert.match(html, />终极</);

  // Notes are escaped: hostile markup must arrive inert.
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes('<img'), 'no raw <img> from a note');

  // Seat row only appears when capacity was reported — never a misleading "0/0 人".
  assert.ok(!html.includes('0/0 人'), 'capacity-less room must not render a 0/0 seat row');
  assert.match(html, /2\/4/, 'reported seats still render');

  // v8：不合格的链接（这里是 http + 环回）不再回落到别的服务器 —— 该行给禁用按钮 + 说明。
  assert.ok(!html.includes('127.0.0.1'), 'loopback URL must not survive anywhere in the row');
  assert.ok(!html.includes('weishu.jiangjiangze.icu'), 'v8 has no DEFAULT_CLIENT fallback at all');
  assert.match(html, /<button class="btn btn--sm" disabled title="该房间上报时没有给可加入的 https 链接"><span class="btn__label">无链接<\/span><\/button>/,
    'a URL-less / hostile-URL row renders a disabled 无链接 button, never a jump elsewhere');

  // Every row carries its data source tag（本站房间牌）— the board rows are all `board` here.
  assert.match(html, /title="房间来源：本站房间牌（玩家上报）">本站</);

  assert.match(els.status.textContent, /5 个房间/);
  assert.match(els.visitors.textContent, /大厅访客 7 人/);

  // A room without a local token renders no 我的 affordances.
  assert.ok(!html.includes('data-act="destroy"'), 'no destroy button without an owned token');
});

test('page: 数据来源 — 社区源聚合、逐行来源标签、页脚标注', async () => {
  const { list, els, calls } = await runPage(
    { ok: true, now: NOW, ttlSec: 600, visitors: 2, rooms: [ROOM_OPEN] },
    { community: { rainya: [COMMUNITY_RAINYA], lunar: [COMMUNITY_LUNAR] } },
  );

  const html = list.innerHTML;
  // 社区行进入同一张牌面，并各自带「来源网站」标签（标签正文 = 域名，点开即对应站点）。
  assert.match(html, /KKKK/);
  assert.match(html, /LLLL/);
  assert.match(html, /class="tag tag--src" href="https:\/\/game\.rainya\.me\/"[^>]*title="房间来源：raiya服（game\.rainya\.me）">game\.rainya\.me<\/a>/);
  assert.match(html, /class="tag tag--src" href="https:\/\/stronghold\.lunar\.ag\/"[^>]*title="房间来源：Lunar（stronghold\.lunar\.ag）">stronghold\.lunar\.ag<\/a>/);
  // 本站行也标「本站」。
  assert.match(html, /title="房间来源：本站房间牌（玩家上报）">本站</);
  // live 行没有时间戳 → 「在线」而不是空的「分钟前」。
  assert.match(html, /在线/);
  assert.match(els.status.textContent, /已连接 · 3 个房间/);

  // v6：社区源**合并成一条**请求 —— 一间房牌 + 一次合并中转（36 → 12 请求/小时）。
  // v7.2：只剩两个源（梨子湖已去掉）—— 中转仍是 1 次请求，但上游往返从 3 次降到 2 次。
  const urls = calls.map((c) => c.url);
  assert.ok(urls.includes('/api/rooms'), 'board polled');
  assert.ok(urls.includes('/api/community?src=rainya,lunar'), 'one combined relay call, two sources');
  assert.equal(urls.filter((u) => u.startsWith('/api/community')).length, 1, 'exactly one relay call');
});

test('page: 合并响应里归属不明的行会被丢弃（不会挂到错误的来源上）', async () => {
  const { list } = await runPage(
    { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [] },
    {
      fetch: (url, options) => {
        if (String(url).startsWith('/api/community')) {
          return jsonRes({ ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [
            { code: 'KKKK', server: 'raiya', ageSec: 5, url: 'https://game.rainya.me/?room=KKKK' },          // 无 src → 丢
            { code: 'LMNP', server: 'Lunar', serverId: 'lunar', live: true, url: 'https://stronghold.lunar.ag/?room=LMNP', src: 'lunar' },
          ] });
        }
        return jsonRes({ ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [] });
      },
    },
  );
  const html = list.innerHTML;
  assert.ok(!html.includes('KKKK'), 'a row without src is dropped (never guessed)');
  assert.match(html, /LMNP/);
  assert.match(html, /title="房间来源：Lunar（stronghold\.lunar\.ag）">stronghold\.lunar\.ag</, "存活的行仍带正确的来源标签");
});

test('page: 数据来源 — 单源不可达只在来源标注里点名，不挡住别的源', async () => {
  const { list, els } = await runPage(
    { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [ROOM_OPEN] },
    {
      fetch: (url, options) => {
        // 合并调用里只有 raiya 上游失败 → 200 + errors，页面只把 raiya服 标灰。
        if (String(url).startsWith('/api/community')) {
          return jsonRes({ ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [], errors: { rainya: 'UPSTREAM' } });
        }
        return jsonRes({ ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [ROOM_OPEN] });
      },
    },
  );

  assert.match(list.innerHTML, /AAAA/, 'board rooms still render when one relay is down');
  assert.match(els['src-state'].textContent, /raiya服 暂不可达/);
  assert.equal(els['src-state'].className, 'src-err');
  assert.match(els.status.textContent, /部分来源不可达 · 1 个房间/);
});

test('page: 数据来源 — 静态标注写全每个来源（含网站域名），梨子湖已下线', () => {
  // 页脚「数据来源」标注：本站房间牌 + 两个社区站，站点写明白域名，链接为 https 常量。
  assert.match(PAGE_HTML, /数据来源/);
  assert.match(PAGE_HTML, /本站房间牌（玩家上报）/);
  assert.match(PAGE_HTML, /raiya服（game\.rainya\.me）/);
  assert.match(PAGE_HTML, /Lunar（stronghold\.lunar\.ag）/);
  // v7.2：梨子湖（卫.rinko.ai）整源去掉 —— 页面里不该再有任何它的痕迹（标注、链接、标签、注释）。
  assert.ok(!/rinko/i.test(PAGE_HTML), 'no rinko source left in the page');
  assert.ok(!/梨子湖/.test(PAGE_HTML), 'no 梨子湖 label left in the page');
});

test('page: 合并规则 — 同房号不同主机各留一条，同主机同房号本站优先', async () => {
  const { api } = await runPage({ ok: true, now: NOW, rooms: [] });

  const board = api.shapeRoom({ code: 'kmnp', serverId: 'weishu', serverName: '站长服务', url: 'https://weishu.jiangjiangze.icu/' }, 'board');
  const dupBoard = api.shapeRoom({ code: 'KMNP', serverId: 'weishu', serverName: '站长服务', url: 'https://weishu.jiangjiangze.icu/other' }, 'board');
  const otherHost = api.shapeRoom({ code: 'KMNP', serverId: 'lunar', serverName: 'Lunar', url: 'https://stronghold.lunar.ag/', live: true }, 'lunar');
  const badCode = api.shapeRoom({ code: 'IOIO', serverId: 'x', serverName: 'x' }, 'board');
  const hostile = api.shapeRoom({ code: 'ZZZZ', serverId: 'x', serverName: 'x', url: 'http://127.0.0.1/x' }, 'board');

  assert.equal(api.shapeRoom(null, 'board'), null);
  assert.equal(badCode, null, 'I/O are not in the room-code alphabet');
  assert.equal(hostile.url, '', 'loopback url is dropped by the shared deny table');

  const merged = api.mergeRooms({ board: [board, dupBoard], rainya: [], lunar: [otherHost] });
  assert.equal(merged.length, 2, 'same host+code dedupes; another host keeps its own row');
  assert.equal(merged[0].src, 'board', 'board rows lead the merge');
  assert.equal(merged[0].url, 'https://weishu.jiangjiangze.icu/', 'first board row wins the dedupe');
  assert.equal(merged[1].src, 'lunar');
});

test('page: 排序 — 可加入 → 对局中 → 满员；无时间戳的常驻行排在本组末尾', async () => {
  const { api } = await runPage({ ok: true, now: NOW, rooms: [] });
  const fresh = api.shapeRoom({ code: 'AAAA', serverId: 's1', serverName: '本站服务', ageSec: 40 }, 'board');
  const stale = api.shapeRoom({ code: 'BBBB', serverId: 's2', serverName: '本站服务', ageSec: 400 }, 'board');
  const station = api.shapeRoom({ code: 'CCCC', serverId: 'lunar', serverName: 'Lunar', url: 'https://stronghold.lunar.ag/', live: true }, 'lunar');
  const playing = api.shapeRoom({ code: 'DDDD', serverId: 's3', serverName: '本站服务', status: 'playing', ageSec: 10 }, 'board');
  const full = api.shapeRoom({ code: 'EEEE', serverId: 's4', serverName: '本站服务', occupied: 4, capacity: 4, ageSec: 10 }, 'board');

  const sorted = api.sortRooms([full, station, stale, playing, fresh], NOW).map((r) => r.code);
  assert.deepEqual(sorted, ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE']);
});

test('page: 后台标签页不发任何请求，回到前台立刻全量刷新（额度纪律）', async () => {
  const payload = { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [ROOM_OPEN] };
  const { api, calls, doc, els } = await runPage(payload, {
    hidden: true,
    community: { rainya: [COMMUNITY_RAINYA], lunar: [] },
  });
  assert.equal(calls.length, 0, 'hidden tab: no board poll, no relay poll');
  assert.equal(els.status.textContent, '', 'no render happened — the page stays on its static loading state');
  assert.match(PAGE_HTML, /正在拉取房间牌/, 'the static loading state is what a hidden tab keeps showing');

  doc.hidden = false;
  await api.load();
  const polls = calls.filter((c) => c.url.indexOf('/api/') >= 0);
  assert.equal(polls.length, 2, 'one full refresh = board + one combined relay');
  assert.match(els.list.innerHTML, /AAAA/);
  assert.match(els.list.innerHTML, /KKKK/, "community rows come along on the refresh");
});

test('page: 全量刷新时房间牌不等社区中转（中转要替上游付往返，不该拖慢本站牌面）', async () => {
  const payload = { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [ROOM_OPEN] };
  let releaseRelay = null;
  const gate = new Promise((resolve) => { releaseRelay = resolve; });
  const { api, els } = await runPage(payload, {
    fetch: (url) => {
      if (String(url).startsWith('/api/community')) {
        return gate.then(() => jsonRes({ ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [{ ...COMMUNITY_RAINYA, src: 'rainya' }] }));
      }
      return jsonRes(payload);
    },
  });

  els.list.innerHTML = '';            // 只看 load() 这一次自己画了什么（boot 的渲染已清掉）
  const pending = api.load();         // 不 await：社区中转还挂在网关上
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(els.list.innerHTML, /AAAA/, 'board rows render as soon as the board answers');
  assert.ok(!/KKKK/.test(els.list.innerHTML), 'the relay has not answered yet');

  releaseRelay();
  await pending;
  assert.match(els.list.innerHTML, /KKKK/, 'relay rows land when they arrive');
});

test('page: 轮询节奏守住额度下限（房间牌 60s、社区源 300s，与 APK 面板同档）', async () => {
  const { api } = await runPage({ ok: true, now: NOW, rooms: [] });
  // 免费额度账：Workers/DO 各 10 万请求/天，而这页每跳要 1 次房间牌 + 3 次社区中转。
  // 60s/300s 下一个**可见**标签页 = 96 请求/小时（后台标签页 0）；再快就是拿额度换几秒钟的新鲜度。
  // 这个用例是「别偷偷调回 20s」的闸门：改档要同时改这里与 README，并说明理由。
  assert.ok(api.pollMs >= 60000, `board poll must stay >= 60s (got ${api.pollMs})`);
  assert.ok(api.communityPollMs >= 300000, `relay poll must stay >= 300s (got ${api.communityPollMs})`);
  // 与客户端面板同一档：extras/public/js/lobby.js 的 BOARD_REFRESH_MS=60000 / COMMUNITY_REFRESH_MS=300000
  assert.equal(api.pollMs, 60000);
  assert.equal(api.communityPollMs, 300000);
});

test('page: 换链接要跟着换服务器（自动填的会清掉，手填的不动）', async () => {
  const payload = { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [
    { code: 'AAAA', serverId: 'xiaolubao', serverName: '小鹿宝', url: 'https://xiaolubao.example.com/', ageSec: 5 },
  ] };
  const { els } = await runPage(payload);
  const fire = (el, ev) => (el._handlers[ev] || []).forEach((fn) => fn({ key: 'x' }));
  const urlEl = els['s-url'];
  const serverEl = els['s-server'];

  // 链接主机命中大厅里的已知服务器 → 自动补它的展示名
  urlEl.value = 'https://xiaolubao.example.com/?room=abcd';
  fire(urlEl, 'input');
  assert.equal(serverEl.value, '小鹿宝');
  assert.equal(els['s-code-echo'].textContent, 'ABCD');

  // 换成一台没见过的服务器 → 自动填的名字要清掉（否则会挂到旧服务器的 id 上）
  urlEl.value = 'https://unknown.example.com/?room=wxyz';
  fire(urlEl, 'input');
  assert.equal(serverEl.value, '', 'auto-filled name must be cleared when the host changes');
  assert.equal(els['s-code-echo'].textContent, 'WXYZ');

  // 用户手填过 → 换链接也不动它
  serverEl.value = '我自己的服';
  fire(serverEl, 'input');
  urlEl.value = 'https://other.example.com/?room=abcd';
  fire(urlEl, 'input');
  assert.equal(serverEl.value, '我自己的服', 'a hand-typed server name is never touched');
});

test('page: empty board and offline state render explicit guidance', async () => {
  const empty = await runPage({ ok: true, now: 0, ttlSec: 600, visitors: 0, rooms: [] });
  assert.match(empty.list.innerHTML, /现在没有公开的房间/);
  assert.match(empty.list.innerHTML, /提交房间/, 'empty state points at the submit entry');

  const down = await runPage(null, { failFetch: true });
  assert.match(down.list.innerHTML, /暂时连不上大厅服务/);
  assert.match(down.els.status.textContent, /连接大厅失败/);
});

test('page: 提交房间面板默认折叠，且新增能力不需要放开 CSP', () => {
  assert.match(PAGE_HTML, /<section class="lobby-submit" id="submit" hidden>/);
  assert.match(PAGE_HTML, /id="open-submit"/);
  // 数据来源仍然是同源（房间牌 + 社区中转都走 /api/*），只额外允许 https: —— 这是为了 C 方案的
  // 服务器级兜底数字：行上缺房间人数时直连那个服的 /healthz 读一次公开聚合数字（只读、按 origin 缓存）。
  assert.match(PAGE_HTML, /connect-src 'self' https:/);
  assert.ok(!/connect-src[^"]*\*/.test(PAGE_HTML), 'no wildcard connect-src');
  assert.match(PAGE_HTML, /font-src data:/);
  assert.ok(!/https?:\/\/[^"']*\.woff2/.test(PAGE_HTML), 'fonts are embedded, not linked');
});

test('page: 房间链接必填 —— 房号从链接读，服务器/难度/备注可选（先给中文提示）', async () => {
  const { api, calls } = await runPage({ ok: true, now: NOW, rooms: [] });
  const before = calls.length;

  // 房号输入归一仍用于「你把房号粘进了链接框」的识别
  assert.equal(api.normalizeCodeInput(' abi1q! '), 'ABQ');

  // 无效输入一律 ok:false（Sourcery 🟡：只匹配 message 时，万一 ok 是 true 测试也会绿）
  const reject = (input, re) => {
    const r = api.buildPayload(input);
    assert.equal(r.ok, false, 'must reject: ' + JSON.stringify(input));
    assert.match(r.message, re);
    return r.message;
  };
  // ① 链接必填
  reject({}, /请粘贴房间链接/);
  reject({ url: '   ' }, /请粘贴房间链接/);
  // ② 必须 https + 公网主机（与「加入」同一张 deny 表）
  reject({ url: 'http://game.example.com/?room=ABCD' }, /https/);
  reject({ url: 'https://127.0.0.1:3000/?room=ABCD' }, /https|公网/);
  reject({ url: 'https://10.0.0.5/?room=ABCD' }, /https|公网/);
  reject({ url: 'https://192.168.1.9/?room=ABCD' }, /https|公网/);
  reject({ url: 'https://[::1]/?room=ABCD' }, /https|公网/);
  reject({ url: 'https://[fd00::1]/?room=ABCD' }, /https|公网/);
  reject({ url: 'https://[fe80::1]/?room=ABCD' }, /https|公网/);
  reject({ url: 'https://[::ffff:127.0.0.1]/?room=ABCD' }, /https|公网/);
  // ③ 链接里必须能读出房号：4 位、不含 I/O —— 不猜、不截断
  reject({ url: 'https://game.example.com/' }, /没有房号/);
  reject({ url: 'https://game.example.com/?room=ABC' }, /没有房号/);
  reject({ url: 'https://game.example.com/?room=IOIO' }, /没有房号/);
  reject({ url: 'https://game.example.com/?room=ABCDE' }, /没有房号/);
  // 把房号本身粘进了链接框 → 明确点名
  reject({ url: 'abcd' }, /这是房号、不是链接/);
  // ④ 过长链接
  reject({ url: 'https://game.example.com/?room=ABCD&x=' + 'y'.repeat(520) }, /过长/);
  // ⑤ 整套静态校验**一次请求都不发**（Sourcery 🟡：断言没盯 calls）
  assert.equal(calls.length, before, 'validation must never touch the network');
  assert.equal(calls.filter((c) => String(c.url).indexOf('/api/') === 0).length, before,
    'no board/relay request from validation');

  // codeFromLink：严格取「?room=」参数（路径 / 其它参数 / fragment 都不影响）
  assert.equal(api.codeFromLink('https://game.example.com/play?room=abcd'), 'ABCD');
  assert.equal(api.codeFromLink('https://game.example.com/?x=1&room=WXYZ#frag'), 'WXYZ');
  assert.equal(api.codeFromLink('https://game.example.com/?room=IOIO'), '');
  assert.equal(api.codeFromLink('https://game.example.com/?room=AB'), '');
  assert.equal(api.codeFromLink('not-a-url'), '');
  assert.equal(api.hostOf('https://Game.Example.com:8443/?room=ABCD'), 'game.example.com:8443');
  assert.equal(api.originOf('https://Game.Example.com:8443/?room=ABCD'), 'https://game.example.com:8443');
  // 全局可路由的 IPv6 照收（与服务端 board.js 同表）；私网/环回仍旧拒
  assert.equal(api.safeHref('https://[2001:470:1f0b::1]/?room=ABCD'), 'https://[2001:470:1f0b::1]/?room=ABCD');
  assert.equal(api.safeHref('https://[::1]/?room=ABCD'), '');
  assert.equal(api.safeHref('https://[fc00::1]/?room=ABCD'), '');

  // ⑤ 正常载荷：链接必填 → payload 必带 url；服务器留空 = 用链接主机名兜底（服务端两个字段都必填）
  const ok = api.buildPayload({ url: 'https://game.example.com/play?room=abcd', note: '  来玩  ', difficulty: 'hard' });
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.payload), {
    code: 'ABCD', serverId: 'game.example.com', serverName: 'game.example.com',
    url: 'https://game.example.com/play?room=abcd', note: '来玩', difficulty: 'HARD',
  });

  // ⑥ 手填服务器名（含 serverId）优先；保留字与超长照旧拦
  assert.deepEqual(plain(api.buildPayload({ url: 'https://x.example.com/?room=ABCD', server: '小鹿宝', serverId: 'weishu' }).payload),
    { code: 'ABCD', serverId: 'weishu', serverName: '小鹿宝', url: 'https://x.example.com/?room=ABCD' });
  // 同名不同端口 = 两台服务器：origin 匹配不能把 :8443 的链接算到默认端口那台头上
  assert.equal(api.knownFrom([
    { serverName: '小鹿宝', serverId: 's1', url: 'https://game.example.com/' },
    { serverName: '小鹿宝', serverId: 's2', url: 'https://game.example.com:8443/' },
  ]).length, 2, 'same name on a different port stays two servers');
  assert.match(api.buildPayload({ url: 'https://x.example.com/?room=ABCD', server: 'local' }).message, /本机服务/);
  assert.match(api.buildPayload({ url: 'https://x.example.com/?room=ABCD', server: 'x'.repeat(65) }).message, /过长/);
  assert.equal(api.buildPayload({ url: 'https://x.example.com/?room=ABCD', note: '字'.repeat(60) }).payload.note.length, 40);

  // ⑦ 错误码 → 中文（服务端文案不进展示层）
  assert.match(api.errorText('DEBOUNCED', 'code ABCD was submitted 3s ago; wait 30s'), /30 秒后再试/);
  assert.match(api.errorText('RATE_LIMITED'), /频繁/);
  assert.match(api.errorText('LIMIT_REACHED'), /上限/);
  assert.match(api.errorText('BAD_URL'), /https/);
  assert.equal(api.errorText(undefined, 'boom', 500), 'boom');
  assert.match(api.errorText(undefined, '', 502), /HTTP 502/);
});

test('page: 提交房间 → POST /api/rooms + 存 token，刷新后行上带「我的」/改备注/销毁', async () => {
  const roomsAfter = {
    ok: true, now: NOW, ttlSec: 600, visitors: 1,
    rooms: [{ code: 'ABCD', serverId: 'weishu', serverName: '站长服务', leftSec: 597, url: 'https://weishu.jiangjiangze.icu/' }],
  };
  const { api, list, calls, store } = await runPage(roomsAfter, {
    fetch: (url, options) => (options.method === 'POST'
      ? jsonRes({ ok: true, added: { code: 'ABCD', serverId: 'weishu', serverName: '站长服务', leftSec: 600 }, token: 'a'.repeat(32) }, 201)
      : jsonRes(roomsAfter)),
  });

  const res = await api.submitRoom({ url: 'https://weishu.jiangjiangze.icu/?room=abcd', server: '站长服务', serverId: 'weishu' });
  assert.equal(res.ok, true);
  assert.match(res.text, /10 分钟内有效/);

  const post = calls.find((c) => c.options.method === 'POST');
  assert.equal(post.url, '/api/rooms');
  assert.equal(post.options.headers['content-type'], 'application/json');
  // v7：码从链接读、链接原样带上（payload 里 url 必存在）
  assert.deepEqual(JSON.parse(post.options.body), {
    code: 'ABCD', serverId: 'weishu', serverName: '站长服务',
    url: 'https://weishu.jiangjiangze.icu/?room=abcd',
  });

  // 凭据落到本源 localStorage（token + serverId 双匹配所需），并带 10 分钟到期时间。
  const saved = JSON.parse(store.get('sp.lobby.mine'));
  assert.equal(saved.ABCD.token, 'a'.repeat(32));
  assert.equal(saved.ABCD.serverId, 'weishu');
  assert.ok(saved.ABCD.expiresAt > Date.now(), 'expiry in the future');

  await api.load();
  const html = list.innerHTML;
  assert.match(html, /class="room is-open is-mine"/);
  assert.match(html, /badge is-mine">我的</);
  assert.match(html, /data-act="note" data-code="ABCD"/);
  assert.match(html, /data-act="destroy" data-code="ABCD"/);
  assert.match(html, /剩 10 分钟/, 'owned rooms show the remaining TTL, not "x 分钟前"');

  // 校验失败不发请求（本地拦截）：链接没有房号 / 干脆没给链接，两种都拦住。
  const before = calls.length;
  const bad = await api.submitRoom({ url: 'https://weishu.jiangjiangze.icu/' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /没有房号/);
  const none = await api.submitRoom({});
  assert.equal(none.ok, false);
  assert.equal(calls.length, before, 'invalid input never reaches the board');
});

test('page: 销毁自己的房间 → DELETE 带 X-Token；已过期/被重提则清掉本机凭据', async () => {
  const seed = {
    'sp.lobby.mine': JSON.stringify({
      ABCD: { token: 't1', serverId: 'weishu', serverName: '站长服务', expiresAt: Date.now() + 600_000 },
      EEEE: { token: 't2', serverId: 'weishu', serverName: '站长服务', expiresAt: Date.now() + 600_000 },
      FFFF: { token: 't3', serverId: 'weishu', serverName: '站长服务', expiresAt: Date.now() - 1000 },
    }),
  };
  const board = { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [ROOM_NOSEAT] };
  const { api, calls, store } = await runPage(board, {
    seed,
    fetch: (url, options) => {
      if (options.method === 'DELETE') {
        if (url.includes('EEEE')) return jsonRes({ ok: false, error: 'NOT_FOUND', message: 'no live room for this code' }, 404);
        return jsonRes({ ok: true, removed: { code: 'ABCD', serverId: 'weishu' } });
      }
      return jsonRes(board);
    },
  });

  const ok = await api.destroyRoom('ABCD');
  assert.equal(ok.ok, true);
  assert.match(ok.text, /已销毁/);
  const del = calls.find((c) => c.options.method === 'DELETE');
  assert.equal(del.url, '/api/rooms?code=ABCD&serverId=weishu');
  assert.equal(del.options.headers['X-Token'], 't1');

  // 过期（NOT_FOUND）也把本机凭据清掉，免得留一条永远失败的记录。
  const gone = await api.destroyRoom('EEEE');
  assert.equal(gone.ok, true);
  assert.match(gone.text, /已过期/);

  const mine = api.readMine();
  assert.equal(mine.ABCD, undefined);
  assert.equal(mine.EEEE, undefined);
  assert.equal(mine.FFFF, undefined, 'expired credentials are pruned');
  assert.deepEqual(JSON.parse(store.get('sp.lobby.mine')), {}, 'nothing left behind');
});

test('page: 改备注 → PATCH /api/rooms（token 头 + serverId 双匹配，只动 note）', async () => {
  const seed = { 'sp.lobby.mine': JSON.stringify({ ABCD: { token: 't1', serverId: 'weishu', expiresAt: Date.now() + 600_000 } }) };
  const board = { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [] };
  const { api, calls } = await runPage(board, {
    seed,
    fetch: (url, options) => (options.method === 'PATCH'
      ? jsonRes({ ok: true, updated: { code: 'ABCD', serverId: 'weishu', note: '新备注' } })
      : jsonRes(board)),
  });

  const res = await api.saveNote('ABCD', '  新备注  ');
  assert.equal(res.ok, true);

  const patch = calls.find((c) => c.options.method === 'PATCH');
  assert.equal(patch.url, '/api/rooms');
  assert.equal(patch.options.headers['X-Token'], 't1');
  assert.deepEqual(JSON.parse(patch.options.body), { code: 'ABCD', serverId: 'weishu', note: '新备注' });

  // 无本机凭据 → 直接拒绝，不发请求。
  const before = calls.length;
  const r2 = await api.saveNote('ZZZZ', 'x');
  assert.equal(r2.ok, false);
  assert.equal(calls.length, before);
});

test('page: 已知服务器从房间牌推导（供提交表单选，并自动补房间地址）', async () => {
  const { api } = await runPage({ ok: true, now: NOW, rooms: [] });
  const known = api.knownFrom([ROOM_OPEN, ROOM_FULL, { ...ROOM_OPEN, code: 'FFFF' }, { code: 'GGGG', serverName: '', serverId: 's9' }]);
  assert.deepEqual(plain(known), [
    { name: 'raiya服', id: 's1', origin: 'https://game.example.com/' },
    { name: '梨子湖', id: 's3', origin: 'https://xn--rlr.rinko.ai/' },
  ]);
});

test('probe (C)：行上缺房间人数时读该服 /healthz，标「服务器级」；有数字的行不探', async () => {
  const payload = { ok: true, now: NOW, rooms: [ROOM_OPEN, ROOM_NOSEAT] };
  const probes = [];
  const { els, calls } = await runPage(payload, {
    fetch: (url) => {
      if (url.indexOf('/healthz') >= 0) {
        probes.push(url);
        return jsonRes({ ok: true, rooms: 2, humans: 7, uptime: 10 });
      }
      return jsonRes(payload);
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(probes, ['https://game.example.com/healthz'], '只探缺数字那一行的 origin，且只探一次');
  assert.match(els.list.innerHTML, /该服当前 7 人 · 2 房/, '显示服务端自报的聚合数字');
  assert.match(els.list.innerHTML, /服务器级/, '必须标出层级');
  assert.match(els.list.innerHTML, /2\/4/, '房主上报过的那一行照旧显示房间级数字');
  assert.ok(!calls.some((c) => c.url.indexOf('127.0.0.1') >= 0), '私网/非 https 的行绝不探');
});

test('probe (C)：读不到数字（或 Workers 变体不报 humans/rooms）→ 静默，绝不显示 0', async () => {
  const payload = { ok: true, now: NOW, rooms: [ROOM_NOSEAT] };
  const { els } = await runPage(payload, {
    fetch: (url) => (url.indexOf('/healthz') >= 0 ? jsonRes({ ok: true, uptime: 3 }) : jsonRes(payload)),
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!/该服当前/.test(els.list.innerHTML), '没有数字就什么都不显示');
  assert.ok(!/0 人/.test(els.list.innerHTML), '绝不编一个 0 出来');
  assert.ok(!/服务器级/.test(els.list.innerHTML));
});

test('probe (C)：按 origin 缓存 60s —— 两次刷新只探一次', async () => {
  const payload = { ok: true, now: NOW, rooms: [ROOM_NOSEAT] };
  const probes = [];
  const { api } = await runPage(payload, {
    fetch: (url) => {
      if (url.indexOf('/healthz') >= 0) { probes.push(url); return jsonRes({ ok: true, humans: 1, rooms: 1 }); }
      return jsonRes(payload);
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  await api.load();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(probes.length, 1, '60s 窗口内同一 origin 只探一次');
});

test('page: a closed room shows 已关闭 with a disabled action and keeps the top group', async () => {
  const CLOSED = {
    code: 'NEWS', serverId: 'notice', serverName: '公告', note: '主仓库 0.2.0 已发布',
    status: 'closed', ageSec: 0, leftSec: 600,
  };
  const { list } = await runPage({ ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [CLOSED, ROOM_OPEN] });
  const html = list.innerHTML;
  assert.match(html, /class="badge is-closed">已关闭</, 'closed badge');
  assert.match(html, /<button class="btn btn--sm" disabled><span class="btn__label">已关闭<\/span><\/button>/, 'disabled action');
  assert.ok(!/data-href="[^"]*room=NEWS/.test(html), 'a closed row is never a join target');
  assert.ok(html.indexOf('NEWS') < html.indexOf('AAAA'), 'closed rows share the top group (newest first)');
});
