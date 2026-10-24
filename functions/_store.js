// functions/_store.js — R2 → D1 blob 兼容层。
//
// 背景（2026-10-24）：R2 在账号层被禁用（CF API 报 10042），Pages 部署期校验 R2 绑定直接
// 失败，运行时所有 env.R2BUCKET 触点也全部失效（ranking 503 / rooms 500）。本层把原
// R2BUCKET 的全部用法搬到 D1 单表 site_blob，键空间与原 R2 对象键完全一致（site/*、
// scout/*），调用方只换 env 来源，不改读写语义。
//
// 语义对齐（2026-10-24 全量 grep 确认的事实边界）：
// - 原 R2BUCKET 只被 .get / .put 两种方法使用（无 head/list/delete）；
// - get 的返回值只被 .text() / .json() 消费（httpEtag / httpMetadata / body / size 零消费）；
// - put 的返回值零消费；put 的第三参（httpMetadata 等）收下但不落库 —— 原本 get 侧也不读它；
// - get 缺键返回 null（与 R2 一致），put 最后写赢（与 R2 一致）。
//
// 选 D1 不选 KV：玩家回执类端点（ping/latency/open/vouch）每请求整块读改写，KV 免费档
// 1000 写/天必被击穿；D1 免费档 10 万行写/天，余量充足。

const TABLE = 'site_blob';

export function blobStore(env) {
  const db = env && env.DB;
  return {
    async get(key) {
      if (!db) return null;
      const row = await db
        .prepare(`SELECT value FROM ${TABLE} WHERE key = ?1`)
        .bind(key)
        .first();
      if (!row || typeof row.value !== 'string') return null;
      const text = row.value;
      return {
        key,
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    },
    async put(key, value, opts) {
      if (!db) throw new Error('DB binding missing');
      const text = typeof value === 'string' ? value : String(value);
      await db
        .prepare(
          `INSERT INTO ${TABLE} (key, value, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(key, text, new Date().toISOString())
        .run();
      return { key, size: text.length };
    },
  };
}
