// 本机通道探针（跑在盒子上，静默无窗口后台）
//
// 关键点：**盒子本身就是那台游戏服**。三条通道（卫戍云 / NYAT / SakuraFRP）只是通往
// 同一台服的三条网络路径——实测三者 /healthz 返回同一份 build 与 uptime。所以这里直接
// 读本机 127.0.0.1 的服务端口即可，不需要绕公网、不需要证书、不发出任何外部请求。
//
// 这么做省掉的是两笔开销：
//   1) Worker 每次 /api/status 都要从 Cloudflare 出去 fetch 三条通道的 /healthz；
//   2) 其中那条自签名隧道的通道，CF 侧证书校验必然失败，永远探不到（只能显示「状态未取」）。
// 现在两端都不用 Worker 亲自探：本站 Worker 只读回传的快照。
//
// 安全：只连 127.0.0.1 上白名单端口，不解析域名、不接受外部地址——本机读本机，
// 没有 SSRF 面。回传目标仍走 https + 公网校验（assertPublicUrl）。
//
// 用法：
//   node probe.mjs --dry           # 只打印，不上传
//   node probe.mjs                 # 探测并上传（需要 SP_INGEST_URL / SP_INGEST_TOKEN）

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 本机游戏服的 /healthz。三条通道共用这一份状态，所以只需要一个地址。
// 端口必须是 **3000（nginx 稳定入口）**，不能写 3001/3002：那俩是蓝绿两个槽本身，
// 更新时会在两者之间来回切（切的时候旧槽还在服务、数字却是旧的）。3000 恒指向当前
// 活着的那一槽。实测：槽切换后 3000 的 build 与三条通道公网 /healthz 始终一致。
// 换机器时用 SP_LOCAL_PORT 覆盖，改完务必比对 build 是否一致。
const LOCAL_HEALTHZ = { host: '127.0.0.1', port: Number(process.env.SP_LOCAL_PORT || 3000), path: '/healthz' };

function loadConfig() {
  const cfg = { url: process.env.SP_INGEST_URL || '', token: process.env.SP_INGEST_TOKEN || '' };
  try {
    const file = JSON.parse(readFileSync(path.join(HERE, 'config.json'), 'utf8'));
    if (!cfg.url && typeof file.ingestUrl === 'string') cfg.url = file.ingestUrl;
    if (!cfg.token && typeof file.ingestToken === 'string') cfg.token = file.ingestToken;
  } catch {
    /* 没有 config.json 就用环境变量 */
  }
  return cfg;
}

