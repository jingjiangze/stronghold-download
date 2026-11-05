# arknights-gateway — 卫戍协议 · 盟约 三通道入口页

线上地址：<https://arknights.jiangjiangze.icu/>（明日方舟英文 = Arknights，用户指定的子域）

同一台游戏服的三条网络通道整理成一个入口页：实时显示每条通道的在线状态、
**由玩家浏览器实测的延迟**，以及这台服务器的八项实时数值（在线玩家 / 会话 / 房间 / 对局 /
连接 / 运行时长 / 内存占用 / CPU 占用），点一下就进游戏。

- 布局：照 `game.rainya.me/#announcements-section`（顶栏 + hero + 公告轮播/游玩提醒
  双栏 + 通道卡片 + 游玩指南 + 关于 + 页脚，含公告的轮播 / 圆点 / 展开 / 历史弹窗）。
- 视觉：沿用 `dl.jiangjiangze.icu` 的 `theme.css` / `components.css` / `screens/title.css`
  （原样 vendored，见下），配 dl 标题屏的雷达 + 山脊背景。
- 站内**不向任何第三方发请求**：延迟由玩家浏览器对自己所选通道做 no-cors 连接计时获得，
  没有服务端/第三方的延迟探测；样式与字体全部自托管。

## 结构

```
public/                  静态站点（Worker 的 ASSETS 目录）
  index.html             单页
  css/theme.css          ← vendored 自 dl 站（design tokens + 背景 + 排版小工具）
  css/components.css     ← vendored 自 dl 站（.btn / .panel / .brackets / .micro …）
  css/screens/title.css  ← vendored 自 dl 站（雷达 + 山脊 + 辉光背景）
  css/gate.css           本页布局（公告/通道/我的服务器/指南/关于/页脚）
  js/gate.js             通道卡片 + 状态轮询 + 玩家自测延迟 + 顶栏滚动高亮
  js/notices.js          公告轮播 + 历史弹窗（rainya 的交互逻辑移植）
  admin.html             服务器后台（/admin）：实时状态全字段表 + 游戏服公告管理
  css/admin.css          后台私有增量（gk- 前缀）；布局/面板/按钮全部复用上面的
  js/admin.js            状态表（表头按真实通道动态生成）+ 公告 CRUD（草稿存 localStorage）
  data/channels.json     ★ 通道清单唯一真源（前端和 Worker 都读这份）
  data/announcements.json  公告与历史归档（本地静态，无外部请求）
  fonts/                 ← vendored 自 dl 站（woff2 自托管）
src/index.js             Worker：静态资源（补缓存头 + 安全头）+ /api/status + /api/ingest + /api/lobby
wrangler.jsonc           Worker 配置 + arknights.jiangjiangze.icu 自定义域名
tools/check.mjs          部署前静态检查（子资源/外链白名单/类名冲突/字体/JSON/语法）
tools/verify.mjs         线上/本地浏览器核验（需要 ~/tools/pwshot 的 playwright）
box/                    盒子（服务器本机）侧采集与部署脚本
  probe.mjs             本机读 /healthz + 进程采样后回传（5 分钟一轮）
  proc-stat.ps1         按当前活着的槽进程采样内存/CPU
  push.mjs / *.ps1      静默无窗口推送与计划任务安装
```

## 三条通道（2026-10-09 审计结论）

| 通道 | 源 | 证书 | 服务端探测 |
| --- | --- | --- | --- |
| 主通道 · 卫戍云 | `https://weishu.jiangjiangze.icu` | Let's Encrypt *.jiangjiangze.icu，有效 | ✅ |
| 备用 1 · NYAT | `https://www.u712507.nyat.app:45038` | ZeroSSL *.u712507.nyat.app，有效至 2026-12-31 | ✅ |
| 备用 2 · SakuraFRP | `https://frp-box.com:38916` | **自签名**（SakuraFrp Automatic TLS，SAN 是 dx.frp-box.com） | ❌ |

- 三条通道的 `/healthz` 返回同一份状态（同 build、同 uptime）→ 是**同一台服务器**的三条网络路径。
  前端在「我的服务器」里只显示一份服务器级数值，通道卡不重复人数/房间/运行时长。
- 备用 2 的证书链不受信任且主机名不匹配（SAN 是 dx.frp-box.com）：浏览器打开会先弹证书警告，
  且玩家第一次自测延迟会因 TLS 握手失败而显示「不通」。卡片已如实提示「先点进入游戏接受一次证书」。
