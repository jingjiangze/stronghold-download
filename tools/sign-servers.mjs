#!/usr/bin/env node
/* ==========================================================================================
   sign-servers.mjs — 服务器清单的本机 Ed25519 签名 / 验签工具（私钥不出这台机器）

     node tools/sign-servers.mjs                    拉线上清单并验签（默认动作）
     node tools/sign-servers.mjs --sign             重签并打印到 stdout
     node tools/sign-servers.mjs --sign --publish   重签后 PUT /api/servers 发布，并回读复验
     node tools/sign-servers.mjs --file in.json --sign --out signed.json

   规则与 functions/api/_verify.js 的 canonicalPayload() 同源（服务端 review 也算它）：
     待签载荷 = 去掉 sig / unsigned 后的 JSON，对象键递归按字典序、数组顺序不变、无空白、UTF-8
     sig      = base64( ed25519.sign(载荷) )
   `updated` 参与签名，所以手改时间戳必然导致验签失败。

   密钥：~/.sp-sign/ed25519.key（32 字节 seed 的 hex）与 ~/.sp-sign/ed25519.pub（32 字节裸公钥 hex）
   发布口令：环境变量 PUBLISH_KEY，或 ~/.sp_publish_key，或 ../stronghold-download-audit/recon/publish_key.txt
   ========================================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalPayload } from '../functions/api/_verify.js';

const LIVE = 'https://weishucdn.jiangjiangze.icu/site/servers.json';
const PUT_URL = 'https://dl.jiangjiangze.icu/api/servers';
const KEY_FILE = path.join(os.homedir(), '.sp-sign', 'ed25519.key');
const PUB_FILE = path.join(os.homedir(), '.sp-sign', 'ed25519.pub');
const PUBLISH_KEY_FILES = [
  path.join(os.homedir(), '.sp_publish_key'),
  path.join(os.homedir(), 'DDDD', 'Agent Work', 'stronghold-download-audit', 'recon', 'publish_key.txt'),
];

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : ''; };

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const hex32 = (file) => {
  const t = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(t)) throw new Error(`${file} 不是 64 位 hex（32 字节裸密钥）`);
  return Buffer.from(t, 'hex');
};
const publicKey = () => crypto.createPublicKey({ key: Buffer.concat([SPKI, hex32(PUB_FILE)]), format: 'der', type: 'spki' });
const privateKey = () => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, hex32(KEY_FILE)]), format: 'der', type: 'pkcs8' });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function loadDoc() {
  const file = opt('file');
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`${LIVE}?cb=${Date.now()}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`拉取线上清单失败 HTTP ${res.status}`);
  return res.json();
}

function describe(label, doc) {
  const payload = canonicalPayload(doc);
  let verdict = '✘ 没有 sig 字段（清单处于未签名状态）';
  if (typeof doc.sig === 'string' && doc.sig) {
    verdict = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey(), Buffer.from(doc.sig, 'base64'))
      ? '✔ 验签通过' : '✘ 验签失败（载荷或密钥不匹配）';
  }
  console.log(`${label}: ${Array.isArray(doc.servers) ? doc.servers.length : '?'} 条 | updated ${doc.updated || '-'} | keyId ${doc.keyId || '-'} | 载荷 sha256 ${sha(payload)}`);
  console.log(`  签名 ${verdict}`);
}

async function publish(signedDoc) {
  let key = process.env.PUBLISH_KEY || '';
  if (!key) for (const p of PUBLISH_KEY_FILES) { try { key = fs.readFileSync(p, 'utf8').trim(); break; } catch { /* next */ } }
  if (!key) throw new Error('缺发布口令：设 PUBLISH_KEY 或放一份到 ~/.sp_publish_key');
  const res = await fetch(PUT_URL, {
    method: 'PUT', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-key': key },
    body: JSON.stringify(signedDoc, null, 2) + '\n',
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(`发布失败 HTTP ${res.status} ${JSON.stringify(out)}`);
  console.log(`  已发布 ${out.count} 条（带 sig 的请求由服务端逐字节存，重排不会破坏签名）`);
  describe('回读复验', await loadDoc());
}

const doc = await loadDoc();
describe('现状', doc);

if (flag('publish') && !flag('sign')) throw new Error('--publish 必须与 --sign 同时使用（防止误发布未签名清单）');

if (flag('sign')) {
  if (!fs.existsSync(KEY_FILE) || !fs.existsSync(PUB_FILE)) throw new Error(`找不到密钥：${KEY_FILE} / ${PUB_FILE}`);
  const next = { ...doc };
  delete next.sig;
  delete next.unsigned;
  next.updated = new Date().toISOString();
  if (!next.keyId) next.keyId = 'sp-2026-10';
  if (typeof next.v !== 'number') next.v = 1;
  const payload = canonicalPayload(next);
  next.sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey()).toString('base64');
  const selfCheck = crypto.verify(null, Buffer.from(canonicalPayload(next), 'utf8'), publicKey(), Buffer.from(next.sig, 'base64'));
  console.log(`重签: 载荷 sha256 ${sha(payload)} | 自校验 ${selfCheck ? 'ok' : 'FAILED'}`);
  const out = opt('out');
  if (out) fs.writeFileSync(out, JSON.stringify(next, null, 2) + '\n');
  else if (!flag('publish')) process.stdout.write(JSON.stringify(next, null, 2) + '\n');
  if (flag('publish')) await publish(next);
}
