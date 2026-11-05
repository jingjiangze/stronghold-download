# 盒子上跑的 admin-only 恢复服务（arknights.jiangjiangze.icu/admin）

用户 2026-10-13 指令的交付物：站点原 CF Worker 已被删、域名 NXDOMAIN；本服务在**盒子**上把
`/admin` 恢复起来，**只读魔搭（ModelScope）那台游戏服的数据**，并顺带把游戏服每 60 秒拉取的
公告链路（`GET /api/announcements/game`）接回来。不含另外三个服务器的数据（旧站的 probe/channels
面板不在这里）。

## 为什么是盒子

- 网关整体迁移（Deno / EdgeOne 评估）在另一条线（`deno/`）上推进；本服务是**快恢复**：
  盒子已有 Node 24 + 常驻隧道 `wk-platform`，把 `127.0.0.1:<port>` 挂到域名即可。
- 不新增平台账号、不用 CF Workers（用户口径：不划算）。

## 跑法（盒子上）

```bat
git pull            & rem 或首次 clone 本仓
cd box-admin
copy config.example.json config.json   & rem 填 ingestToken / msToken
node server.mjs                        & rem 默认 127.0.0.1:8910
```

- `config.json`（**已 gitignore，永不入库**）：`{ "ingestToken": "...", "msToken": "...", "port": 8910 }`
- 令牌来源：`INGEST_TOKEN` = 旧站管理令牌（盒子 `box/config.json` 的 `ingestToken`，48 字符）；
  `msToken` = 魔搭平台令牌（`stronghold-server` 的 `ms` git 远端里那份）。

## 接口（与旧网关逐字段一致，别改形状）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/announcements/game` | 公开 | **裸数组**（游戏服 `SP_ANNOUNCEMENTS_URL` 每 60s 拉的就是它） |
| GET/PUT | `/api/announcements/game/admin` | Bearer | 读带回执；PUT 整体替换（数组或 `{entries}`），校验常量与旧实现一致 |
| GET | `/api/settings/game` | 公开 | `{ ok, hotMods, updatedAt, updatedBy }` |
| PUT | `/api/settings/game` | Bearer | `{ hotMods: boolean }` |
| GET | `/api/game/status` | Bearer | 魔搭 health（占用/版本/开销）+ 平台侧 commit 对比 |
| POST | `/api/game/redeploy` | Bearer | 占用不为 0 → 409；否则 `PUT reset_restart` |
| GET | `/admin` | 页面 | 自包含管理页（令牌存 localStorage） |

## 数据落点

`data/announcements.json`（`{ updatedAt, entries }`）、`data/settings.json` —— 均 gitignore；
公告的对外形状与 `normalizeAnnouncement` 规则照抄旧网关（50 条 / 标题 120 / 正文 40 段 / 总 200k 字）。
