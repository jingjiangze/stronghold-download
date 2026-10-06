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

## 玩家匿名举报「进不去」与打开点击数（2026-10-06）

同一天先加了"未核服务器的匿名核验"，**同日又取消了正向票**（站长的决定）：一个没有事实核验的
点击去推翻判据，迟早变成"谁点得勤谁上线"。现在只剩两件事：

```bash
curl -X POST https://dl.jiangjiangze.icu/api/servers/vouch -H 'content-type: application/json' -d '{"id":"<清单id>","verdict":"bad"}'    # 报告进不去
curl -X POST https://dl.jiangjiangze.icu/api/servers/vouch -H 'content-type: application/json' -d '{"id":"<清单id>","verdict":"clear"}'  # 撤回自己那张
curl -X POST https://dl.jiangjiangze.icu/api/servers/open  -H 'content-type: application/json' -d '{"id":"<清单id>"}'                   # 记一次「打开」跳转
```

**负向票**（`vouch.js` + `verify.js`）：

- 门槛是 **2 个不同来源**才隐藏一行。不是不信任玩家 —— 单条「我连不上」多半是本地噪声
  （adblock、切网、页面没加载完、https 页面不让发 http 请求），10-05 就有一条这种回执把当天最大
  的那台服（81 房/83 人）整条藏掉过。投完按钮会明确说"还差几个"。
- 只翻**显示**，不翻**准入**：只接受签名清单里已存在的 id，地址/探针不接受访客输入，所以清单的
  签名与条数不受任何影响（`node tools/sign-servers.mjs` 可复验）。
- `enabled === false`（站长停用）硬拒 403 —— 停用是终审；当前已不显示的拒 409（这一票改变不了
  什么），但**自己今天已有票的人改投/撤回永远允许**（分区快照可能滞后 120 s，不能拿它挡人）；
  同一来源同一天同一台只有一张票，重复投 429。
- 票 **7 天**过期；`verify.js` 把靠票隐藏的条目记进 `verified.json` 的 `player_state`，所以
  撤回 / 管理页 purge / 过期都能**当场**回前台，不用等下一轮真探（那是 30 分钟）。
- 按 `sha256(ip|id|当天)` 记名，**不存明文 IP**；写 R2 `site/vouches.json`，不占 KV 写额度
  （旧文件里的正向 `ok`/`ips` 桶在任何一次写入时被裁掉）。
- **维护者口**（要 `x-admin-key: $PUBLISH_KEY`）：`{"id":"<id>","verdict":"purge"}` 清某一条的票
  （清单里已不存在的孤儿票也清得掉，所以这一步走在清单查询之前），`"all":true` 清整本；
  `GET /api/servers/vouch` 读计数台账（只有票数与最后时间，不含来源哈希）。匿名 purge 一律 403，
  不带口令的 GET 照旧 405。
  **注意**：撤回只能撤"同一来源算出来的那一张"，而出口 IP 会漂（本机走代理就是这样），
  所以要清别人或自己漂掉的票只能走 purge。

**打开点击数**（`open.js`）：只统计次数、不当任何闸门。同一来源同一台 **10 秒内只算一次**（挡双击），
同样不存明文 IP（16 位哈希只当时间窗键）。数字由 `verify.js` 并进 `site/verified.json` 的 `opens`，
页面显示成「目前已点击 N 次」—— 少一个接口就少一次往返，在这条链路上很值钱。

## 清单页的缓存口径（2026-10-06 定，别再改回 5 分钟）

`_headers` 里 `/js/*`、`/css/*` 是 `max-age=31536000, immutable`，因为**页面引用一律带 `?v=`**
（`servers.html` / `admin.html` 里那几个数字）—— 改了内容必须同时 bump 版本号，否则玩家拿的还是旧脚本。
以前是 `max-age=300, must-revalidate`，等于让每个访客每隔几分钟重拉 43 KB 的 `servers.js`，而实测
这条链路单次要 2–26 秒（本机走代理），这就是"清单加载很慢"的最大一项。

另外两条实测事实别指望：边缘缓存拿不到（`weishucdn…/site/*.json` 与同源 `/data/*.json` 连打都是
`cf-cache-status: DYNAMIC`，且没有 zone 写权限）；R2 域名带 query 会废掉 Range。所以首屏改成
**先用打包快照 `data/servers.json` 立刻渲染、后台再取 R2 现网值**，浏览器测速也限到 4 路并发
（原来一次把 29 台全铺开 ≈116 个请求，和页面自己的资源抢同一条隧道）。
`data/servers.json` 只是兜底，**要定期从现网原样覆盖**（保留签名字节）：

```bash
curl -s https://weishucdn.jiangjiangze.icu/site/servers.json -o data/servers.json && node tools/sign-servers.mjs
```


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
