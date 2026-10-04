// Pages Function: PUT /api/servers
// Publishes the hot server list (site/servers.json in bucket stronghold-assets).
//
// Auth: the caller must send header `x-admin-key` matching the PUBLISH_KEY secret
// (set with `wrangler pages secret put PUBLISH_KEY --project-name=stronghold-download`).
// The key is never embedded in any page source.
//
// Validation before the write (the list is served to every visitor's browser, so a
// hostile entry would make them scan intranets):
//   - body must be JSON with a servers array (≤ 64 entries);
//   - every entry: id/name/url strings; url must parse as public http(s), no credentials,
//     no localhost/loopback/private/link-local/reserved hosts;
//   - probe, when present, must be a relative path (leading "/");
//
// R2 access uses the Pages R2 binding declared in wrangler.toml (binding name R2BUCKET).

const BUCKET = 'R2BUCKET';
const LIST_KEY = 'site/servers.json';
const MAX_ENTRIES = 64;
const MAX_BODY_BYTES = 256 * 1024;

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
                    /^172\.(1[6-9]|2[0-9]|3[01])\./];

function isUnsafeHostname(raw) {
  const h = String(raw || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
    return false;
  }
  if (h === '0.0.0.0') return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

function validateUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return { error: 'unparseable url' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'scheme' };
  if (url.username || url.password) return { error: 'credentials' };
  if (isUnsafeHostname(url.hostname)) return { error: 'private host' };
  url.search = ''; url.hash = '';   // 深链 ?room= 不算另一台服务器
  return { href: url.href.replace(/\/+$/, '') || url.href, host: url.host };
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8',
                             'cache-control': 'no-store' }, extra || {})
  });
}

export async function onRequestPut(context) {
  const { request, env } = context;

  const key = request.headers.get('x-admin-key') || '';
  if (!env.PUBLISH_KEY || !key || key !== env.PUBLISH_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const bucket = env[BUCKET];
  if (!bucket) return json({ ok: false, error: 'R2 binding missing' }, 500);

  const raw = await request.text();
  if (!raw.length || raw.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'body size' }, 400);
  }

  let doc;
  try { doc = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!doc || !Array.isArray(doc.servers)) {
    return json({ ok: false, error: 'servers[] required' }, 400);
  }
  if (doc.servers.length > MAX_ENTRIES) {
    return json({ ok: false, error: 'too many entries' }, 400);
  }

  // 防「拿旧快照整份覆盖」：签过名的清单一旦被较旧的文档覆盖，玩家只会看到服务器凭空少几条，
  // 而签名仍然有效，谁都发现不了（2026-10-04 就发生过一次：15 条被 11:25 的 14 条原样盖回去）。
  // 确需回滚/整体替换时显式加 ?force=1。
  const force = new URL(request.url).searchParams.get('force');
  if (!force) {
    const prevRes = await bucket.get(LIST_KEY);
    if (prevRes) {
      let prev = null;
      try { prev = JSON.parse(await prevRes.text()); } catch { /* 现网已损坏时允许覆盖修复 */ }
      const a = Date.parse((prev && prev.updated) || '');
      const b = Date.parse(doc.updated || '');
      if (a && b && b < a) {
        return json({ ok: false, error: `stale write refused: 来单 updated ${doc.updated} 早于现网 ${prev.updated}（确需覆盖请加 ?force=1）` }, 409);
      }
      // 光比大小挡不住「旧标签页把整份旧文档原样盖回来」这种写 —— 它带着旧 sig，
      // 内容却比现网旧。所有正经写者都会把 updated 写成当下，所以再要它足够新鲜。
      if (b && Math.abs(Date.now() - b) > 10 * 60 * 1000) {
        return json({ ok: false, error: `stale write refused: 来单 updated ${doc.updated} 距现在超过 10 分钟（正常发布都写当下时间；确要重放旧文档加 ?force=1）` }, 409);
      }
    }
  }

  const seen = new Set();
  const cleaned = [];
  for (const entry of doc.servers) {
    if (!entry || typeof entry !== 'object') return json({ ok: false, error: 'entry type' }, 400);
    const urlCheck = validateUrl(entry.url);
    if (urlCheck.error) return json({ ok: false, error: `bad url: ${urlCheck.error}` }, 400);
    if (seen.has(urlCheck.href)) return json({ ok: false, error: 'duplicate url' }, 400);
    seen.add(urlCheck.href);

    const id = String(entry.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
      || `srv-${cleaned.length}`;
    const name = String(entry.name || urlCheck.host).slice(0, 48);
    const clean = { id, name, url: urlCheck.href, probe: '/healthz', enabled: entry.enabled !== false };
    if (typeof entry.probe === 'string' && entry.probe.length) {
      if (!entry.probe.startsWith('/') || /[\r\n]/.test(entry.probe)) {
        return json({ ok: false, error: 'probe must be a relative path' }, 400);
      }
      clean.probe = entry.probe.slice(0, 64);
    }
    if (typeof entry.note === 'string' && entry.note.trim()) clean.note = entry.note.trim().slice(0, 48);
    if (typeof entry.region === 'string' && entry.region.trim()) clean.region = entry.region.trim().slice(0, 16);
    if (Number.isInteger(entry.tier)) clean.tier = entry.tier;
    if (Number.isInteger(entry.weight)) clean.weight = entry.weight;
    if (Number.isInteger(entry.protocol)) clean.protocol = entry.protocol;
    if (typeof entry.app === 'string' && entry.app.trim()) clean.app = entry.app.trim().slice(0, 32);
    // 国内直连可达、边缘出口不通的条目：这个标记决定它会不会被 verify 隔离，必须留住
    if (entry.direct_cn === true) clean.direct_cn = true;
    cleaned.push(clean);
  }

  // A signed list is stored byte-for-byte: re-serializing would invalidate the Ed25519 signature
  // (it covers the canonical form). The entry validation above still runs, so a hostile payload
  // cannot smuggle a private/loopback url past the gate — it merely keeps its own extra fields.
  const signed = typeof doc.sig === 'string' && doc.sig.length > 0;
  const body = signed
    ? raw
    : JSON.stringify({ updated: new Date().toISOString(), servers: cleaned }, null, 2) + '\n';
  await bucket.put(LIST_KEY, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' }
  });

  // 审计：清单被整份重写的事已经发生过两次，光靠 Last-Modified 查不出是谁。每次成功发布留一条。
  try {
    const auditKey = 'site/publish-log.json';
    const prevRes = await bucket.get(auditKey);
    let log = prevRes ? JSON.parse(await prevRes.text()) : { entries: [] };
    if (!log || !Array.isArray(log.entries)) log = { entries: [] };
    let sha = null;
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      sha = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    } catch { /* 算不出不挡发布 */ }
    log.entries.push({
      at: new Date().toISOString(), count: cleaned.length, incomingUpdated: doc.updated || null,
      signed, forced: !!force, sha,
      ua: (request.headers.get('user-agent') || '').slice(0, 120),
      ip: (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '').slice(0, 60),
      country: (request.cf && request.cf.country) || null,
    });
    if (log.entries.length > 60) log.entries = log.entries.slice(-60);
    await bucket.put(auditKey, JSON.stringify(log, null, 1) + '\n', {
      httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' } });
  } catch { /* 审计失败不影响发布 */ }
  return json({ ok: true, count: cleaned.length, updated: new Date().toISOString() });
}

export async function onRequestGet() {
  return json({ ok: true, hint: 'PUT with x-admin-key and {servers:[...]} to publish' });
}
