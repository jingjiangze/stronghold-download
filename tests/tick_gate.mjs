// /api/tick 的采集节流用例：node tests/tick_gate.mjs
// 钉住"一天一次"这件事的四个边界：口令仍然优先、节流窗内不创建 run 但回 200（盒子那边不报警）、
// 节流的那次不能续期 lastCrawlAt（否则每小时打进来会把窗口一直往后推，采集永远轮不到）、
// ?force=1 能立刻越过。不打网络：fetch 换成路由桩，R2 用内存 Map。

import assert from 'node:assert/strict';
import { makeDb } from './_db-stub.mjs';

const TICK = await import(new URL('../functions/api/tick.js', import.meta.url).href);

let pass = 0;
const results = [];
async function ok(name, fn) {
  try { await fn(); pass += 1; results.push('  ok  ' + name); }
  catch (e) { results.push('FAIL  ' + name + ' :: ' + (e && e.message)); }
}

const KEY = 'tick-key';
const HOUR = 3600e3;

function makeEnv(historyDoc) {
  const store = new Map();
  if (historyDoc) store.set('site/tick.json', JSON.stringify(historyDoc));
  return {
    TICK_KEY: KEY, GH_TICK_TOKEN: 'gh', DB: makeDb(store),
    __store: store,
  };
}

let calls = [];
function stubFetch(status = 204) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body ? String(init.body) : '' });
    // 204 不能带 body（undici 会抛 TypeError），GitHub 的 dispatch 成功就是这么回的
    return new Response(status === 204 ? null : '', { status });
  };
}

let ipSeq = 0;
const post = (search) => new Request('https://dl.jiangjiangze.icu/api/tick' + (search || ''), {
  method: 'POST', headers: { 'x-tick-key': KEY, 'cf-connecting-ip': '10.0.' + (++ipSeq) + '.' + ipSeq },
});
// 每一例都重置 fetch 桩：否则 dispatched() 会看见上一例留下的派发记录
const ctx = (env, search) => { stubFetch(); return TICK.onRequestPost({ request: post(search), env, waitUntil: () => {} }); };
const hb = (env) => JSON.parse(env.__store.get('site/tick.json'));
const dispatched = () => calls.some((c) => /dispatches$/.test(c.url));
const dispatchBody = () => (calls.find((c) => /dispatches$/.test(c.url)) || {}).body || '';

await ok('没口令 → 403，且不碰 GitHub', async () => {
  const env = makeEnv();
  stubFetch();
  const res = await TICK.onRequestPost({
    request: new Request('https://dl.jiangjiangze.icu/api/tick', { method: 'POST', headers: { 'cf-connecting-ip': '10.9.9.9' } }),
    env, waitUntil: () => {},
  });
  assert.equal(res.status, 403);
  assert.equal(dispatched(), false);
});

await ok('第一次（台账里还没有采集记录）照常派发并写下 lastCrawlAt', async () => {
  const env = makeEnv();
  const body = await (await ctx(env)).json();
  assert.equal(body.ok, true);
  assert.equal(body.throttled, undefined);
  assert.equal(dispatched(), true);
  assert.ok(Date.parse(hb(env).lastCrawlAt), 'lastCrawlAt 要落盘');
});

await ok('窗内再打：回 200 + throttled，不创建 run，也不续期 lastCrawlAt', async () => {
  const first = new Date(Date.now() - 2 * HOUR).toISOString();
  const env = makeEnv({ history: [], lastCrawlAt: first });
  const body = await (await ctx(env)).json();
  assert.equal(body.ok, true, '盒子那边按成功处理，不该报警');
  assert.equal(body.throttled, true);
  assert.equal(dispatched(), false);
  assert.equal(hb(env).lastCrawlAt, first, '节流的那次不能把窗口往后推');
  assert.match(body.nextAt, /^\d{4}-\d{2}-\d{2}T/);
});

await ok('超过 11.5 小时窗 → 恢复派发（一天两次的节拍）', async () => {
  const env = makeEnv({ history: [], lastCrawlAt: new Date(Date.now() - 12 * HOUR).toISOString() });
  const body = await (await ctx(env)).json();
  assert.equal(body.throttled, undefined);
  assert.equal(dispatched(), true);
  // 11.5 小时之内仍要挡住：24 小时里最多两次，不会变成三次
});

await ok('刚过 11.5 小时仍算窗内（一天两次的上限靠这个卡住）', async () => {
  const env = makeEnv({ history: [], lastCrawlAt: new Date(Date.now() - 11 * HOUR).toISOString() });
  const body = await (await ctx(env)).json();
  assert.equal(body.throttled, true);
  assert.equal(dispatched(), false);
});

await ok('?force=1 立刻越过节流（口令仍要过）', async () => {
  const env = makeEnv({ history: [], lastCrawlAt: new Date().toISOString() });
  const body = await (await ctx(env, '?force=1')).json();
  assert.equal(body.throttled, undefined);
  assert.equal(dispatched(), true);
  assert.match(dispatchBody(), /"now":true/, 'force 必须把 workflow 那道一天守门也越过去');
});

await ok('target=probe 这类非采集打点不受节流影响', async () => {
  const env = makeEnv({ history: [], lastCrawlAt: new Date().toISOString() });
  const body = await (await ctx(env, '?target=probe')).json();
  assert.equal(body.throttled, undefined);
  assert.equal(dispatched(), true);
});

console.log(results.join('\n'));
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log('\n' + pass + ' 通过 / ' + (pass + failed) + ' 总计');
process.exit(failed ? 1 : 0);
