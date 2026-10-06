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
//
// 证据分层（从弱到强）：边缘指纹 > 盒子国内服务端探测（看得见状态码）> 玩家浏览器 no-cors 回执
// > 站长停用（终审）。
// **玩家的票不在这一层里**：/api/servers/vouch 的大杯/小杯只调清单排序权重（见 js/servers.js 的
// rankOf），永不决定某台显示或隐藏。2026-10-06 一天内两次走到这个结论 —— 先给正向一票（同日
// 取消：没有事实核验的点击不该推翻判据），再给负向两票隐藏（同日改成降权：单条「我连不上」多半
// 是本地噪声，10-05 就因此把当天最大的 81 房/83 人服整条藏掉过；挪到后面可逆，藏掉不可逆）。

import { verifyServerHealth, checkEntryUrl } from '../_verify.js';

const LIST_KEY = 'site/servers.json';
const VERIFIED_KEY = 'site/verified.json';
const PINGS_KEY = 'site/pings.json';
const VOUCH_KEY = 'site/vouches.json';
const OPEN_KEY = 'site/opens.json';

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
  const browserOk = (id) => {
    const p = pings[id];
    if (!p || p.ok !== true) return null;
    // 玩家自己连清单里那条地址都连不上（回执 entry_ok:false）时，这条证据不再免死 ——
    // 但要**连着两条**才算（2026-10-05 定的）：单条浏览器噪声就藏掉一台 81 房/83 人的繁忙服，
    // 代价明显大于留着一个入口暂时打不开的行。
    if (p.entry_ok === false && Number(p.entryBadStreak || 0) >= 2) return null;
    const age = Date.now() - Date.parse(p.at || '');
    return Number.isFinite(age) && age < DAY_MS ? p : null;
  };
  // 看得见状态码的国内服务器端探测（盒子每小时那轮），2 小时内算有效证据。
  // 与 browserOk 的区别很关键：浏览器是 no-cors，502 的页面也算"连上了"，翻不了 5xx 的案；
  // 而 cn-probe 的 ok 意味着它真的读到了 HTTP 200 + PROTOCOL_VERSION=1。
  const cnProbeOk = (id) => {
    const p = pings[id];
    if (!p || p.ok !== true || p.src !== 'cn-probe') return null;
    if (p.entry_ok === false && Number(p.entryBadStreak || 0) >= 2) return null;
    const age = Date.now() - Date.parse(p.at || '');
    return Number.isFinite(age) && age < 2 * 3600e3 ? p : null;
  };
  // 玩家匿名举报「进不去」（写口 POST /api/servers/vouch）。2026-10-06 一天里改了两次口径：
  // 先加正向票（同日取消 —— 没有事实核验的点击不该推翻判据），再把负向票从「2 个来源就隐藏
  // 一行」改成**只降权重**：被报得多的行在清单里往后挪，但绝不因为点击而消失。
  // 依据是同一条教训 —— 单条「我连不上」多半是本地噪声（adblock、切网、页面没加载完、https
  // 页面不让发 http 请求），10-05 就有一条这种回执把当天最大的一台服（81 房/83 人）整条藏掉过；
  // 往后挪是可逆的，藏掉是不可逆的。所以这里只把票数当**元数据**发布（verified.json 的 vouches），
  // 排序交给页面（js/servers.js 的 rankOf），隐藏与否仍只由探测与维护者决定。
  let vouches = {};
  const vouchRes = await env.R2BUCKET.get(VOUCH_KEY);
  if (vouchRes) { try { vouches = (JSON.parse(await vouchRes.text()) || {}).vouches || {}; } catch { /* 没人投过 */ } }
  const VOUCH_TTL_MS = 7 * 24 * 3600e3;
  const sideCount = (v, side) => {
    const map = v && typeof v === 'object' && v[side] && typeof v[side] === 'object' ? v[side] : {};
    return Object.keys(map).length;
  };
  /** 票数快照。at 是最后写入时间，页面用它判断"我自己那一票服务端算进去没有"，
   *  这样点完/撤回后位置能立刻对上，不用等 120 s 的边缘缓存。过期票自动不算。 */
  const vouchSnapshot = function () {
    const out = {};
    for (const id of Object.keys(vouches)) {
      const v = vouches[id] || {};
      const age = Date.now() - Date.parse(v.at || '');
      if (!Number.isFinite(age) || age >= VOUCH_TTL_MS) continue;
      const good = sideCount(v, 'good');
      const bad = sideCount(v, 'bad');
      if (good || bad) out[id] = { good, bad, score: good - bad, at: v.at || null };
    }
    return out;
  };
  /** 打开跳转计数：两个分支都要现读，否则缓存直返分支只透传旧值，
   *  玩家点了「打开」要等下一轮真探（30 分钟）才在别人屏幕上显示出来。 */
  const readOpens = async () => {
    const out = {};
    const res = await env.R2BUCKET.get(OPEN_KEY);
    if (!res) return out;
    try {
      const od = JSON.parse(await res.text());
      const today = new Date().toISOString().slice(0, 10);
      for (const id of Object.keys(od.opens || {})) {
        const r = od.opens[id] || {};
        const total = Number(r.total) || 0;
        if (!total) continue;
        out[id] = { total, today: r.day === today ? (Number(r.today) || 0) : 0, at: r.at || null };
      }
    } catch { /* 没计数就空着 */ }
    return out;
  };
  // 5xx 是「看见了它坏了」，不是「看不见」：这类失败**不认玩家回执免死**。
  // 浏览器探针是 no-cors（响应不透明），502 的页面照样算"连上了"，回执的 ok:true 根本
  // 表达不了健康与否 —— 10-05 的 anciusland 就是靠一条 6 分钟前的 ok:true 回执被捞回清单，
  // 而它的 /healthz 当时就是 502。只有超时/连接失败/403 那种"我们看不到"才让回执说话。
  // 只认「服务端自己回了 5xx」这种确切失败；429 是我们敲得太勤，不算服务器坏了。
  const hardDown = (s) => /返回\s*5\d\d/.test(String(s || ''));
  const evidence = {};
  const prevValid = new Set(Array.isArray(previous.valid) ? previous.valid : []);
  const prevOccupancy = (previous.occupancy && typeof previous.occupancy === 'object') ? previous.occupancy : {};
  // 整体节奏：默认 30 分钟才真打一轮（VERIFY_FLOOR_MIN 可覆盖）。页面开着也只是读这份结论，
  // 不再每 5 分钟去敲每一台服务器 —— rincynar 就是被这样打到 429 的。
  // 清单本身变过（新服上线）则立刻重探，否则新条目会被隐藏半个钟头。
  const FLOOR_MS = (Number(env.VERIFY_FLOOR_MIN) || 30) * 60 * 1000;
  const force = new URL(request.url).searchParams.get('force');
  const prevAt = Date.parse(previous.updated || '');
  const listUnchanged = previous.listUpdated && previous.listUpdated === doc.updated;
  if (!force && prevAt && listUnchanged && Date.now() - prevAt < FLOOR_MS) {
    // 档位内也要处理票：玩家点「进不去」要立刻攒数、够了立刻隐藏，撤回/purge 要立刻恢复 ——
    // 这一分支根本不重新探测，所以直接在上一轮结论上补这一层。
    // 回写时**保持 updated 不变** —— 否则每次读都会把档位起点往后推，真探永远轮不到。
    const occ = (previous.occupancy && typeof previous.occupancy === 'object') ? previous.occupancy : {};
    const validArr = Array.isArray(previous.valid) ? previous.valid : [];
    const invalidArr = Array.isArray(previous.invalid) ? previous.invalid : [];
    const vshot = vouchSnapshot();
    // 票数/点击数变了就回写：玩家刚投的大杯小杯、刚点的一次「打开」，不该等下一轮真探才在别人
    // 屏幕上出现。比较用 JSON 串，一次写就收敛，不会每次都写。
    const staleShot = JSON.stringify(previous.vouches || {}) !== JSON.stringify(vshot);
    const opensNow = await readOpens();
    const staleOpens = JSON.stringify(previous.opens || {}) !== JSON.stringify(opensNow);
    if (staleShot || staleOpens) {
      await env.R2BUCKET.put(VERIFIED_KEY, JSON.stringify({
        updated: previous.updated, listUpdated: previous.listUpdated,
        valid: validArr, invalid: invalidArr, occupancy: occ,
        backoff: previous.backoff || {}, evidence: previous.evidence || {},
        vouches: vshot, opens: opensNow,
        entry_down_rounds: previous.entry_down_rounds || {},
      }, null, 2) + '\n', {
        httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=120' },
      });
    }
    return json({ ok: true, cached: true, updated: previous.updated, listUpdated: previous.listUpdated,
                  nextRetryAt: new Date(prevAt + FLOOR_MS).toISOString(),
                  valid: validArr.length, invalid: invalidArr,
                  vouches: vshot, backoff: previous.backoff || {} });
  }

  // 单台冷却：429/限流 → 两个档位；超时/5xx/网络异常 → 一个档位。
  // 冷却期内不打它，直接沿用上次结论（上次是活的就算活的），避免把人家打到限流。
  const nowMs = Date.now();
  const backoff = (previous.backoff && typeof previous.backoff === 'object') ? previous.backoff : {};
  // 入口地址连续打不开的轮数（只用于标注，不再用于隐藏）
  const entryDown = (previous.entry_down_rounds && typeof previous.entry_down_rounds === 'object')
    ? previous.entry_down_rounds : {};
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
        // 但退避原因是 5xx 时属于"上次亲眼看见它坏了"，玩家回执（看不见状态码）不能翻案。
        if (entry.direct_cn === true || (!hardDown(cool.reason) && browserOk(entry.id)) || /403/.test(String(cool.reason || ''))) return { entry, ok: false, cooled: true, spared: true, reason: cool.reason };
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
    if (r.cooled) {
      // 冷却期内不打扰它，也不改判：上次活的继续算活，上次死的继续挂原因。
      if (r.spared) {
        const p = browserOk(id);
        if (p) evidence[id] = { at: p.at, country: p.country, ms: p.ms, okHits: p.okHits, via: 'browser' };
        valid.push(id);
        occupancy[id] = pickOccupancy(id, null, p ? 'browser' : 'direct-cn');
      } else if (prevValid.has(id) && !hardDown(r.reason)) {
        // 冷却期沿用上次结论，但上次是"亲眼看见 5xx"的不沿用 —— 否则一台 502 的服
        // 会靠退避窗口里的这条 prevValid 一直留在清单里（anciusland 实测就是这样）。
        valid.push(id);
        occupancy[id] = pickOccupancy(id, null, 'cooled');
      } else if (r.entry.direct_cn === true || (!hardDown(r.reason) && browserOk(id))) {
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
      // 只有入口自己回了 **5xx** 才标注：那是确定的坏。超时/连不上不算 —— CF 出口被国内云
      // 挡掉是常态（小鹿宝实测：边缘探测超时，玩家浏览器 344 ms 打得开、当天最大的一台服），
      // 给它挂「入口打不开」是当着所有玩家的面说假话。
      const entryBad = gate && gate.ok === false && Number(gate.status) >= 500;
      if (entryBad) {
        // 后端健康端点 200、只有清单那条入口 5xx —— 按 2026-10-05 定的口径：**不隐藏，只标注**。
        // 入口挂掉通常是 nginx 路由/上游的临时问题（game.rainya.me 重启窗口就是这样，
        // 那一轮 /play 和 /healthz 从三个出口都是 502，而 /api/status 一直 200），
        // 后端在应答就说明服务器本身活着；把整条藏起来的代价（玩家找不到繁忙的服）大于留着。
        // 连续轮数记进 entry_down_rounds，页面据此挂「入口 502」标记；不写退避。
        delete backoff[id];
        entryDown[id] = Number(entryDown[id] || 0) + 1;
        fresh.entry_status = { ok: false, status: gate.status, error: gate.error || null, rounds: entryDown[id] };
      } else if (gate && gate.ok === false) {
        delete backoff[id];            // 边缘看不到入口而已，下一轮继续真探，别进退避
        if (entryDown[id]) {
          fresh.entry_status = { ok: true, recovered: true };
          delete entryDown[id];
        }
      } else if (entryDown[id]) {
        // 入口恢复了：留一次恢复标记，然后清零，别让"曾经坏过"长期挂在数据里
        fresh.entry_status = { ok: true, recovered: true };
        delete entryDown[id];
      }
      valid.push(r.entry.id);
      occupancy[r.entry.id] = pickOccupancy(r.entry.id, fresh, 'node');
    } else if (/已停用/.test(String(r.reason || '') + String(r.error || ''))) {
      // 停用是维护者的决定，属终审：玩家回执、盒子 cn-probe、上次的 valid 都不许把它捞回前台
      // （以前只有 direct_cn 那一支挡了 已停用，结果管理页点「停用」后条目照样显示在清单上）。
      delete backoff[id];
      delete entryDown[id];
      invalid.push({ id, name: r.entry.name, url: r.entry.url, reason: '已停用（管理页关掉，需手工恢复展示）' });
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
    } else if (!hardDown(r.reason || r.error) && browserOk(r.entry.id)) {
      // 边缘探不到、玩家却连得上：以玩家为准（回执超过 24 小时没续上就退回原判）。
      // 5xx 走不到这里 —— 那是"看见了它坏了"，回执（看不见状态码）不能翻案。
      const p = browserOk(r.entry.id);
      evidence[r.entry.id] = { at: p.at, country: p.country, ms: p.ms, okHits: p.okHits, via: 'browser' };
      valid.push(r.entry.id);
      occupancy[r.entry.id] = pickOccupancy(r.entry.id, null, 'browser');
    } else if (cnProbeOk(r.entry.id)) {
      // 边缘看见 5xx 本来是终审，但盒子那路是**看得见状态码**的国内服务器端探测：
      // 它 2 小时内读到过 HTTP 200 + version=1，说明服务器本身活着，5xx 出在 CF 出口/路由上
      // —— 按 2026-10-05 的政策（边缘不通不算死、可信出口验活即入清单）这里放行并留证据。
      const p = cnProbeOk(r.entry.id);
      evidence[id] = { at: p.at, country: p.country, ms: p.ms, okHits: p.okHits, via: 'cn-probe' };
      valid.push(id);
      occupancy[id] = pickOccupancy(id, null, 'direct-cn');
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
  // 版本号是"这台真的在跑一个我们能对话的服务"的唯一硬证据。occupancy 里没有点分版本号
  // （边缘读不到、玩家与盒子的回执也没回报过）就按**校验失败**处理 —— 而不是只让每个网页
  // 访客自己藏自己那一份：判死一次对所有出口、包括游戏客户端一致，进 admin 暂存区可复核。
  // 不写退避：下一轮继续真探，版本一被读到就自动回前台。
  const isVersion = (v) => /^\d+(\.\d+){1,3}$/.test(String(v || ''));
  const byId = new Map(servers.map((s) => [s.id, s]));
  for (let i = valid.length - 1; i >= 0; i -= 1) {
    const vid = valid[i];
    if (isVersion((occupancy[vid] || {}).app)) continue;
    const entry = byId.get(vid) || {};
    valid.splice(i, 1);
    invalid.push({ id: vid, name: entry.name, url: entry.url,
      reason: '探不到版本号（健康端点不回报 app/version，各出口也没读到）' });
    delete backoff[vid];
  }
  for (const k of Object.keys(backoff)) {
    if (!liveIds.has(k) || Number(backoff[k].until) <= nowMs) delete backoff[k];
  }
  for (const k of Object.keys(entryDown)) {
    if (!liveIds.has(k)) delete entryDown[k];
  }

  // 打开跳转的点击数（写口 /api/servers/open）并进这份快照：页面本来就读 verified.json，
  // 再开一个请求就等于在又慢又抖的链路上多一次往返。
  const opens = await readOpens();

  const verifiedDoc = {
    updated: new Date().toISOString(),
    listUpdated: doc.updated, // 清单一变就立刻重探，否则新上的服务器会被缓存挡到下个档位
    valid,
    invalid,
    occupancy,
    backoff,
    evidence,
    vouches: vouchSnapshot(),   // 大杯/小杯票数：页面只拿它调权重，不参与隐藏判断
    opens,                      // 「目前已点击 N 次」
    entry_down_rounds: entryDown,
  };
  await env.R2BUCKET.put(VERIFIED_KEY, JSON.stringify(verifiedDoc, null, 2) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=120' },
  });

  const entryDead = invalid.filter((i) => /后端健康端点正常/.test(String(i.reason || ''))).length;
  const versionless = invalid.filter((i) => /探不到版本号/.test(String(i.reason || ''))).length;
  return json({ ok: true, updated: verifiedDoc.updated, valid: valid.length,
                invalid: invalid.map((i) => ({ id: i.id, name: i.name, reason: i.reason })),
                skipped: skipped, cooling: Object.keys(backoff).length,
                entry_dead: entryDead, versionless,
                nextRetryAt: new Date(Date.now() + FLOOR_MS).toISOString() });
}
