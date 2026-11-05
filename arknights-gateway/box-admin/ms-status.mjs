// ms-status.mjs —— 只读：魔搭游戏服状态（health + 平台侧提交对比）
//   凭据从 stronghold-server 的 ms 远端读取，只在内存里用，不打印。
// 用法：node ms-status.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NS = 'jingjiangze', NAME = 'Stronghold-Protocol';
const MS_API = 'https://www.modelscope.cn/api/v1/studio';
const MS_HEALTH = 'https://studio-jingjiangze-stronghold-protocol.api-inference.modelscope.net/healthz';

/** 令牌来源：git 远端（仓库内不含值）。绝不打印。 */
function msToken() {
  const url = execFileSync('git', ['-C', 'C:/DDDD/Agent Work/stronghold-server', 'remote', 'get-url', 'ms'],
    { encoding: 'utf8' }).trim();
  const m = /oauth2:([^@]+)@/.exec(url);
  if (!m) throw new Error('ms 远端里没有 oauth2 凭据');
  return m[1];
}

const token = msToken();
const out = {};
try {
  const r = await fetch(MS_HEALTH, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (r.ok) {
    const h = await r.json();
    out.health = { app: h.app, build: h.build, uptimeSec: h.uptimeSec,
      rooms: h.rooms ?? 0, humans: h.humans ?? 0, matches: h.matches ?? 0, online: h.online ?? null };
  } else out.health = { http: r.status };
} catch (e) { out.health = { error: String(e?.message || e).slice(0, 160) }; }
try {
  const r = await fetch(`${MS_API}/${NS}/${NAME}/commit/check-changed`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (r.ok) {
    const d = (await r.json())?.Data || {};
    out.deploy = { current: String(d.CurrentCommitId || '').slice(0, 8),
      deployed: String(d.LastDeployCommitId || '').slice(0, 8), changed: d.HasChanged === true };
  }
} catch { /* 平台读不到不影响占用判断 */ }

const busy = (out.health?.rooms || 0) + (out.health?.humans || 0) + (out.health?.matches || 0);
out.canRedeploy = busy === 0;
console.log(JSON.stringify(out, null, 1));