- **延迟是玩家浏览器自测的**：页面用 `fetch(origin + /healthz, {mode:'no-cors'})` 计时
  （3 次取中位数），代表玩家自己网络到该通道的真实往返。这条不再消耗任何服务端/第三方探测额度。

## /api/status（盒子回传 → Worker 转发）

游戏服的 `/healthz` 不带 CORS 头，浏览器读不到——而且三条通道其实是同一台服务器的三条路径，
让 CF 每次请求都出去探一遍纯属重复开销；其中自签名那条，Workers 的 fetch 会校验证书链且无法关闭，
永远探不到。所以改为**盒子（服务器本机）每 5 分钟读一次 `127.0.0.1:3000/healthz` + 进程采样，
回传给 Worker 存进 KV**，前端只跟本站说话。

- 盒子读的是 **3000 端口**（nginx 稳定入口，恒指向当前活着的那一槽）；3001/3002 是蓝绿两个槽，
  更新时来回切，不能写死。
- 内存/CPU 不在 `/healthz` 里，由 `proc-stat.ps1` 按 `update/active_slot.json` 找到当前活动槽的
  node 进程后采样工作集与 1.2 秒窗口 CPU；采不到就给 null，页面显示 `—`。
- 回传内容一律过白名单（`sanitizeProbeChannel`）再进 KV，盒子被攻陷也塞不进任意内容。
- 快照超过 15 分钟没更新就当作过期，前端如实标「状态未取」，不会拿旧数据冒充实时。

`GET /api/status` 返回 `{ ok, channels[], visitor{country,region,city} }`：
- `channels[]` 每个含在线状态、app/build/uptime、humans/bots/sessions/sockets/rooms/matches/
  spectators、以及内存 `memRssMb`、CPU `cpuPct`；
- `visitor` 由 Cloudflare 按访问 IP 给出（`request.cf`），页面据此标注「你的地区」。

## /api/ingest（盒子回传入口）

```
盒子 probe.mjs ──POST /api/ingest（Bearer 令牌）──> Worker ──> KV(NODES)
页面 ──GET /api/status───────────────────────────────────────┘
```

- 令牌在 Worker secret（`INGEST_TOKEN`）；盒子侧放 `box/config.json`（已在 .gitignore）。
- 只接受 `collector === 'box-probe'` 的负载，且每个字段都过白名单。

## /api/lobby（线上大厅 — 房间牌只读代理）

游戏服本身不暴露任何房间列表接口（只有 `/healthz` 聚合计数），真正的房间牌在另一个 Worker：
`sp-lobby.jiangjiangze.icu`（玩家建房后登记，10 分钟有效，CORS `*`）。

本 Worker 只做一个**同域缓存代理**：`GET /api/lobby` 后端拉 `sp-lobby.jiangjiangze.icu/api/rooms`，
白名单裁剪字段后返回，并做 20 秒边缘缓存。前端仍然只跟本站说话，CSP 不用放开第三方。

页面拿到房间码后，点「加入」会先算三条通道里**你这边延迟最低且在线**的那一条，
然后带上 `?room=CODE` 跳转到该通道。三通道是同一台服，房间码格式一致，
所以只需要换前缀即可。

## 延迟是怎么来的（玩家浏览器自测）

卡片上的「你的延迟」由玩家浏览器现场测，服务端零参与：

1. 页面加载后，对每条通道的 origin 发 `fetch(origin + /healthz?_p=随机, {mode:'no-cors', cache:'no-store'})`；
2. 用 `performance.now()` 计时，取 3 次中位数作为该通道的「你的延迟」；
3. 切到后台（`document.hidden`）时停测，回前台再测，避免占用玩家流量。

口径：这是**玩家自己网络到该通道**的真实往返（含 HTTPS 握手），不代表别的地域；
页面不读取、也不上报任何设备/网络信息。CSP 的 `connect-src` 因此要放行三通道 origin
（`cspFor()` 在 Worker 里按 `channels.json` 动态拼接进 `connect-src 'self' <origins>`）。

## 部署

```bash
cd arknights-gateway
node tools/check.mjs      # 静态检查
npx wrangler deploy       # assets + 自定义域名一起上
```

wrangler 会自动为 `arknights.jiangjiangze.icu` 建 DNS 记录并签发证书
（`workers_routes` 权限即可，不需要 DNS 写权限）。自定义域名加好后 workers.dev
域仍保留作后备（`workers_dev: true`）。

