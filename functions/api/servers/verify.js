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

import { verifyServerHealth, checkEntryUrl } from '../_verify.js';

const LIST_KEY = 'site/servers.json';
const VERIFIED_KEY = 'site/verified.json';
const PINGS_KEY = 'site/pings.json';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
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
  // 玩家浏览器的实测回执：服务端校验只有海外出口，而国内 IDC / 云防火墙会把海外入站直接丢掉
  // （sp.rainya.me:10166 就是这样：国内 163ms 200，CF 边缘超时）。所以「24 小时内有玩家连上过」
  // 是一条正向证据，不必靠人手工打 direct_cn 标记。
  let pings = {};
  const pingRes = await env.R2BUCKET.get(PINGS_KEY);
  if (pingRes) { try { pings = (JSON.parse(await pingRes.text()) || {}).pings || {}; } catch { /* 无回执 */ } }
  // 回执里带房间/版本时（玩家浏览器 CORS 读到了 /healthz），直接拿它当 occupancy
  const pingOccupancy = (p) => {
    if (!p || (p.rooms == null && p.humans == null && !p.app && !p.build)) return null;
    return { rooms: p.rooms ?? null, humans: p.humans ?? null, variant: p.variant || 'browser',
             app: p.app || null, build: p.build || null };
  };
  const DAY_MS = 24 * 3600e3;
  const browserOk = (id, maxAgeMs) => {
    const p = pings[id];
    if (!p || p.ok !== true) return null;
    // 玩家自己连清单里那条地址都连不上（回执 entry_ok:false）时，这条证据不再免死
    if (p.entry_ok === false) return null;
    const age = Date.now() - Date.parse(p.at || '');
    return Number.isFinite(age) && age < (maxAgeMs || DAY_MS) ? p : null;
  };
  // 边缘这轮明确拿到 5xx 时，旧回执只能撑 2 小时（选项 4）：否则一个已经全挂的服
  // 会靠 24 小时前的回执一直显示"在线"（10-05 的 anciusland 就是这样，健康端点和入口都 502）。
  const FRESH_RECEIPT_MS = 2 * 3600e3;
  const receiptWindow = (r) => (/5\d\d/.test(String((r && r.reason) || '') + String((r && r.error) || ''))
    ? FRESH_RECEIPT_MS : DAY_MS);
  const evidence = {};
  const prevValid = new Set(Array.isArray(previous.valid) ? previous.valid : []);
  const prevOccupancy = (previous.occupancy && typeof previous.occupancy === 'object') ? previous.occupancy : {};
  // 入口连续坏了几轮（1 = 只坏了一轮，先标注不判死；>=2 才隐藏），避免网关重启十几分钟就整条消失
  const prevEntryStreak = (previous.entry_streak && typeof previous.entry_streak === 'object') ? previous.entry_streak : {};
  const entryStreak = {};
  // 整体节奏：默认 30 分钟才真打一轮（VERIFY_FLOOR_MIN 可覆盖）。页面开着也只是读这份结论，
  // 不再每 5 分钟去敲每一台服务器 —— rincynar 就是被这样打到 429 的。
  // 清单本身变过（新服上线）则立刻重探，否则新条目会被隐藏半个钟头。
  const FLOOR_MS = (Number(env.VERIFY_FLOOR_MIN) || 30) * 60 * 1000;
  const force = new URL(request.url).searchParams.get('force');
  const prevAt = Date.parse(previous.updated || '');
  const listUnchanged = previous.listUpdated && previous.listUpdated === doc.updated;
  if (!force && prevAt && listUnchanged && Date.now() - prevAt < FLOOR_MS) {
    return json({ ok: true, cached: true, updated: previous.updated, listUpdated: previous.listUpdated,
                  nextRetryAt: new Date(prevAt + FLOOR_MS).toISOString(),
                  valid: (previous.valid || []).length, invalid: previous.invalid || [],
                  backoff: previous.backoff || {} });
  }

  // 单台冷却：429/限流 → 两个档位；超时/5xx/网络异常 → 一个档位。
  // 冷却期内不打它，直接沿用上次结论（上次是活的就算活的），避免把人家打到限流。
  const nowMs = Date.now();
  const backoff = (previous.backoff && typeof previous.backoff === 'object') ? previous.backoff : {};
  const cooled = (id) => {
    const b = backoff[id];
    return b && Number(b.until) > nowMs ? b : null;
  };
  const nextBackoff = (reason) => {
    const s = String(reason || '');
    if (/429|rate.?limit|限流/i.test(s)) return FLOOR_MS * 2;
    if (/超时|timeout|探测异常|502|503|520|522|526|connection|ECONN|网络/i.test(s)) return FLOOR_MS;
    // 403 不进退避：边缘被国内云挡是常态且时常自己恢复，按政策直接当"活着"处理（见下面的分支）
    if (/404|不是 JSON|ok 字段|无合法|拒绝|dead/i.test(s)) return FLOOR_MS;
    return 0;
  };
  let skipped = 0;

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
      const cool = cooled(entry.id);
      if (cool) {
        skipped++;
        // 冷却只是省掉一次探测，不该顺手把「维护者留证 / 玩家实测可达 / 仅边缘 403」的条目判死。
        // 但退避原因里写着 5xx 时，玩家回执同样只认 2 小时内的（和真探那一轮同一个口径）。
        const coolWindow = /5\d\d/.test(String(cool.reason || '')) ? FRESH_RECEIPT_MS : DAY_MS;
        if (entry.direct_cn === true || browserOk(entry.id, coolWindow) || /403/.test(String(cool.reason || ''))) return { entry, ok: false, cooled: true, spared: true, reason: cool.reason };
        return { entry, ok: false, cooled: true, reason: cool.reason };
      }
      // 单个服务器抛异常（解压失败、非法 probe 路径等）不能把整轮 verify 打成 1101，
      // 否则所有人看到的都是上一次的成功结果。
      try {
        // 健康端点与清单地址**并发**打：前者证明后端在应答，后者证明玩家点的那条链接真打得开。
        // 只看前者会漏掉「nginx 在、上游死了」的半挂服 —— game.rainya.me 就是 /api/status 200 而 /play 502。
        // 并发而不是串行，是为了不给整轮加时长（Functions 有 wall-clock 预算）。
        const [verdict, gate] = await Promise.all([
          verifyServerHealth(entry.url, entry.probe || '/healthz'),
          checkEntryUrl(entry.url).catch(() => ({ ok: true, status: null, error: null, unknown: true })),
        ]);
        return { entry, ...verdict, entry_check: gate };
      } catch (e) {
        return { entry, ok: false, error: '探测异常 ' + String((e && e.name) || e).slice(0, 40) };
      }
    }));
    results.push(...settled);
  }

  // An "ok" reading can still carry no numbers (variant without room stats, partial
  // response). Overwriting the previous occupancy with that blanked the version label and
  // the load bar for every visitor, so an empty fresh reading keeps the last informative one.
  const hasSignal = function (o) {
    return !!(o && (o.rooms != null || o.humans != null || o.app || o.build));
  };
  const blank = (variant) => ({ rooms: null, humans: null, variant: variant, app: null, build: null });
  /**
   * occupancy 的取数优先级：本轮真探 > 玩家回执 > 上一次「有信号」的结论 > 空白。
   * 曾经踩过坑：上一轮写进 verified.json 的是全 null 的空白行，后续分支用
   * `prevOccupancy[id] || ...` 会永远沿用这个空白（它是个 truthy 对象），
   * 于是新收到的 rooms/app 回执被挡在门外，版本号和负载条一直显示不出来。
   */
  const pickOccupancy = function (id, fresh, variant) {
    if (hasSignal(fresh)) return fresh;
    const fromPing = pingOccupancy(pings[id]);
    if (fromPing) return fromPing;
    const prev = prevOccupancy[id];
    if (hasSignal(prev)) return Object.assign({}, prev, { stale: true });
    return fresh && fresh.variant ? fresh : blank(variant);
  };

  for (const r of results) {
    const id = r.entry.id;
    if (prevEntryStreak[id] && !r.entry_check) entryStreak[id] = Number(prevEntryStreak[id]) || 1;
    if (r.cooled) {
      // 冷却期内不打扰它，也不改判：上次活的继续算活，上次死的继续挂原因。
      if (r.spared) {
        const p = browserOk(id);
        if (p) evidence[id] = { at: p.at, country: p.country, ms: p.ms, okHits: p.okHits, via: 'browser' };
        valid.push(id);
        occupancy[id] = pickOccupancy(id, null, p ? 'browser' : 'direct-cn');
      } else if (prevValid.has(id)) {
        valid.push(id);
        occupancy[id] = pickOccupancy(id, null, 'cooled');
      } else if (r.entry.direct_cn === true || browserOk(id)) {
        // 但正向证据不吃冷却：新收录的国内服第一次探测必然超时，若按"上次结论"继续判死，
        // 它会永远锁在 invalid 里（direct_cn / 玩家回执本来就该越过边缘探测）。
        delete backoff[id];
        valid.push(id);
        occupancy[id] = pickOccupancy(id, null, r.entry.direct_cn === true ? 'direct-cn' : 'browser');
      } else {
        invalid.push({ id, name: r.entry.name, url: r.entry.url, reason: (backoff[id] && backoff[id].reason) || '冷却中' });
      }
      continue;
    }
    if (r.ok) {
      delete backoff[id];
      const fresh = {
        rooms: r.rooms, humans: r.humans, variant: r.variant || 'node',
        // 标注服务器当前版本（node 版=协议协议号+app；workers 版=app/build 哈希）。
        // 不做版本准入——只展示，旧版/新版服务器都会列出。
        app: r.app || null, build: r.build || null,
      };
      const gate = r.entry_check;
      if (gate && gate.ok === false) {
        const seen = Number(prevEntryStreak[id]) || 0;
        if (seen >= 1) {
          // 连着两轮（≥30 分钟）都打不开：判死。理由必须和后端分开写，否则看起来像"服务器没了"，
          // 而实际上后端健康端点一直 200 —— 是清单那条入口地址的路由/上游挂了。
          invalid.push({ id, name: r.entry.name, url: r.entry.url, reason: `${gate.error}（后端健康端点正常）` });
          entryStreak[id] = seen + 1;
          if (prevOccupancy[id]) occupancy[id] = prevOccupancy[id];
          continue;
        }
        // 第一轮只标注：行留在清单里并带上 entry_status，由页面显示「入口 502」灰标
        entryStreak[id] = 1;
        valid.push(id);
        occupancy[id] = Object.assign(pickOccupancy(id, fresh, 'node'),
          { entry_status: { ok: false, status: gate.status || null, error: gate.error } });
        continue;
      }
      valid.push(r.entry.id);
      occupancy[r.entry.id] = pickOccupancy(r.entry.id, fresh, 'node');
    } else if (/403/.test(String(r.reason || '') + String(r.error || '')) && !/已停用/.test(String(r.reason || ''))) {
      // 边缘 403 不算死，也不再要求条目带 direct_cn 标记（2026-10-05 定的政策）：
      // CF 出口被国内云的防火墙/安全组挡掉是常态，同一条地址十几分钟后又常常能通，
      // 而玩家和收录时的验活都不走 CF 出口。仍照常展示，不写退避（下一轮继续真探）。
      delete backoff[id];
      valid.push(r.entry.id);
      occupancy[r.entry.id] = pickOccupancy(r.entry.id, null,
        r.entry.direct_cn === true ? 'direct-cn' : 'edge-403');
    } else if (r.entry.direct_cn === true && !/已停用/.test(String(r.reason || ''))) {
      // 国内直连正常、Cloudflare 出口超时的服务器（收录时已用其它出口验过活）。
      // 真实玩家从国内浏览器/客户端连接，边缘探测失败不该把它判死；仍照常展示，来源写在 note。
      delete backoff[id];
      valid.push(r.entry.id);
      occupancy[r.entry.id] = pickOccupancy(r.entry.id, null, 'direct-cn');
    } else if (browserOk(r.entry.id, receiptWindow(r))) {
      // 边缘探不到、玩家却连得上：以玩家为准（回执超过 24 小时没续上就退回原判；
      // 本轮边缘明确拿到 5xx 时只认 2 小时内的回执 —— 旧证据不该把已经死了的服留着）
      const p = browserOk(r.entry.id, receiptWindow(r));
      evidence[r.entry.id] = { at: p.at, country: p.country, ms: p.ms, okHits: p.okHits, via: 'browser' };
      valid.push(r.entry.id);
      occupancy[r.entry.id] = pickOccupancy(r.entry.id, null, 'browser');
    } else {
      const reason = r.reason || r.error || '校验未通过';
      invalid.push({ id: r.entry.id, name: r.entry.name, url: r.entry.url, reason });
      const wait = nextBackoff(reason);
      if (wait) backoff[id] = { until: nowMs + wait, reason: String(reason).slice(0, 60) };
      else delete backoff[id];
      // infra failure (timeout etc.) on a previously valid server: keep last known occupancy
      if (prevValid.has(r.entry.id) && prevOccupancy[r.entry.id]) {
        occupancy[r.entry.id] = prevOccupancy[r.entry.id];
      }
    }
  }
  const liveIds = new Set(servers.map((s) => s.id));
  for (const k of Object.keys(backoff)) {
    if (!liveIds.has(k) || Number(backoff[k].until) <= nowMs) delete backoff[k];
  }

  const verifiedDoc = {
    updated: new Date().toISOString(),
    listUpdated: doc.updated, // 清单一变就立刻重探，否则新上的服务器会被缓存挡到下个档位
    valid,
    invalid,
    occupancy,
    backoff,
    evidence,
    entry_streak: entryStreak,
  };
  await env.R2BUCKET.put(VERIFIED_KEY, JSON.stringify(verifiedDoc, null, 2) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=120' },
  });

  return json({ ok: true, updated: verifiedDoc.updated, valid: valid.length,
                invalid: invalid.map((i) => ({ id: i.id, name: i.name, reason: i.reason })),
                skipped: skipped, cooling: Object.keys(backoff).length,
                entry_degraded: Object.keys(entryStreak).length,
                nextRetryAt: new Date(Date.now() + FLOOR_MS).toISOString() });
}
