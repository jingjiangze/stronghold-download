// Pages Function: GET /api/servers/verify
// Server-side re-verification of EVERY published server. The download page calls this
// (public, cached) every 5 minutes while it is open; any visitor triggering it refreshes
// the shared verdict for everyone.
//
// Behaviour:
//   - reads the live list from R2 (site/servers.json);
//   - runs verifyServerHealth() on each entry (fresh, cache-bypassed by design? No: the
//     shared 10-min verify cache in _verify.js keeps third-party load bounded);
//   - writes the partition to R2: site/verified.json = { updated, valid: [ids], invalid: [
//     { id, reason } ] } — the "后台暂存" for entries that failed;
//   - responds with the partition for the caller's own UI.
//
// Publishing a failing entry stays possible (transient downtime must not delete data),
// but the download page hides invalid entries until they pass again.

import { verifyServerHealth } from '../_verify.js';

const LIST_KEY = 'site/servers.json';
const VERIFIED_KEY = 'site/verified.json';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.R2BUCKET) return json({ ok: false, error: 'R2 binding missing' }, 500);

  const listRes = await env.R2BUCKET.get(LIST_KEY);
  if (!listRes) return json({ ok: false, error: 'list missing' }, 404);
  let doc;
  try { doc = JSON.parse(await listRes.text()); } catch { return json({ ok: false, error: 'list corrupt' }, 500); }
  const servers = Array.isArray(doc.servers) ? doc.servers : [];

  const valid = [];
  const invalid = [];
  const occupancy = {}; // id -> { rooms, humans, variant } for the servers page

  // Previous verdict: entries whose fresh check fails due to *our* timeout/verification
  // infra keep their last known state instead of being quarantined on a flaky round.
  let previous = { valid: [], invalid: [], occupancy: {} };
  const prevRes = await env.R2BUCKET.get(VERIFIED_KEY);
  if (prevRes) { try { previous = JSON.parse(await prevRes.text()); } catch { /* ignore */ } }
  const prevValid = new Set(Array.isArray(previous.valid) ? previous.valid : []);
  const prevOccupancy = (previous.occupancy && typeof previous.occupancy === 'object') ? previous.occupancy : {};

  // Verify in parallel batches of 4: a cold isolate must finish 10 servers within the
  // Functions wall-clock budget (sequential 5s timeouts add up to a guaranteed abort).
  const BATCH = 4;
  const results = [];
  for (let i = 0; i < servers.length; i += BATCH) {
    const batch = servers.slice(i, i + BATCH);
    const settled = await Promise.all(batch.map(async (entry) => {
      if (entry.enabled === false) {
        return { entry, ok: false, reason: '已停用', rooms: null, humans: null, variant: null };
      }
      const verdict = await verifyServerHealth(entry.url, entry.probe || '/healthz');
      return { entry, ...verdict };
    }));
    results.push(...settled);
  }

  for (const r of results) {
    if (r.ok) {
      valid.push(r.entry.id);
      if (r.rooms != null || r.humans != null) {
        occupancy[r.entry.id] = { rooms: r.rooms, humans: r.humans, variant: r.variant || 'node' };
      }
    } else {
      invalid.push({ id: r.entry.id, name: r.entry.name, url: r.entry.url, reason: r.reason });
      // infra failure (timeout etc.) on a previously valid server: keep last known occupancy
      if (prevValid.has(r.entry.id) && prevOccupancy[r.entry.id]) {
        occupancy[r.entry.id] = prevOccupancy[r.entry.id];
      }
    }
  }

  const verifiedDoc = {
    updated: new Date().toISOString(),
    valid,
    invalid,
    occupancy,
  };
  await env.R2BUCKET.put(VERIFIED_KEY, JSON.stringify(verifiedDoc, null, 2) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=120' },
  });

  return json({ ok: true, updated: verifiedDoc.updated, valid: valid.length,
                invalid: invalid.map((i) => ({ id: i.id, name: i.name, reason: i.reason })) });
}
