#!/usr/bin/env node
// tools/d1-get-blob.mjs — 从 D1 site_blob 表读一个键到本地文件（R2 下线后的 CI/运维通道）。
// 用法：node tools/d1-get-blob.mjs <key> <out-file>
// 退出码：0 = 读到并写出；3 = 键不存在；1 = 查询/网络失败。
// 依赖：CLOUDFLARE_API_TOKEN（需 D1:Read）。走 REST API，理由见 d1-put-blob.mjs 头注释。
const [key, out] = process.argv.slice(2);
if (!key || !out) {
  console.error('usage: node tools/d1-get-blob.mjs <key> <out-file>');
  process.exit(1);
}
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '8641802a2d46497f1cc4e7a4cba365d2';
const DB = 'bf884007-d536-49c8-b095-29c14cf1f9ec';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is required');
  process.exit(1);
}
import { writeFileSync } from 'node:fs';
const sql = `SELECT value FROM site_blob WHERE key = '${key.replace(/'/g, "''")}'`;
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/raw`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ sql }),
});
const j = await res.json().catch(() => null);
if (!res.ok || !j || j.success !== true) {
  console.error('d1 get failed:', JSON.stringify((j && j.errors) || res.status).slice(0, 400));
  process.exit(1);
}
const rows = (j.result && j.result[0] && j.result[0].results) || {};
// raw 端点行格式是 {columns, rows: [[v1, ...], ...]}（非对象数组）
const valueIdx = Array.isArray(rows.columns) ? rows.columns.indexOf('value') : -1;
const firstRow = Array.isArray(rows.rows) ? rows.rows[0] : null;
if (valueIdx < 0 || !firstRow || typeof firstRow[valueIdx] !== 'string') {
  console.error(`no blob for key ${key}`);
  process.exit(3);
}
writeFileSync(out, firstRow[valueIdx], 'utf8');
console.log(`got ${key} (${firstRow[valueIdx].length} chars) -> ${out}`);