### 改了东西要 bump 版本号

`index.html` 引用 `gate.css?v=N` / `gate.js?v=N`，css/js 路径在 Worker 里是
`max-age=31536000, immutable` —— 改内容必须 bump `?v=`，否则老访客一年内看不到更新。
HTML 本身是 `max-age=0, must-revalidate`（靠 ETag 做 304）。频道数据在 `data/`（300s + SWR），
前端用 `no-cache` 拉取。**后台页同理**：`admin.css?v=N` / `admin.js?v=N` 也是 immutable。

### 静态资源别手动 scp

`run_worker_first: true` 之后，`ASSETS` 绑定只认 `wrangler deploy` 上传的那份，
直接改线上文件不会生效；`_headers` 也不被静态资源继承，缓存头全在 `cacheControlFor()` 里写死。

## 维护注意（踩过的坑）

0. **SSH 链路会断**：`Connection closed by UNKNOWN port 65535` 是这条链路的常态，
   脚本要带重试。**scp 几乎必断**，改用 `powershell ... -Command -` 的 stdin 管道传 base64。
   命令里不要写 `&`（会被本地 bash 当后台），也不要内联复杂引号。
1. **类名冲突**：vendored 的 `components.css` 里有游戏内顶栏 `.topbar`
   （`display: grid; height: 1.1rem`，还带 `::after` 渐变线）。本站顶栏必须用
   `.gk-topbar` / `.gk-topbar-inner`，不要改回 `.topbar`。`tools/check.mjs` 会拦这类冲突
   （有意复用的类在 `REUSED` / `REUSED_PREFIXES` 白名单里）。
   这个检查扫 `public/` 下**所有** html，新增页面自动受约束 —— 以前只扫 `index.html`，
   `admin.html` 因此绕过了这道门很久。
2. **`.app-bg` 要压到 `z-index: -1`**：theme.css 的 `.app-bg` 是不透明的全屏背景层，
   `position: fixed; z-index: 0` 会盖住一切**非定位**的静态内容（公告标题行就是这样消失的；
   dl 站没事是因为它的内容层都有 `z-index: 1`）。
3. **`.brand-text` 别改成 flex 列**：文本节点在 flex 容器里各自成为匿名 flex 项，
   「卫戍协议 · 盟约」会被拆成三行。用 `block` + `small { display: block }`。
4. wrangler 4.138.0 本地 workerd 只支持到 `compatibility_date = "2026-09-28"`，
   配置里钉这个日期，别随手往上加。

## 盒子侧部署（probe.mjs，静默无窗口）

```bash
# 1) 推送文件（scp 在这条链路上会断，走 ssh 的 stdin 管道）
cd box && node push.mjs probe.mjs proc-stat.ps1 config.json
ssh wbssh 'powershell -NoProfile -NonInteractive -Command -' < push-bundle.ps1

# 2) 装静默常驻计划任务（AtStartup + 每 5 分钟重复，S4U 不需登录，无窗口）
ssh wbssh 'powershell -NoProfile -NonInteractive -Command -' < install-probe-task.ps1

# 3) 看状态
ssh wbssh 'powershell -NoProfile -NonInteractive -Command -' < status.ps1
```

计划任务 `SpChannelProbe` 每 5 分钟跑一次 `probe.mjs`，日志在 `D:\web\spbox\logs\probe.log`。
旧设计里的 `SpNodeCollector` 任务（小时级 Globalping 采集器）已停止并清理——延迟改为玩家自测后
不再需要任何服务端探测。

## 本地核验

```bash
npx wrangler dev --port 8788
# 浏览器核验（截图 + 控制台错误 + 第三方请求白名单（只允许站点自身 + 三通道 origin）+ 公告交互 + 卡片状态 + 我的服务器八项数值 + 线上大厅区块）
node tools/verify.mjs http://127.0.0.1:8788/ arkgate-local
# 部署后逐文件核对线上字节（immutable 资源被边缘钉住旧内容时能立刻发现）
node tools/check-live.mjs
node tools/verify.mjs https://arknights.jiangjiangze.icu/ arkgate-live
```

核验脚本会强制 Chromium 直连（`--proxy-server=direct://`），因为本机 Clash 的系统代理会把
`*.jiangjiangze.icu` 之外的连接路由到不可用节点（超时）。
