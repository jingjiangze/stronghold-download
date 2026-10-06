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

## 玩家评价「大杯 / 小杯」与打开点击数（2026-10-06）

**形态**：清单每行两个小按钮 —— **大杯 = 好评，小杯 = 差评**。两者**只调排序权重，永不决定某台显不显示**；
显示/隐藏仍然只有三样东西说话：边缘健康端点指纹、盒子那路看得见状态码的国内探测、站长停用（终审）。

```bash
curl -X POST https://dl.jiangjiangze.icu/api/servers/vouch -H 'content-type: application/json' -d '{"id":"<清单id>","verdict":"good"}'   # 大杯
curl -X POST https://dl.jiangjiangze.icu/api/servers/vouch -H 'content-type: application/json' -d '{"id":"<清单id>","verdict":"bad"}'    # 小杯
curl -X POST https://dl.jiangjiangze.icu/api/servers/vouch -H 'content-type: application/json' -d '{"id":"<清单id>","verdict":"clear"}'  # 撤回自己那张
curl -X POST https://dl.jiangjiangze.icu/api/servers/open  -H 'content-type: application/json' -d '{"id":"<清单id>"}'                    # 记一次「打开」跳转
curl -X POST https://dl.jiangjiangze.icu/api/servers/latency -H 'content-type: application/json' \
     -d '{"samples":[{"id":"<清单id>","ms":123}]}'                                                                                       # 批量交本机实测延迟
```

**排序 = 综合权重**（`js/servers.js`：`weightOf = 0.45×延迟 + 0.30×版本 + 0.25×评价`，三项各自归一到 0..1）：

- **延迟 45%**：用**共同延迟**（`verified.json.latency`），第一来源是**玩家反馈的中位数** —— 每轮测速跑完，
  浏览器把本机实测到的一整批延迟 `POST /api/servers/latency` 交上去（一次一批，不是每台一次），服务端按
  `sha256(ip|id|当天)` 去重存进 `site/latency.json`；verify 取中位数，**国内样本 ≥3 就只用国内的**
  （这站主要给国内玩家用，一个海外浏览器 300 ms 的样本不该把国内好服判成慢），不足则用全部样本，
  再没有才退回盒子的国内探测（6 小时内）与上一位玩家的单条回执（24 小时内）。
  归一化是**同批已测到的百分位**（最快 1、最慢 0、并列同档），所以"没测到"的 0.5 就是字面中位。，归一化是**同批已测到的百分位**（最快 1、最慢 0、并列同档），所以"没测到"的 0.5
  就是字面中位。本机自己测的那次只在共享值缺失时兜底；**延迟列里显示的仍是本机实测**（这一页对玩家的承诺）。
  为什么不能拿"各人测各人的"当主输入：顺序会随访客网络浮动，而且**测不到 = 没数据 = 被当成慢**。
  实测 28 条里 27 条本来就有盒子的小时级 ms（中位 246 ms），旧权重根本没读它 —— 于是 7 台本机没测到的
  （含 `http://` 条目在 https 页面浏览器不让发探测这种**纯协议限制**）全被压到列表底部。改成共享值之后
  它们回到第 7、8、10、11、13、15 名，其中两台因共享值 43/45 ms 直接进前 10%。
  只有"共享值和本机值都没有、且本机明确测到离线"才给负分。
- **版本 30%**：把当前这批里出现过的版本号排成 0..1（最高=1、最低=0）。**读不到版本的给 -0.2 罚分**
  （不是 0 分）—— 这样它即使延迟最好也压在最底下，保住"版本低的放到后面"那条硬要求。
- **评价 25%**：净分 `大杯-小杯` 过一道软饱和 `net/(|net|+4)`，±4 杯基本到顶/到底，
  免得刷十几杯把延迟和版本完全压过去。含你自己这一票。
- **测速途中冻结顺序**：每台测完都会 render 一次，不冻结的话行会一边出结果一边往前跳，玩家点不到
  自己想点的行；一轮跑完（`state.running=false`）再按新延迟重排。权重相同时保持清单原顺序（sort 稳定）。
- 每行的**悬浮提示**写明这个名次怎么算出来的（三项各自的分量），不占行内文字。

**这一天在这里来回过两次，别再走一遍**：① 先做成正向「我核验通过」一票即恢复展示 —— 同日取消，因为一个
没有事实核验的点击去推翻判据，迟早变成"谁点得勤谁上线"；② 再做成负向「进不去」两票即隐藏 —— 同日改成
只降权，因为单条「我连不上」多半是本地噪声（adblock、切网、页面没加载完、https 页面不让发 http 请求），
10-05 就有一条这种回执把当天最大的一台服（81 房/83 人）整条藏掉过。**往后挪是可逆的，藏掉是不可逆的。**

**边界**（`vouch.js`）：只接受签名清单里已存在的 id，地址/探针不接受访客输入 ⇒ 清单签名与条数不受影响
（`node tools/sign-servers.mjs` 复验）；`enabled === false` 一律 403；同一来源同一天同一台只能有一张票，
**大杯小杯互斥**（改投另一头自动撤掉原来那张），重复投同一向 429，`clear` 随时撤回；票 7 天过期。
按 `sha256(ip|id|当天)` 记名，**不存明文 IP**；写 R2 `site/vouches.json`，不占 KV 写额度。

**维护者口**（要 `x-admin-key: $PUBLISH_KEY`）：`{"id":"<id>","verdict":"purge"}` 清某一条的票（清单里已不
存在的孤儿票也清得掉，所以这一步走在清单查询之前），`"all":true` 清整本；`GET /api/servers/vouch` 读计数
台账（只有好/差/净分与最后时间，不含来源哈希）。匿名 purge 一律 403，无口令 GET 照旧 405。
**为什么一定要有这个口**：撤回只能撤"同一来源算出来的那一张"，而出口 IP 会漂（本机走代理就是这样，实测
一次 clear 没找回来、在小鹿宝上留了一张假票），所以清别人或自己漂掉的票只能靠 purge。

**前端对账**（"撤回后提示还在"那个 bug 的根因与解法）：`verified.json` 有 120 s 边缘缓存，所以本机动作
只有**时间戳晚于该条快照 `at`** 时才参与计算；撤回还必须记住撤的是哪一边（`{v:'clear', was:'good'|'bad'}`），
否则净分不知道要往回补多少、位置就卡住。**徽章类提示一律不做** —— 挂在行上的文字是甩不掉的，位置本身就是反馈。

**打开点击数**（`open.js`）：只统计次数、不当闸门；同一来源同一台 **10 秒内只算一次**（挡双击）；同样不存
明文 IP（16 位哈希只当时间窗键）。数字由 `verify.js` 并进 `site/verified.json` 的 `opens`，页面显示
「目前已点击 N 次」—— 少一个接口就少一次往返，在这条链路上很值钱。


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
