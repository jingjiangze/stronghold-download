// Pages Function: GET /servers.json
// 客户端（APK / shell、第三方工具）按这个地址取服务器清单。以前这个路径没有对应文件，
// 被 SPA 回退接管返回 HTML —— 客户端 JSON 解析失败，于是把已经收录的服务器显示成
// 「不在清单列表」。这里直接吐 R2 里那份现网清单（带签名），并在 R2 不可用时
// 退回打包在站点里的快照。

const LIST_KEY = 'site/servers.json';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'access-control-allow-origin': '*',
};

export async function onRequestGet(context) {
  const { env, request } = context;
  try {
    if (env.R2BUCKET) {
      const obj = await env.R2BUCKET.get(LIST_KEY);
      if (obj) return new Response(await obj.text(), { status: 200, headers: HEADERS });
    }
  } catch { /* 落到快照 */ }
  try {
    const snap = await fetch(new URL('data/servers.json', request.url));
    if (snap.ok) return new Response(await snap.text(), { status: 200, headers: { ...HEADERS, 'x-list-source': 'snapshot' } });
  } catch { /* 下面统一报错 */ }
  return new Response(JSON.stringify({ ok: false, error: 'list unavailable' }), { status: 503, headers: HEADERS });
}
