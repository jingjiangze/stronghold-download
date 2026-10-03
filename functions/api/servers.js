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
    cleaned.push(clean);
  }

  const body = JSON.stringify({ updated: new Date().toISOString(), servers: cleaned }, null, 2) + '\n';
  await bucket.put(LIST_KEY, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' }
  });

  return json({ ok: true, count: cleaned.length, updated: new Date().toISOString() });
}

export async function onRequestGet() {
  return json({ ok: true, hint: 'PUT with x-admin-key and {servers:[...]} to publish' });
}