// 本机 HTTP 读取。显式只连环回地址：host 是常量 127.0.0.1，不来自任何输入。
function localHealthz({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: LOCAL_HEALTHZ.host,
        port: LOCAL_HEALTHZ.port,
        path: LOCAL_HEALTHZ.path,
        method: 'GET',
        headers: { accept: 'application/json', host: `${LOCAL_HEALTHZ.host}:${LOCAL_HEALTHZ.port}` },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 256 * 1024) {
            req.destroy();
            reject(new Error('响应过大'));
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`本机 HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('本机响应不是 JSON'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('本机读取超时')));
    req.on('error', reject);
    req.end();
  });
}

// 回传目标是公网 https，仍然做完整的地址校验（拒绝环回/私网/保留地址）。
function isPrivateOrReserved(ip) {
  const v = String(ip || '').trim().toLowerCase();
  if (!v) return true;
  if (v === '::' || v === '::1' || v === '0.0.0.0') return true;
  if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
  if (v.startsWith('::ffff:')) return isPrivateOrReserved(v.slice(7));
  if (/^169\.254\./.test(v)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(v)) return true;
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a >= 224) return true;
  return false;
}

async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`只允许 https: ${raw}`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost') throw new Error(`拒绝的主机: ${host}`);
  if (['.local', '.localhost', '.internal', '.home.arpa'].some((t) => host.endsWith(t))) {
    throw new Error(`拒绝的域名后缀: ${host}`);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateOrReserved(host)) throw new Error(`拒绝的私网/保留地址: ${host}`);
    return u;
  }
  let addrs = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error(`域名解析失败: ${host} (${e.code || e.message})`);
  }
  if (!addrs.length) throw new Error(`域名解析为空: ${host}`);
  for (const { address } of addrs) {
    if (isPrivateOrReserved(address)) throw new Error(`拒绝的私网/保留地址: ${host} -> ${address}`);
  }
  return u;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// 内存 / CPU 占用：/healthz 里没有这两项，得问操作系统。proc-stat.ps1 按
// active_slot.json 找到当前活着的那一槽的 node 进程（3000 只是 nginx 转发壳，
// 采它的 PID 没有意义），采样工作集与 1.2 秒窗口内的 CPU 占用。
// 失败就如实给 null，页面上显示「—」，不影响在线状态。
function procStat() {
  return new Promise((resolve) => {
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const script = path.join(HERE, 'proc-stat.ps1');
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: String(err.message || err) });
          return;
        }
        const line = String(stdout || '').trim().split('\n').pop();
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, error: 'proc-stat 输出不可解析' });
        }
      }
    );
  });
}

function shape(body, latencyMs) {
  return {
    ok: body.ok === true,
    app: typeof body.app === 'string' ? body.app : null,
    build: typeof body.build === 'string' ? body.build : null,
    uptimeSec: num(body.uptimeSec),
    humans: num(body.humans),
    bots: num(body.bots),
    sessions: num(body.sessions),
    sockets: num(body.sockets),
    rooms: num(body.rooms),
    matches: num(body.matches),
    spectators: num(body.spectators),
    memRssMb: body?.mem ? num(body.mem.rss) : null,
    latencyMs,
    error: body.ok === true ? null : '服务端自报异常',
  };
}

async function main() {
  const dry = process.argv.includes('--dry');

  // 通道清单只用来知道「要给哪几条通道填数据」；数值全部来自本机一份状态。
  // 盒子目录里放一份精简清单（box/channels.json，只有 id 与 name）——
  // 别去读 ../public/data/channels.json：盒子上没有仓库目录，路径必然打不开。
  const channelsFile = path.join(HERE, 'channels.json');
  const data = JSON.parse(readFileSync(channelsFile, 'utf8'));
  const channels = Array.isArray(data.channels) ? data.channels : [];

  const started = Date.now();
  let shared = null;
  let readError = null;
  try {
    shared = shape(await localHealthz(), Date.now() - started);
  } catch (e) {
    readError = String(e.message || e);
  }

  // 内存/CPU：与 healthz 并行采，谁也不等谁。采不到就 null（页面显示「—」）。
  const proc = await procStat();
  if (shared) {
    shared.memRssMb = proc.ok ? num(proc.rssMb) : shared.memRssMb;
    shared.cpuPct = proc.ok ? num(proc.cpuPct) : null;
    shared.procError = proc.ok ? null : proc.error || 'proc-stat 失败';
  }

  const results = channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    // 同一台服：每条通道都是同一份状态。读不到就如实给 ok:false。
    ...(shared || { ok: false, error: readError || '本机读取失败' }),
  }));

  const out = {
    generatedAt: new Date().toISOString(),
    collector: 'box-probe',
    source: `${LOCAL_HEALTHZ.host}:${LOCAL_HEALTHZ.port}${LOCAL_HEALTHZ.path}`,
    channels: results,
  };

  const json = JSON.stringify(out);
  if (dry) {
    console.log(json);
    return;
  }

  const cfg = loadConfig();
  if (!cfg.url || !cfg.token) throw new Error('缺少 ingest 配置（SP_INGEST_URL / SP_INGEST_TOKEN 或 config.json）');
  await assertPublicUrl(cfg.url);
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: json,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  console.log(`[probe] ingest ${res.status} ${text.slice(0, 200)}`);
  if (!res.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[probe] FAILED ${e.message || e}`);
  process.exitCode = 1;
});
