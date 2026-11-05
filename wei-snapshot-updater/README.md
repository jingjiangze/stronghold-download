# wei-snapshot-updater

wei.jiangjiangze.icu 服务器列表「静态快照」的自动更新器。

## 为什么存在
实时 API（Pages Functions）依赖 Cloudflare 运行时；CF 故障时（如 2026-10-20 账号级 Functions 失效）
前端会回退到 `public/data/servers-snapshot.json` 静态快照。本仓让这份快照保持 ≤30 分钟新鲜，
且**不使用任何 Worker/Function**（纯静态文件）。

## 数据链路（保底顺序）
1. 实时 API（CF 恢复后自动回到这层）
2. 浏览器 localStorage 缓存（24h）
3. **本仓维护的静态快照** ← 这里
4. （不做玩家端探测——https 页面 fetch 国内 http 服会被混合内容墙拦）

## 工作方式
GitHub Actions 每 10 分钟：拉上游（主源 `http://121.4.51.247`，备源域名）→ 数据有变化才 commit → wrangler 全量部署到 Pages（文件总量 ~90KB，全量部署开销可忽略）。

## Secrets
- `CF_API_TOKEN`：Pages 部署权限的 CF API Token
- `CF_ACCOUNT_ID`：CF 账户 ID
# repo: wei-snapshot-updater
