# 卫戍协议：盟约 · 客户端下载站

静态单页（零构建、零后端），外观与游戏客户端首页一致，只保留下载按钮。
部署在 Cloudflare Pages（主站：https://dl.jiangjiangze.icu）与 GitHub Pages（镜像）。

## 结构

```
index.html            页面（复用游戏客户端自身的 CSS 与字体）
css/ js/ fonts/       从游戏客户端复制的样式、脚本与字体 + dl.css / download.js
data/releases.json    离线快照（API 不可达时的兜底）
data/mirrors.json     镜像清单（可热更新，无需改代码）
tools/gen-snapshot.mjs 重新生成 releases.json
_headers              CF Pages 缓存策略
```

## 更新流程

版本发布后：

```bash
node tools/gen-snapshot.mjs          # 刷新离线快照（只写最新一个 release 的 APK）
node tools/deploy.mjs                # 构建 staging 并上线（等价于加 --dry 只看清单）
```

**别再用 `wrangler pages deploy .` 直传本目录**：那条通道会把工作目录里的每个文件都烤进
deployment，而实测 `.assetsignore` 对它无效（连自己都在文件里却仍返回 200）—— 于是
README、`wrangler.toml`、`.github/workflows/*`、`tools/*`、`.mimosa/**` 和任何调试输出都会
变成线上可下载的文件。`tools/deploy.mjs` 只上传这 35 个真正对外的文件。

**版本策略：页面只提供最新版 APK 的下载链接，不保留、不展示任何旧版本**
（快照里只有一个 release，且只有 `.apk` 资产；R2 模板镜像的 `tags` 只放当前 tag）。

## 服务器清单：提交 → 审核 → 本机重签

清单是 Ed25519 签名文档（`v` / `keyId` / `updated` / `note` / `servers` / `sig`）。私钥有两份：
本机 `~/.sp-sign/`，以及自动上线用的 Cloudflare Worker secret（`stronghold-scout` 的
`SP_SIGN_KEY`，`keyId=sp-2026-10`）—— 能控制那个 CF 账号或那个 Worker 的人都能签出客户端
接受的清单；回收办法是换新密钥对 + APK 内置多公钥并把旧 keyId 标废弃。三步：

```bash
# 0) 访客/自动脚本提交（只进 KV 队列，不发布；服务端会先做一次 /healthz 指纹校验）
curl -X POST https://dl.jiangjiangze.icu/api/servers/submit -H 'content-type: application/json'      -d '{"servers":[{"name":"某某服","url":"https://example.org","note":"来源说明"}]}'

# 1) 维护者看队列 / 点通过（admin 页，或直接调函数）
curl -H "x-admin-key: $PUBLISH_KEY" https://dl.jiangjiangze.icu/api/servers/submit   # 列队列
curl -X POST -H "x-admin-key: $PUBLISH_KEY" -H 'content-type: application/json'      -d '{"id":"<队列id>","action":"approve"}' https://dl.jiangjiangze.icu/api/servers/review
# 2) approve 会把这条并入清单并**作废签名**（标 unsigned），随后本机补签发布：
node tools/sign-servers.mjs                      # 看现状（验签/未签名）
node tools/sign-servers.mjs --sign --publish     # 重签并发布，发布后自动回读复验
```

签名规则与 `functions/api/_verify.js` 的 `canonicalPayload()` 同源：去掉 `sig`/`unsigned`，
对象键递归按字典序、数组顺序不变、无多余空白；**`updated` 参与签名**，所以手改时间戳必然验不过。
`review` 的响应里带 `canonicalSha256`，和本机签名器打印的 sha 一致就说明签的是同一份。

## 公开房间中转 `GET /api/rooms`

各家门户的房间接口**都不给 CORS**，浏览器跨源读不到，所以由边缘代取后归一：

| 上游 | 形状 | 预检 |
| --- | --- | --- |
| `game.rainya.me/api/rooms` | 新契约 `{demo, rooms:[siteId/server/code/url/status/free/ageSec/leftSec/mode/difficulty/difficultyName/capacity/occupied/humans/round]}`（旧的 `{ok,now,ttlSec,rooms}` 已换掉） | OPTIONS **403**，无 ACAO |
| `stronghold.lunar.ag`、`xn--rlr.rinko.ai` 的 `/api/rooms?cursor=` | `{items, nextCursor}`，字段另有 `roomId/hostName/connectedHumans/spectatorCount/inMatch`；入房是**房主审批制** | OPTIONS 405，无 ACAO |
| `sp-lobby.jiangjiangze.icu/api/rooms` | 旧契约 `{ok,now,ttlSec,rooms}` | ACAO `*`（本仓自建，不需要中转） |

`functions/api/rooms.js` 按**签名清单**里的条目逐个试 `<origin>/api/rooms`（注意 raiya 的 `url` 带 `/play`，
直接拼会打到 `/play/api/rooms` → nginx 502，所以这里按 origin 重拼），三种形状都吃，
`code`/`roomId`、`humans`/`connectedHumans` 归一到同一个字段名，输出
`{ok, now, ttlSec, listUpdated, rooms[], sources[], scannedThisRound, fullScan}`，带 `Access-Control-Allow-Origin: *`。

节奏：结果写 R2 快照 `site/rooms.json`，**20 秒内直接回快照**，过期则先回旧快照再用 `waitUntil` 后台补一轮
（`x-rooms-cache: hit|stale|miss` 看得出走了哪条）；快档只扫上次应答过的源，**每 30 分钟或清单变更才全量重扫**。
这么做的理由：Functions 的响应不走边缘缓存（实测两次都 `cf-cache-status: DYNAMIC`），全量扫 17 台冷启动 ≈6.7 s，
而大厅是 15 s 轮询 —— 每个访客触发一轮等于替所有访客去轰玩家的服务器（≈13 万次/天）。
`?id=<清单条目>` 只看一台（不写快照），`?fresh=1` 手动强制全量重扫。只取第一页，不跟随 `nextCursor`。

## R2 首方镜像

`data/mirrors.json` 里 `r2` 条目使用模板
`https://weishucdn.jiangjiangze.icu/releases/{tag}/{name}`，
只有当 `tags` 数组包含当前 tag 时该镜像才会显示（**数组里只放当前 tag**）。
把新版本 APK 上传到 `stronghold-assets` 桶的 `releases/<tag>/` 前缀后，把 tags 改成这一个 tag、
删除旧 tag 前缀的对象并重新部署即可。旧版本对象用 CF API 的 list+delete 清理（见
`../stronghold-download-audit/审计方案.md` §10.3）。

## 镜像清单维护

公共加速器洗牌频繁（实测 8 个域名已失效）。只改 `data/mirrors.json`：
`prefix` 模式会把 GitHub 资产地址拼在 `prefix` 后面；`template` 模式替换
`{tag}` / `{name}`。页面会对每个链接做 https + 主机白名单校验，白名单直接由
清单里的域名生成。
