// ann-probe.mjs —— 公告链路闭合探针（验收用，必须走这一步，不能只看接口 200）
//
// 为什么存在：`reset_restart` 第一次重建后 SP_ANNOUNCEMENTS_URL 不一定注入成功，
// 游戏服可能根本没来拉取。接口 200 ≠ 链路通。
//
// 用法：
//   node ann-probe.mjs                 放探针 → 等 2 个 60s 窗口 → 判定 → 自动回滚
//   node ann-probe.mjs --check         只看当前是否一致（不改数据）
//
// 判据：游戏服的 /data/announcements.json 出现探针文案 ⇒ 链路闭合。
// 回滚源：仓库内 data/announcements.json（磁盘副本，权威原文）。
import { readFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const SITE = 'https://arknights.jiangjiangze.icu';
const GAME = 'https://jingjiangze-stronghold-protocol.ms.show';
/** 权威原文（磁盘副本）：探针污染后用它恢复。 */
const ORIGIN_FILE = 'C:/DDDD/Agent Work/stronghold-server/data/announcements.json';
const MARK = '[链路探针]';

const cfg = JSON.parse(readFileSync('C:/DDDD/Agent Work/arknights-gateway/box/config.json', 'utf8'));
const TOKEN = cfg.ingestToken;

const get = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) });
  return JSON.parse(await r.text());
};
const put = async (path, data) => {
  const r = await fetch(SITE + path, {
    method: 'PUT',
    headers: { 'user-agent': UA, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: r.status, body: await r.text() };
};
const sig = (es) => JSON.stringify(es.map((e) => ({ title: e.title, date: e.date, paragraphs: e.paragraphs })));

const orig = JSON.parse(readFileSync(ORIGIN_FILE, 'utf8'));
const origList = Array.isArray(orig) ? orig : (orig.announcements || orig.entries || []);

if (process.argv.includes('--check')) {
  const mine = await get(`${SITE}/api/announcements/game`);
  const srv = await get(`${GAME}/data/announcements.json`);
  console.log('我的服务 :', mine.length, '条');
  console.log('游戏服   :', srv.length, '条');
  console.log('一致     :', sig(mine) === sig(srv));
  console.log('探针残留 :', srv.some((e) => (e.paragraphs || []).some((p) => (p || '').includes(MARK))));
  process.exit(0);
}

console.log('原文条数:', origList.length);
const probe = [{ ...origList[0], paragraphs: [...(origList[0].paragraphs || []), MARK + ' ' + new Date().toISOString()] }];
const put1 = await put('/api/announcements/game/admin', probe);
console.log('放探针  :', put1.status);

const waitMs = 130000; // 2 个 60s 轮询窗口 + 余量
console.log(`等待 ${waitMs / 1000}s …`);
await new Promise((r) => setTimeout(r, waitMs));

const srv = await get(`${GAME}/data/announcements.json`);
const hit = srv.some((e) => (e.paragraphs || []).some((p) => (p || '').includes(MARK)));
console.log('【判据】游戏服出现探针:', hit);

const back = await put('/api/announcements/game/admin', origList);
console.log('回滚    :', back.status);
const after = await get(`${SITE}/api/announcements/game`);
console.log('回滚后条数:', after.length, '| 与原文一致:', sig(after) === sig(origList));
console.log(hit ? 'RESULT: 链路已闭合' : 'RESULT: 链路未闭合（检查 env 注入，或再 reset_restart 一次）');
