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
wrangler pages deploy . --project-name=stronghold-download --branch=main
```

**版本策略：页面只提供最新版 APK 的下载链接，不保留、不展示任何旧版本**
（快照里只有一个 release，且只有 `.apk` 资产；R2 模板镜像的 `tags` 只放当前 tag）。

## 服务器清单：提交 → 审核 → 本机重签

清单是 Ed25519 签名文档（`v` / `keyId` / `updated` / `note` / `servers` / `sig`），私钥只在本机 `~/.sp-sign/`，
**任何服务端都不持有**。三步：

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
