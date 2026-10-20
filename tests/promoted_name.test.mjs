// promotedName 单测：锁住「名称不能直接是域名」（2026-10-20 用户口径）。
// 只测纯函数，不碰 R2、不碰网络。跑：node tests/promoted_name.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { promotedName } = await import(new URL('../functions/api/servers/verify.js', import.meta.url).href);

test('promotedName: 已经是人类可读的名字 → 原样留', () => {
  assert.equal(promotedName({ name: '临夏服（待核）', url: 'https://wei.linxia.dev' }), '临夏服');
  assert.equal(promotedName({ name: '妮蔻（待核）', url: 'https://sp.nekotc.cn' }), '妮蔻');
  // 非域名形态的洋名也留
  assert.equal(promotedName({ name: 'Lunar（待核）', url: 'https://stronghold.lunar.ag' }), 'Lunar');
  assert.equal(promotedName({ name: 'raiya 二服（待核）', url: 'https://sp.rainya.me:10166/play' }), 'raiya 二服');
});

test('promotedName: 域名 → 主机名首段当牌子', () => {
  assert.equal(promotedName({ name: 'ark.sakusky.com（待核）', url: 'https://ark.sakusky.com' }), 'ark');
  assert.equal(promotedName({ name: 'busy.example（待核）', url: 'https://busy.example' }), 'busy');
  assert.equal(promotedName({ name: 'dx.frp-gap.com（待核）', url: 'https://dx.frp-gap.com:29943' }), 'dx');
});

test('promotedName: 通用前缀 / 纯数字 IP → 中性称呼，绝不留裸域名', () => {
  assert.equal(promotedName({ name: 'sp.jinghuashang.cn（待核）', url: 'https://sp.jinghuashang.cn' }), '社区服');
  assert.equal(promotedName({ name: 'www.thing.com（待核）', url: 'https://www.thing.com' }), '社区服');
  assert.equal(promotedName({ name: '39.96.56.241（待核）', url: 'http://39.96.56.241:3018' }), '社区服');
  assert.equal(promotedName({ name: 'game.xiaolubao.com（待核）', url: 'https://game.xiaolubao.com/play' }), '社区服');
});

test('promotedName: 坏 URL / 空字段不炸', () => {
  assert.equal(promotedName({ name: '坏服（待核）', url: 'not-a-url' }), '坏服');
  assert.equal(promotedName({ name: '', url: '' }), '社区服');
  assert.equal(promotedName({}), '社区服');
  assert.equal(promotedName(null), '社区服');
});

test('promotedName: 没有「（待核）」后缀的域名也要按域名处理（防手工录入）', () => {
  assert.equal(promotedName({ name: 'ark.sakusky.com', url: 'https://ark.sakusky.com' }), 'ark');
  assert.equal(promotedName({ name: 'sp.isomer319.xyz', url: 'https://sp.isomer319.xyz' }), '社区服');
});

test('promotedName: 结果永远不含裸域名（用户口径的硬断言）', () => {
  const cases = [
    { name: 'ark.sakusky.com（待核）', url: 'https://ark.sakusky.com' },
    { name: 'sp.jinghuashang.cn（待核）', url: 'https://sp.jinghuashang.cn' },
    { name: '39.96.56.241（待核）', url: 'http://39.96.56.241:3018' },
    { name: 'game.xiaolubao.com（待核）', url: 'https://game.xiaolubao.com/play' },
    { name: 'game.kafuno.cn（待核）', url: 'https://game.kafuno.cn' },
  ];
  for (const c of cases) {
    const out = promotedName(c);
    let host = '';
    try { host = new URL(c.url).hostname; } catch { /* ignore */ }
    assert.notEqual(out, host, `${host} 不该原样成为名字`);
    assert.ok(!out.includes(host), `名字 ${out} 不该包含域名 ${host}`);
    assert.ok(!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(out), `名字 ${out} 不该是域名形态`);
  }
});
