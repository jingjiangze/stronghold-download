// 清单的服务端写入 + Ed25519 签名，submit（匿名自动上线）与 review（人工通过）共用。
// 签名口径与 tools/sign-servers.mjs 完全同源：载荷 = canonicalPayload(doc)（剔 sig/unsigned、
// 键递归字典序、数组保序、无空白、UTF-8），sig = base64(ed25519.sign(载荷))。
// 密钥来自 Pages secret SP_SIGN_KEY / SP_PUB_KEY（与 stronghold-scout Worker 同一对，
// keyId sp-2026-10）；缺任一或验不过就不签，退回未签名并把话术留给维护者。

import { canonicalPayload } from './_verify.js';

const LIST_KEY = 'site/servers.json';
const LOG_KEY = 'site/publish-log.json';
const PKCS8_ED25519 = '302e020100300506032b657004220420';
const SPKI_ED25519 = '302a300506032b6570032100';
const HEX64 = /^[0-9a-f]{64}$/i;
const KEY_ID = 'sp-2026-10';

const unhex = (s) => Uint8Array.from(String(s).match(/../g).map((h) => parseInt(h, 16)));
const withPrefix = (prefix, hex) => {
  const body = unhex(String(hex).trim().toLowerCase());
  const head = unhex(prefix);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
};
const base64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

let cachedPair = null;
let cachedSource = '';

async function keyPair(env) {
  const seed = String(env.SP_SIGN_KEY || '').trim().toLowerCase();
  const pub = String(env.SP_PUB_KEY || '').trim().toLowerCase();
  if (!HEX64.test(seed) || !HEX64.test(pub)) return null;
  const source = seed + pub;
  if (cachedPair && cachedSource === source) return cachedPair;
  try {
    cachedPair = {
      priv: await crypto.subtle.importKey('pkcs8', withPrefix(PKCS8_ED25519, seed), 'Ed25519', false, ['sign']),
      pub: await crypto.subtle.importKey('spki', withPrefix(SPKI_ED25519, pub), 'Ed25519', false, ['verify']),
    };
    cachedSource = source;
    return cachedPair;
  } catch {
    return null;
  }
}

/** 现网有没有配置这把签名密钥（调用方据此决定要不要走自动发布）。 */
export function canSign(env) {
  return HEX64.test(String(env.SP_SIGN_KEY || '').trim()) && HEX64.test(String(env.SP_PUB_KEY || '').trim());
}

/** 签名并自校验；返回带 sig 的新文档，配错密钥/验不过一律返回 null（绝不发半签的清单）。 */
export async function signServersDoc(doc, env) {
  const pair = await keyPair(env);
  if (!pair) return null;
  const next = { ...doc };
  delete next.sig;
  delete next.unsigned;
  next.updated = new Date().toISOString();
  if (!next.keyId) next.keyId = KEY_ID;
  if (typeof next.v !== 'number') next.v = 1;
  const payload = canonicalPayload(next);
  const bytes = new TextEncoder().encode(payload);
  let sig;
  try {
    sig = await crypto.subtle.sign('Ed25519', pair.priv, bytes);
    // 签完立刻用配对的公钥验一次：密钥装错、或两侧规范化口径分叉时，客户端会**静默**拒绝
    // 整份清单（页面照常、游戏里一台服务器都没有），所以这里必须当场拒发而不是发出去。
    if (!(await crypto.subtle.verify('Ed25519', pair.pub, sig, new TextEncoder().encode(canonicalPayload(next))))) return null;
  } catch {
    return null;
  }
  next.sig = base64(sig);
  return next;
}

/**
 * 写 R2 并留审计。baseUpdated 是调用方读到的那份清单版本号：对不上说明期间有人改过，
 * 直接拒写 —— 否则一个旧标签页点一下按钮就能把刚上线的服务器抹掉（2026-10-04 发生过）。
 */
export async function publishServersDoc(env, doc, opts) {
  const meta = opts || {};
  const current = await env.R2BUCKET.get(LIST_KEY);
  if (current && meta.baseUpdated) {
    let live = null;
    try { live = JSON.parse(await current.text()); } catch { /* 现网坏了就允许覆盖修复 */ }
    if (live && String(live.updated) !== String(meta.baseUpdated)) {
      return { conflict: true, liveUpdated: live.updated };
    }
  }
  const body = JSON.stringify(doc, null, 2) + '\n';
  await env.R2BUCKET.put(LIST_KEY, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' },
  });
  await appendPublishLog(env, doc, meta);
  return { ok: true, count: (doc.servers || []).length, updated: doc.updated, signed: !!doc.sig };
}

async function appendPublishLog(env, doc, meta) {
  try {
    const prev = await env.R2BUCKET.get(LOG_KEY);
    let log = prev ? JSON.parse(await prev.text()) : { entries: [] };
    if (!log || !Array.isArray(log.entries)) log = { entries: [] };
    log.entries.push({
      at: new Date().toISOString(),
      count: (doc.servers || []).length,
      signed: !!doc.sig,
      via: meta.via || 'unknown',
      entryId: meta.entryId || null,
      entryUrl: meta.entryUrl || null,
      ua: String(meta.ua || '').slice(0, 120),
      ip: String(meta.ip || '').slice(0, 60),
      country: meta.country || null,
    });
    if (log.entries.length > 300) log.entries = log.entries.slice(-300);
    await env.R2BUCKET.put(LOG_KEY, JSON.stringify(log, null, 1) + '\n', {
      httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
    });
  } catch { /* 审计写失败不挡发布 */ }
}

/** 发布审计的最近若干条（可按 via 过滤），给维护者查"谁匿名上线了什么"。 */
export async function readPublishLog(env, limit, via) {
  try {
    const prev = await env.R2BUCKET.get(LOG_KEY);
    if (!prev) return [];
    const log = JSON.parse(await prev.text());
    const entries = Array.isArray(log.entries) ? log.entries : [];
    return (via ? entries.filter((e) => e && e.via === via) : entries).slice(-Math.min(limit || 20, 100));
  } catch {
    return [];
  }
}

/** 某 IP 在 windowMs 内**自动上线**了几条 —— 匿名直接进签名清单，得有个刷屏上限。
 *  维护者自己的 PUT/审核发布不算在内，否则管理动作会吃掉访客额度。 */
export async function recentPublishes(env, ip, windowMs) {
  try {
    const prev = await env.R2BUCKET.get(LOG_KEY);
    if (!prev) return 0;
    const log = JSON.parse(await prev.text());
    const since = Date.now() - windowMs;
    return (Array.isArray(log.entries) ? log.entries : [])
      .filter((e) => e && e.ip === String(ip) && e.via === 'auto-submit' && Date.parse(e.at || '') >= since).length;
  } catch {
    return 0;
  }
}
