#!/usr/bin/env node
// tools/d1-put-blob.mjs — 把本地文件内容写进 D1 site_blob 表（R2 下线后的 CI/运维通道）。
// 用法：node tools/d1-put-blob.mjs <key> <file>
// 依赖：CLOUDFLARE_API_TOKEN（需 D1:Edit）；CLOUDFLARE_ACCOUNT_ID 可选（缺省用本账号 id）。
// 走 REST API（accounts/*/d1/database/*/raw），不经 wrangler —— Windows 上 npx+shell 的
// 引号转义会把带空格的 SQL 拆碎，REST 直调没有这个问题，CI 与本地行为一致。
const [key, file] = process.argv.slice(2);
if (!key || !file) {
  console.error('usage: node tools/d1-put-blob.mjs <key> <file>');
  process.exit(1);
}
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '8641802a2d46497f1cc4e7a4cba365d2';
const DB = 'bf884007-d536-49c8-b095-29c14cf1f9ec';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is required');
  process.exit(1);
}
import { readFileSync } from 'node:fs';
const value = readFileSync(file, 'utf8');
const lit = value.replace(/'/g, "''");
const sql =
  `INSERT INTO site_blob (key, value, updated_at) VALUES ('${key}', '${lit}', datetime('now')) ` +
  `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/raw`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ sql }),
});
const j = await res.json().catch(() => null);
if (!res.ok || !j || j.success !== true) {
  console.error('d1 put failed:', JSON.stringify((j && j.errors) || res.status).slice(0, 400));
  process.exit(1);
}
console.log(`put ${key} (${value.length} chars) -> site_blob`);
