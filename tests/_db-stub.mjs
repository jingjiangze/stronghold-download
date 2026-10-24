// tests/_db-stub.mjs — 内存版 D1 stub，形状对齐 functions/_store.js 用到的两个语句：
//   SELECT value FROM site_blob WHERE key = ?1   → .first()
//   INSERT INTO site_blob ... ON CONFLICT ...    → .run()
// 用法：const env = { ..., DB: makeDb(store) }; 之后 blobStore(env) 就走这份内存数据。
export function makeDb(store, { onPut } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (!/SELECT/.test(sql)) return null;
              const k = args[0];
              return store.has(k) ? { value: store.get(k) } : null;
            },
            run: async () => {
              if (/INSERT INTO site_blob/.test(sql)) {
                store.set(args[0], args[1]);
                if (onPut) onPut(args[0], args[1]);
              }
            },
          };
        },
      };
    },
  };
}
