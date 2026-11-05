/* ==========================================================================================
   8910 反向代理 → arknights-gateway.jingjiangze.deno.net（盒子侧，Node 24 stdlib 零依赖）

   2026-10-13 用户令：域名 arknights.jiangjiangze.icu 下线，8910 指向 deno.net。
   于是把 8910 从「ark-admin 管理台」改为「到 deno.net 网关的反向代理」——
   盒子本机/局域网访问 http://127.0.0.1:8910 得到的即是 deno.net 那套网关（含后台）。

   为什么是反代而不是重定向：
     - 地址栏保持 127.0.0.1:8910（本机调试/脚本调用方便）；
     - POST 原样透传（/api/ingest、/api/feedback 都是 POST）；
     - 不产生跨域，客户端只跟 8910 说话。

   关键：**必须改写 Host 头**为 deno.net 域名 —— Deno Deploy 是按 Host 路由的，
   原样带 127.0.0.1:8910 会被判成未知站点（实测 404 DEPLOYMENT_NOT_FOUND）。

   用法：node proxy-8910.mjs   （由计划任务 SpArknightsProxy 常驻，无窗口）
   ========================================================================================== */

import http from 'node:http';
import https from 'node:https';

const TARGET = process.env.ARK_PROXY_TARGET || 'https://arknights-gateway.jingjiangze.deno.net';
const PORT = Number(process.env.ARK_PROXY_PORT || 8910);
const HOST = process.env.ARK_PROXY_HOST || '127.0.0.1';
const TARGET_HOST = new URL(TARGET).host;

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', TARGET);

  // 逐字段构造转发头：Host 换成目标域（Deno 按 Host 路由），其余原样带过。
  const headers = { ...req.headers };
  headers.host = TARGET_HOST;
  // 让目标端能看出真实来源（便于排障），但不影响路由。
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = 'http';

  const upstream = https.request({
    protocol: 'https:',
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: req.method,
    headers,
    agent,
    timeout: 30000,
  }, (up) => {
    // 透传状态与响应头（含 set-cookie / content-type / cache-control）
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });

  upstream.on('timeout', () => {
    upstream.destroy(new Error('upstream timeout'));
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`反代失败（${TARGET}）：${err.message}`);
  });

  // 请求体原样透传（POST/PUT 都靠这条）
  req.pipe(upstream);
});

server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`[ark-proxy] ${HOST}:${PORT} -> ${TARGET} (Host 改写为 ${TARGET_HOST})`);
});