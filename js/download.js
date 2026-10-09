/* ==========================================================================================
   download.js — fetches the latest release, builds mirror links and (where CORS allows)
   measures each mirror in the browser so the fastest one becomes the primary button.

   Security notes:
   - Every string coming from the API/config is rendered with textContent (never innerHTML).
   - Download URLs are built only from the staged release assets and the mirror list, then
     re-validated: scheme must be https: and the host must be in the mirror allowlist.
   ========================================================================================== */
(function () {
  'use strict';

  var REPO = 'jingjiangze/Stronghold-Protocol';
  var FIRST_PARTY_HOST = 'weishucdn.jiangjiangze.icu'; // our own R2 CDN, not a config entry
  var API_EDGE = '/api/latest';
  var API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var API_LIST = 'https://api.github.com/repos/' + REPO + '/releases?per_page=10';
  var API_DOWNLOADS = 'https://api.github.com/repos/' + REPO + '/releases?per_page=100';
  var PRIMARY_ASSET = 'app-release.apk';
  /** 已知恶意/仿冒主机：对**合法**镜像做 typosquat（差一个后缀）的域名，返回的是 HTML 跳转页
   *  而非文件 —— 10-08 用户报 gh-proxy.net（冒充 gh-proxy.com）被 Defender 判
   *  Trojan:HTML/Redirector。清单是访客侧动态读 /data/mirrors.json 的（300s 边缘缓存），
   *  所以这里再钉一道硬黑名单：即便清单被误加、被篡改、或某访客手上还是旧缓存，也不会信任它。
   *  比对用 hostname（去掉端口/ scheme/ userinfo），精确匹配整段主机名。 */
  var BLOCKED_HOSTS = { 'gh-proxy.net': true };

  function isBlockedHost(raw) {
    var s = String(raw || '').trim().toLowerCase();
    if (!s) return false;
    // 传进来的可能是完整 URL（清单里的 prefix/template），也可能是已解析出的裸主机名（带不带端口）。
    // 注意 new URL('host:443') 不抛错、会把 host 当成 scheme 解析出空 hostname —— 所以只有解析出
    // 非空 hostname 时才采信，否则落到裸主机名拆分。
    try {
      var h = new URL(s).hostname;
      if (h) return !!BLOCKED_HOSTS[h];
    } catch (err) { /* not absolute */ }
    return !!BLOCKED_HOSTS[s.split('/')[0].split(':')[0]];
  }
  /** 微信内置浏览器：页面里不能留任何 .apk / 下载路由链接 —— 微信按「网页含下载内容」拦截，
   *  链接留着只会让玩家点下去撞上拦截页（10-08 用户反馈「微信说含下载内容不安全」）。
   *  这里只保留版本/大小/更新日志等信息，下载入口交给 #dl-wx 的「在浏览器打开 / 复制链接」。 */
  var IN_WECHAT = /MicroMessenger/i.test(navigator.userAgent);
  /** 下载站临时维护：下线所有下载入口（主按钮 / 镜像行 / 校验值 / 更新日志里的下载链接），
   *  并跳过浏览器侧镜像测速，避免玩家在修复窗口内下载到不稳定或不同步的构建。
   *  维护结束把这里改回 false 即可。影响范围严格限于下载相关 UI：版本号、大小等
   *  信息仍正常展示，服务器清单站（/servers）与三通道入口页不受影响。 */
  var MAINTENANCE = true;
  var MAINTENANCE_NOTE = '下载服务临时维护中：正在修复静态热更新资源加载缓慢与服务器 UI 不同步问题，恢复后自动恢复。';
  var PROBE_BYTES = 3 * 1024 * 1024;
  var PROBE_TIMEOUT_MS = 12000;
  var API_TIMEOUT_MS = 9000;
  var OFFLINE_CACHE_KEY = 'sp-offline-release';
  /** 打包快照只在它发布那天算"最新"。超过一天还拿不到线上答案，就不要把它写成最新版。 */
  var OFFLINE_TRUST_MS = 24 * 3600e3;

  var el = {
    primary: document.getElementById('dl-primary'),
    primaryLabel: document.getElementById('dl-primary-label'),
    mirrors: document.getElementById('dl-mirrors'),
    version: document.getElementById('dl-version'),
    size: document.getElementById('dl-size'),
    hash: document.getElementById('dl-hash'),
    note: document.getElementById('dl-note'),
    downloads: document.getElementById('dl-downloads'),
    log: document.getElementById('dl-log')
  };

  var state = {
    release: null, asset: null, mirrors: [], measured: {}, primaryMirrorId: null,
    versionSuffix: '', ghDownloads: null, cdn: null, history: null, changelog: null
  };

  var CDN_REASON = {
    missing: 'CDN加速还没有这个构建',
    'size-unknown': '无法校验CDN加速上的构建',
    'probe-failed': 'CDN加速探测超时'
  };

  /** Why the primary button is not using the first-party CDN, in one readable line. The
   *  byte counts are printed because "size-mismatch" is only actionable with them. */
  function cdnNote(cdn) {
    if (!cdn || cdn.ok !== false) return '';
    var why = cdn.reason === 'size-mismatch' && cdn.size && cdn.expected
      ? 'CDN加速上的同名文件与本版本字节数不一致（CDN加速 ' + cdn.size + ' B · 发布 ' + cdn.expected + ' B）'
      : (CDN_REASON[cdn.reason] || 'CDN加速暂不可用');
    return why + ' · 主按钮改走公共加速器，也可点上方镜像按钮换源';
  }

  /* ---- changelog (auto-derived from the release notes) --------------------------------
     没有人工维护的日志文件，所以这里从 release 正文自动提炼：稳定 release 里既有"壳版本"
     （正文只有转正溯源，没有人话），也有纯热更新的"内容批次"（带真正的 bullet）。规则：
     去噪 → 有 bullet 就取前两条，没 bullet 就用正文首行 → 两条都没有才写"构建更新"。
     提炼逻辑只有这一份：线上走 /api/latest 的 _history，浏览器直连 GitHub 时走 /releases 列表，
     两边喂的是同一批 {tag,name,published_at,body}，不会出现两种日志口径。 */

  var LOG_MAX_ITEMS = 6;          // 只列最新版本，最多 6 条
  var LOG_MAX_BULLETS = 2;
  var LOG_CLIP = 110;
  // promote/apk-test 自动追加的溯源行，对玩家没有信息量
  var LOG_NOISE = /逐字节复制|未重打包|CDN 直链|溯源与哈希|tested-id|生产指针|apk-test 全绿|^staging\b/;

  function clip(text, max) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trim() + '…' : t;
  }

  /** 抹掉 markdown 痕迹与裸 URL：页面只用 textContent，这里管的是"读起来像源文"的问题。 */
  function cleanLine(raw) {
    return String(raw || '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^[\s>]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function summarize(entry) {
    var head = '';
    var bullets = [];
    String(entry.body || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      var text = cleanLine(line);
      if (!text || LOG_NOISE.test(text)) return;
      if (/^[-*•]/.test(line)) {
        if (bullets.length < LOG_MAX_BULLETS) bullets.push(clip(text.replace(/^[-*•]+\s*/, ''), LOG_CLIP));
        return;
      }
      if (!head) head = clip(text, LOG_CLIP);
    });
    if (!head && !bullets.length) {
      var name = cleanLine(entry.name || '');
      if (name && name.indexOf(String(entry.tag || '')) < 0) head = clip(name, LOG_CLIP);
    }
    return { head: head, bullets: bullets };
  }

  /** 把 GitHub 原始 release（线上答案或本机缓存里的同形对象）折成日志四字段。 */
  function logEntryOf(raw) {
    if (!raw) return null;
    var tag = raw.tag_name || raw.tag;
    if (!tag) return null;
    return { tag: tag, name: raw.name || tag, published_at: raw.published_at || '', body: raw.body || '' };
  }

  function logStamp(iso) {    var d = new Date(iso || '');
    if (isNaN(d.getTime())) return '';
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  function safeLink(url) {
    return /^https:\/\/[^\s"'<>]+$/.test(String(url || '')) ? url : '';
  }

  /**
   * 只显示最新一个版本（用户要求：三条历史太啰嗦，内容也要像样）。
   * 首选 state.changelog —— mirror-apk 生成的玩家日志（compare + 关联 PR 的中文标题）；
   * 它缺席（老版本、或那次发布还没生成）才退回 release 正文提炼。
   */
  function renderLog() {
    if (!el.log) return;
    var release = state.release;
    el.log.textContent = '';
    if (!release) { el.log.hidden = true; return; }

    var cl = (state.changelog && state.changelog.tag === release.tag) ? state.changelog : null;
    var entry = null;
    if (!cl) {
      var list = (state.history || []).filter(function (e) { return e && e.tag; });
      entry = list.filter(function (e) { return e.tag === release.tag; })[0] || list[0] || null;
      if (!entry) { el.log.hidden = true; return; }
    }

    var row = document.createElement('div');
    row.className = 'dl-log__row is-latest';
    var head = document.createElement('div');
    head.className = 'dl-log__head';
    var ver = document.createElement('span');
    ver.className = 'dl-log__ver';
    ver.textContent = String(release.tag).replace(/^shell-/, '');
    var when = document.createElement('span');
    when.className = 'dl-log__time';
    when.textContent = logStamp((cl && cl.published_at) || entry && entry.published_at || release.published_at);
    head.appendChild(ver);
    head.appendChild(when);
    row.appendChild(head);

    var lines = [];
    if (cl) {
      (cl.items || []).slice(0, LOG_MAX_ITEMS).forEach(function (i) {
        if (i && i.text) lines.push({ text: clip(i.text, LOG_CLIP), pr: i.pr, html: i.html });
      });
      if (!lines.length) lines.push({ text: '构建更新（内容走热更新，明细见发布页）' });
    } else {
      var sum = summarize(entry);
      if (sum.head) lines.push({ text: sum.head });
      sum.bullets.forEach(function (b) { lines.push({ text: b }); });
      if (!lines.length) lines.push({ text: '构建更新（内容走热更新，明细见发布页）' });
    }
    lines.forEach(function (l) {
      var line = document.createElement('div');
      line.className = 'dl-log__bullet';
      line.textContent = '· ';
      var href = safeLink(l.html);
      if (href) {
        var a = document.createElement('a');
        a.className = 'dl-log__link';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = l.text;
        if (l.pr) a.title = 'PR #' + l.pr;
        line.appendChild(a);
      } else {
        line.appendChild(document.createTextNode(l.text));
      }
      row.appendChild(line);
    });

    var foot = document.createElement('div');
    foot.className = 'dl-log__foot';
    var more = document.createElement('a');
    var moreHref = safeLink((cl && cl.url) || release.html_url);
    if (moreHref) {
      more.className = 'dl-log__link';
      more.href = moreHref;
      more.target = '_blank';
      more.rel = 'noopener noreferrer';
      more.textContent = '完整说明与校验值';
      foot.appendChild(more);
    }
    if (cl && cl.internal_count) {
      foot.appendChild(document.createTextNode(' · 另有 ' + cl.internal_count + ' 条流水线/构建改动未列出'));
    }
    if (foot.childNodes.length) row.appendChild(foot);
    el.log.appendChild(row);
    el.log.hidden = false;
  }

  /* ---- helpers --------------------------------------------------------------------- */

  function fmtMB(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function allowedHosts() {
    var hosts = { 'github.com': true, 'api.github.com': true };
    hosts[FIRST_PARTY_HOST] = true;
    state.mirrors.forEach(function (m) {
      [m.prefix, m.template].forEach(function (tpl) {
        if (!tpl) return;
        try { var h = new URL(tpl).host; if (!isBlockedHost(h)) hosts[h] = true; } catch (e) { /* ignore malformed */ }
      });
    });
    return hosts;
  }

  /** The URL mirrors accelerate: the GitHub release asset (accelerators only proxy
   *  GitHub URLs), falling back to the asset itself for direct mode. */
  function mirrorSource(asset, tag) {
    if (state.release && state.release.ghAsset) {
      return { name: 'app-release.apk', url: state.release.ghAsset, external: false };
    }
    return asset;
  }

  function buildMirrorUrl(mirror, asset, tag) {
    var source = mirrorSource(asset, tag);
    var url = null;
    if (mirror.mode === 'direct') url = source.url;
    else if (mirror.mode === 'prefix') url = mirror.prefix + source.url;
    else if (mirror.mode === 'template') {
      if (Array.isArray(mirror.tags) && mirror.tags.indexOf(tag) === -1) return null;
      url = mirror.template.replace('{tag}', tag).replace('{name}', source.name);
    }
    if (!url) return null;
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== 'https:') return null;
      if (!allowedHosts()[parsed.host]) return null;
      return url;
    } catch (e) {
      return null;
    }
  }

  function timeoutSignal(ms) {
    var ctrl = new AbortController();
    setTimeout(function () { ctrl.abort(); }, ms);
    return ctrl.signal;
  }

  /** Newest stable release that carries an APK. The same-origin edge endpoint comes first:
   *  it works where the browser cannot reach api.github.com (per-IP 403s are the norm on
   *  shared and mainland-China uplinks, and falling back to the bundled snapshot silently
   *  showed an older version as if it were current). Resolves to null when nothing answered. */
  function fetchLatestWithApk() {
    return fetchJson(API_EDGE, API_TIMEOUT_MS).then(function (rel) {
      var latest = normalizeRelease(rel);
      if (!hasApk(latest)) return null;
      if (typeof rel._ghDownloads === 'number') state.ghDownloads = rel._ghDownloads;
      // 日志优先用线上给的 _history；它缺席时只用当前这条，绝不混打包快照里的旧列表
      state.history = (Array.isArray(rel._history) && rel._history.length)
        ? rel._history : [logEntryOf(rel)].filter(Boolean);
      state.cdn = rel._cdn || null;
      if (rel._changelog && rel._changelog.tag) state.changelog = rel._changelog;
      state.versionSuffix = rel._stale ? '（缓存版本）' : '';
      writeOfflineCache(rel);
      return latest;
    }).catch(function () { return null; }).then(function (fromEdge) {
      if (fromEdge) return fromEdge;
      return fetchLatestFromGithub().then(function (latest) {
        state.versionSuffix = '';
        return latest;
      }).catch(function () { return null; });
    });
  }

  function fetchLatestFromGithub() {
    return fetchJson(API_LATEST, API_TIMEOUT_MS).then(function (rel) {
      var latest = normalizeRelease(rel);
      if (hasApk(latest)) {
        // 只有单条可用时也比"没有日志"好；/api/latest 活着时不会走到这里
        if (!state.history) state.history = [logEntryOf(rel)];
        writeOfflineCache(rel);
        return latest;
      }
      return fetchJson(API_LIST, API_TIMEOUT_MS).then(function (list) {
        var entries = (Array.isArray(list) ? list : []).map(logEntryOf).filter(Boolean);
        if (entries.length) state.history = entries;
        var picked = pickRelease(list);
        if (picked) writeOfflineCache(picked);
        return normalizeRelease(picked);
      });
    });
  }

  /* ---- data ------------------------------------------------------------------------ */

  function fetchJson(url, ms) {
    return fetch(url, {
      signal: timeoutSignal(ms),
      cache: 'no-store',
      headers: { 'accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /**
   * 线上答案存一份到本地：打包快照会随仓库变旧，而回访的浏览器手上有一份真实的、
   * 最近一次从线上拿到的 release。线上不可达时它比打包的那份更接近最新。
   * 只存 release 本身（不带 _cdn / _history —— 那些是这一轮探测的结果，缓存起来就是撒谎）。
   */
  function writeOfflineCache(rel) {
    if (!rel || !rel.tag_name || rel._stale) return;
    try {
      localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(),
        rel: {
          tag_name: rel.tag_name, name: rel.name, published_at: rel.published_at,
          prerelease: !!rel.prerelease, draft: false, body: String(rel.body || '').slice(0, 4000),
          assets: (rel.assets || []).map(function (a) {
            return { name: a.name, size: a.size, browser_download_url: a.browser_download_url,
                     digest: a.digest || null, external: !!a.external };
          })
        }
      }));
    } catch (e) { /* 隐私模式或配额满：退回打包快照 */ }
  }

  function readOfflineCache() {
    try {
      var doc = JSON.parse(localStorage.getItem(OFFLINE_CACHE_KEY) || 'null');
      if (!doc || !doc.rel || !doc.rel.tag_name || !Number.isFinite(doc.savedAt)) return null;
      var ageMs = Date.now() - doc.savedAt;
      // 超过一天就干脆不画：一份没人确认过的旧版本写进"最新版"三个字里，比空着更糟
      if (!(ageMs >= 0) || ageMs > OFFLINE_TRUST_MS) return null;
      var release = normalizeRelease(doc.rel);
      return hasApk(release) ? { release: release, ageMs: ageMs } : null;
    } catch (e) { return null; }
  }

  function normalizeRelease(rel) {
    if (!rel || !Array.isArray(rel.assets)) return null;
    var release = {
      tag: rel.tag_name,
      name: rel.name || rel.tag_name,
      publishedAt: rel.published_at,
      prerelease: !!rel.prerelease,
      draft: !!rel.draft,
      assets: rel.assets.map(function (a) {
        return { name: a.name, size: a.size, url: a.browser_download_url, digest: a.digest || null,
                 external: !!a.external };
      })
    };
    // Prefer a first-party direct link when the notes carry one (R2 CDN beats the GitHub
    // asset URL); otherwise keep the .apk release asset. Either way the page shows a
    // single APK download. The GitHub asset URL is kept separately as `ghAsset` so the
    // public accelerators (which only proxy GitHub URLs) can still be offered as mirrors.
    var notesLink = apkLinkFromBody(rel.body);
    if (notesLink && allowedHostsExt(notesLink)) {
      var ghApk = null;
      release.assets.forEach(function (a) { if (!ghApk && /\.apk$/i.test(a.name)) ghApk = a; });
      // The first-party object is a copy of *this* release asset (mirror-apk checks its
      // sha256, promote.yml publishes a byte-for-byte copy), so the asset's size and digest
      // describe exactly what the direct link serves. Replacing the whole asset with the
      // link used to blank the size line and hide the SHA256 button.
      var ours = new URL(notesLink).host === FIRST_PARTY_HOST;
      var size = ours ? ghApk && ghApk.size : null;
      var digest = ours ? ghApk && ghApk.digest : null;
      if (!size) { // no release asset to quote (APK shipped out-of-band): trust the notes text
        var sizeMatch = String(rel.body || '').match(/([\d.]+)\s*(MB|MiB|GB|GiB)/i);
        size = sizeMatch ? Math.round(parseFloat(sizeMatch[1]) *
          (sizeMatch[2].toUpperCase().charAt(0) === 'G' ? 1073741824 : 1048576)) : null;
      }
      // The edge measured this exact object on this request; its byte length beats the
      // asset's, and once they differ the release digest is no longer the served file's.
      var cdn = rel._cdn;
      if (ours && cdn && cdn.ok && cdn.size) {
        if (cdn.size !== size) digest = null;
        size = cdn.size;
      }
      release.assets = release.assets.filter(function (a) { return !/\.apk$/i.test(a.name); });
      release.assets.push({
        name: notesLink.split('/').pop().split(/[?#]/)[0] || 'app-release.apk',
        size: size,
        url: notesLink,
        digest: digest || null,
        external: true
      });
    }
    var apkAsset = hasApk(release) ? release.assets.filter(function (a) { return /\.apk$/i.test(a.name); })[0] : null;
    if (apkAsset && !apkAsset.external) {
      release.ghAsset = apkAsset.url; // e.g. https://github.com/<repo>/releases/download/<tag>/<file>
    } else if (apkAsset) {
      // External link chosen: reconstruct the GitHub asset URL for the accelerators from
      // the release tag (asset names are stable across releases).
      release.ghAsset = 'https://github.com/' + 'jingjiangze/Stronghold-Protocol' +
        '/releases/download/' + release.tag + '/app-release.apk';
    }
    return release;
  }

  /** Host allowlist for notes-derived links: https only + the mirrors' own hosts. */
  function allowedHostsExt(urlText) {
    try {
      var parsed = new URL(urlText);
      if (parsed.protocol !== 'https:') return false;
      var hosts = allowedHosts();
      return !!hosts[parsed.host];
    } catch (err) { return false; }
  }

  function pickRelease(releases) {
    // Newest stable release that carries an APK — either as a release asset or as an
    // APK URL found in the release notes (newer builds ship the APK out-of-band).
    var stable = (releases || []).filter(function (r) { return !r.draft && !r.prerelease; });
    var withApk = stable.filter(hasApk);
    return withApk[0] || null;
  }

  function hasApk(rel) {
    return !!(rel && rel.assets && rel.assets.length &&
      rel.assets.some(function (a) { return /\.apk$/i.test(a.name); }));
  }

  /** Extract an APK direct link from the release notes (first https URL ending in .apk). */
  function apkLinkFromBody(body) {
    var text = String(body || '');
    var urls = text.match(/https?:\/\/[^\s\)\]\"<>]+/g) || [];
    for (var i = 0; i < urls.length; i += 1) {
      if (/\.apk($|[?#])/i.test(urls[i])) return urls[i];
    }
    return null;
  }

  function pickAsset(release) {
    if (!release || !release.assets.length) return null;
    var exact = release.assets.filter(function (a) { return a.name === PRIMARY_ASSET; })[0];
    if (exact) return exact;
    return release.assets.filter(function (a) { return /\.apk$/i.test(a.name); })[0] || release.assets[0];
  }

  /* ---- rendering ------------------------------------------------------------------- */

  function mirrorButton(mirror, url, asset) {
    var a = document.createElement('a');
    a.className = 'btn btn--secondary btn--sm dl-mirror';
    a.href = url;
    a.rel = 'noopener';
    a.referrerPolicy = 'no-referrer';
    a.title = '通过 ' + mirror.name + ' 下载'
      + (mirror.mode === 'prefix' ? '（代理 GitHub 资产，第三方可能缓存旧字节或同步滞后）' : '')
      + (mirror.range === false ? '；该镜像不支持断点续传' : '');

    var label = document.createElement('span');
    label.className = 'btn__label';
    var nameSpan = document.createElement('span');
    nameSpan.textContent = mirror.name;
    label.appendChild(nameSpan);
    a.appendChild(label);

    var badge = badgeFor(mirror);
    if (badge) a.appendChild(badge);
    return a;
  }

  function badgeFor(mirror) {
    var text = null;
    var gold = false;
    if (mirror.mode === 'template' && mirror.id === 'r2') { text = '首方'; }
    if (state.measured[mirror.id] && state.measured[mirror.id].fastest) { text = '实测最快'; gold = true; }
    else if (state.measured[mirror.id]) { text = state.measured[mirror.id].mbps.toFixed(1) + ' MB/s'; }
    if (!text) return null;
    var span = document.createElement('span');
    span.className = 'dl-badge' + (gold ? ' dl-badge--gold' : '');
    span.textContent = text;
    return span;
  }

  /** First-party R2 link, built from what the edge actually verified (`_cdn`). It leads the
   *  row because the public accelerators proxy GitHub and can lag or serve cached bytes, so
   *  only our own object is guaranteed to be the release the page is naming. */
  function firstPartyButton() {
    var cdn = state.cdn;
    if (!cdn || !cdn.ok || !cdn.url) return null;
    var parsed;
    try { parsed = new URL(cdn.url); } catch (e) { return null; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== FIRST_PARTY_HOST) return null;

    var a = document.createElement('a');
    a.className = 'btn btn--secondary btn--sm dl-mirror is-active';
    a.href = cdn.url;
    a.rel = 'noopener';
    a.referrerPolicy = 'no-referrer';
    a.title = 'CDN加速（Cloudflare R2 首方直链）· 与本页版本同一构建，支持断点续传';
    var label = document.createElement('span');
    label.className = 'btn__label';
    var name = document.createElement('span');
    name.textContent = 'CDN加速';
    label.appendChild(name);
    a.appendChild(label);
    var badge = document.createElement('span');
    badge.className = 'dl-badge dl-badge--gold';
    badge.textContent = cdn.reason === 'size-close' ? '推荐 · 字节差 ' + (cdn.size - cdn.expected) : '推荐';
    a.appendChild(badge);
    return a;
  }

  function renderMirrors() {
    if (!el.mirrors) return;
    el.mirrors.textContent = '';
    // 微信里连镜像按钮也不渲染：每一个都是 .apk 直链，微信正是按这个拦页面。
    if (IN_WECHAT) { el.mirrors.hidden = true; return; }
    var applicable = 0;
    var firstParty = firstPartyButton();
    if (firstParty) {
      el.mirrors.appendChild(firstParty);
      applicable += 1;
    }
    state.mirrors.forEach(function (mirror) {
      var url = buildMirrorUrl(mirror, state.asset, state.release.tag);
      if (!url) return;
      applicable += 1;
      if (state.primaryMirrorId === null) state.primaryMirrorId = mirror.id;
      el.mirrors.appendChild(mirrorButton(mirror, url, state.asset));
    });
    if (!applicable) setText(el.note, '镜像清单暂不可用，请直接使用上方下载按钮。');
  }

  function render() {
    var release = state.release;
    var asset = state.asset;
    if (!release || !asset) return;

    setText(el.version, '最新版 ' + release.tag + state.versionSuffix);
    setText(el.size, fmtMB(asset.size));

    // 维护模式：不渲染任何下载入口（主按钮 / 镜像行 / 校验值 / 日志里的下载链接），
    // 只保留版本号、大小等信息。跳过速度探测（维护期间探测结果无意义）。
    if (MAINTENANCE) {
      if (el.primary) { el.primary.hidden = true; el.primary.removeAttribute('href'); }
      if (el.mirrors) { el.mirrors.textContent = ''; el.mirrors.hidden = true; }
      if (el.hash) el.hash.hidden = true;
      renderLog();
      setText(el.note, MAINTENANCE_NOTE);
      return;
    }

    setText(el.primaryLabel, '下载 Android 客户端');

    // Be explicit when the primary button cannot use the first-party CDN: the fallback is
    // slower by design, and silence here is what made "slow download" undiagnosable.
    var cdnText = cdnNote(state.cdn);
    if (cdnText) setText(el.note, cdnText);

    if (asset.digest && el.hash) {
      el.hash.hidden = false;
      el.hash.dataset.sha = asset.digest;
      el.hash.title = '复制 SHA256 校验值\n' + asset.digest;
    } else if (el.hash) {
      el.hash.hidden = true;
      delete el.hash.dataset.sha;
    }

    renderMirrors();
    renderLog();
    applyPrimary();
  }

  /** Primary button always routes through the counting redirect (/api/download/<tag>/<file>).
   *  The server verifies the first-party CDN copy and answers with a *query-free* CDN URL:
   *  the R2 custom domain ignores Range as soon as the request carries a query string
   *  (200 + whole body), so a `?cb=` direct link silently costs users resume support and
   *  makes multi-connection downloaders refetch the entire file per connection. */
  function countedUrl() {
    if (!state.release) return null;
    return '/api/download/' + encodeURIComponent(state.release.tag) + '/' + PRIMARY_ASSET;
  }

  function applyPrimary() {
    // 微信内不渲染下载入口（见 IN_WECHAT 注释）：隐藏主按钮，镜像行同样清空。
    if (IN_WECHAT) {
      if (el.primary) el.primary.hidden = true;
      renderMirrors();
      return;
    }
    var counted = countedUrl();
    var url = null;
    var chosen = null;
    var fastest = fastestMirror();
    if (fastest) chosen = fastest;
    else {
      for (var i = 0; i < state.mirrors.length; i += 1) {
        var m = state.mirrors[i];
        var candidate = buildMirrorUrl(m, state.asset, state.release.tag);
        if (candidate) { chosen = m; url = candidate; break; }
      }
    }
    if (chosen) {
      state.primaryMirrorId = chosen.id;
      el.primary.href = counted || url;
      // The href is a server-side route, so the label must not name a mirror the server may
      // not pick. Say what is actually decided: verified first-party CDN, or a fallback.
      el.primary.title = '下载最新版 Android 客户端（' +
        (!state.cdn ? chosen.name :
          state.cdn.ok ? 'CDN加速' : 'CDN加速未校验 · 服务端自动选加速器') + '）';
    }
    renderMirrors();
  }

  function fastestMirror() {
    var best = null;
    var bestMbps = 0;
    state.mirrors.forEach(function (m) {
      var probe = state.measured[m.id];
      if (probe && probe.mbps > bestMbps && buildMirrorUrl(m, state.asset, state.release.tag)) {
        best = m;
        bestMbps = probe.mbps;
      }
    });
    return best;
  }

  /* ---- browser speed probe (only for mirrors that send CORS headers) ---------------- */

  function probeMirrors() {
    if (navigator.connection && navigator.connection.saveData) return Promise.resolve();
    var targets = state.mirrors.filter(function (m) {
      return m.cors === true && buildMirrorUrl(m, state.asset, state.release.tag);
    });
    var chain = Promise.resolve();
    targets.forEach(function (mirror) {
      chain = chain.then(function () { return probeOne(mirror); });
    });
    return chain;
  }

  function probeOne(mirror) {
    var url = buildMirrorUrl(mirror, state.asset, state.release.tag);
    if (!url) return Promise.resolve();
    var started = Date.now();
    var received = 0;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, PROBE_TIMEOUT_MS);
    // Plain GET (no custom headers: keeps it a simple request, so no CORS preflight),
    // read the stream until PROBE_BYTES and then abort the transfer.
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (!res.body || !res.body.getReader) return res.arrayBuffer();
        var reader = res.body.getReader();
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return received;
            received += chunk.value.byteLength;
            if (received >= PROBE_BYTES) {
              try { ctrl.abort(); } catch (err) { /* already aborted */ }
              return received;
            }
            return pump();
          });
        }
        return pump();
      })
      .then(function (bytes) {
        clearTimeout(timer);
        if (bytes > 0) {
          var seconds = Math.max((Date.now() - started) / 1000, 0.05);
          state.measured[mirror.id] = { mbps: (bytes / 1048576) / seconds };
        }
        return bytes;
      })
      .catch(function () {
        clearTimeout(timer);
        if (received > 0) {
          var seconds = Math.max((Date.now() - started) / 1000, 0.05);
          state.measured[mirror.id] = { mbps: (received / 1048576) / seconds };
          return received;
        }
        state.measured[mirror.id] = { mbps: 0, failed: true };
        return 0;
      });
  }

  function announceProbe() {
    var id = state.primaryMirrorId;
    var probe = id ? state.measured[id] : null;
    if (probe && probe.mbps > 0) {
      var m = state.mirrors.filter(function (x) { return x.id === id; })[0];
      setText(el.note, '已实测：' + (m ? m.name : id) + ' ≈ ' + probe.mbps.toFixed(1) +
        ' MB/s（本次网络）· 支持断点续传；慢时切换其它镜像' +
        (state.cdn && state.cdn.ok === false ? ' · CDN加速未通过校验，主按钮走加速器' : ''));
      var fastest = fastestMirror();
      Object.keys(state.measured).forEach(function (key) { state.measured[key].fastest = false; });
      if (fastest && state.measured[fastest.id]) state.measured[fastest.id].fastest = true;
      renderMirrors();
    }
  }

  /* ---- hash copy ------------------------------------------------------------------- */

  function copyText(value, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, function () { window.prompt(value, value); });
    } else {
      window.prompt(value, value);
    }
  }

  /** QQ group number: tap opens the QQ join page; 复制 copies the number. */
  function wireQqFooter() {
    var copyBtn = document.getElementById('dl-qq-copy');
    if (!copyBtn) return;
    var done = function () {
      copyBtn.classList.add('is-done');
      var old = copyBtn.textContent;
      copyBtn.textContent = '已复制';
      setTimeout(function () { copyBtn.classList.remove('is-done'); copyBtn.textContent = old; }, 1600);
    };
    copyBtn.addEventListener('click', function () { copyText('293032860', done); });
    copyBtn.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); copyText('293032860', done); }
    });
  }

  function wireHashButton() {
    if (!el.hash) return;
    el.hash.addEventListener('click', function () {
      var value = el.hash.dataset.sha || '';
      if (!value) return;
      var done = function () {
        el.hash.classList.add('is-done');
        var old = el.hash.textContent;
        el.hash.textContent = '已复制';
        setTimeout(function () { el.hash.classList.remove('is-done'); el.hash.textContent = old; }, 1600);
      };
      copyText(value, done);
    });
  }

  /** Total download count = GitHub release assets (download_count, all releases) + the
   *  page's own counted redirects. Rendered in the meta line, gold, best-effort. The edge
   *  endpoint already sums the GitHub side, so the browser only calls GitHub when it has to. */
  function fetchDownloadTotal() {
    if (!el.downloads) return;
    var ghSide;
    if (typeof state.ghDownloads === 'number') {
      ghSide = Promise.resolve(state.ghDownloads);
    } else {
      ghSide = fetchJson(API_DOWNLOADS, 9000).then(function (list) {
        var n = 0;
        (Array.isArray(list) ? list : []).forEach(function (r) {
          (r.assets || []).forEach(function (a) {
            if (/\.apk$/i.test(a.name)) n += a.download_count || 0;
          });
        });
        return n;
      }).catch(function () { return 0; });
    }
    ghSide.then(function (ghCount) {
      return fetchJson('/api/download/total', 6000).then(function (out) {
        return out && out.ok ? (out.total || 0) : 0;
      }).catch(function () { return 0; }).then(function (fnCount) { return ghCount + fnCount; });
    }).then(function (total) {
      if (total <= 0) return;
      el.downloads.hidden = false;
      setText(el.downloads, '⬇ ' + total.toLocaleString('zh-CN') + ' 次下载');
    });
  }

  /* ---- boot ------------------------------------------------------------------------ */

  /**
   * 这里一天发好几个版本，而标签页可以开着一整天不动 —— 那一屏没人刷新过，却是玩家眼里的
   * "最新版"。可见时每 10 分钟重问一次线上，顺便重测 CDN 有没有这份构建；后台标签页不打扰。
   */
  function watchForNewRelease() {
    setInterval(function () {
      if (document.hidden) return;
      fetchLatestWithApk().then(function (live) {
        if (!live) return;
        if (state.release && live.tag !== state.release.tag) state.measured = {};
        state.release = live;
        state.asset = pickAsset(live);
        render();
        if (MAINTENANCE) return;
        probeMirrors().then(announceProbe).catch(function () { /* 测速尽力而为 */ });
      }).catch(function () { /* 线上没答案就保留当前这一屏 */ });
    }, 10 * 60 * 1000);
  }

  /** 微信内置浏览器：政策上不允许在微信里直接下载 APK，点下载只会被拦（10-08 用户反馈
   *  「微信说含下载内容不安全」）。这与本站的安全状态无关，但玩家看到的就是"打不开"，
   *  所以检测到 MicroMessenger 时直接把两条出路摆出来：右上角「在浏览器打开」，或复制链接。
   *  页面本身不做任何跳转/诱导，也不影响其它浏览器的正常下载。 */
  function wireWeChatHint() {
    var box = document.getElementById('dl-wx');
    if (!box) return;
    if (!/MicroMessenger/i.test(navigator.userAgent)) return;
    box.hidden = false;
    // 主按钮在静态 HTML 里带一个 GitHub 兜底链接，先立刻藏掉，别让微信用户点到一个
    // 会被拦的下载入口（applyPrimary 里还会再藏一次，那是数据到位后的兜底）。
    var primary = document.getElementById('dl-primary');
    if (primary) primary.hidden = true;
    var btn = document.getElementById('dl-wx-copy');
    if (!btn) return;
    btn.addEventListener('click', function () {
      copyText(location.href.split('#')[0], function () {
        btn.classList.add('is-done');
        var old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(function () { btn.classList.remove('is-done'); btn.textContent = old; }, 1600);
      });
    });
  }

  function start() {
    wireHashButton();
    wireQqFooter();
    wireWeChatHint();
    watchForNewRelease();

    // 镜像清单只是按钮列表，它拿不到不该带走整页 —— 版本号和离线快照都跟它无关
    // （实测部署传播的那十几秒里这里一失败，页面就变成"暂无法获取版本信息"）。
    fetchJson('./data/mirrors.json', 8000).catch(function () { return null; }).then(function (data) {
      state.mirrors = (data && data.mirrors) || [];
      // 首屏只允许画"这个浏览器自己最近一次从线上拿到的答案"（≤24 小时）。
      // 仓库里那份打包快照 data/releases.json 已删：GitHub Pages 那份镜像没有 Functions，
      // /api/latest 永远 404，于是整站只能展示打包的旧版本 —— 10-06 就有访客在镜像上反复
      // 看到 shell-v2.9.2，而那时候真值已经是 2.9.27。宁可显示"拿不到版本信息"。
      var offline = readOfflineCache();
      if (offline) {
        state.release = offline.release;
        state.asset = pickAsset(offline.release);
        render();
      }
      return fetchLatestWithApk().then(function (live) {
        if (live) {
          if (state.release && live.tag !== state.release.tag) state.measured = {};
          state.release = live;
          state.asset = pickAsset(live);
        } else if (state.release) {
          // Nothing answered: what is on screen came from this browser's own earlier live
          // answer and may be an older build — label it instead of presenting it as latest.
          state.versionSuffix = '（离线快照，可能非最新）';
        }
        render();
      });
    }).then(function () {
      fetchDownloadTotal();
      if (!state.release || !state.asset) {
        setText(el.version, '暂无法获取版本信息');
        setText(el.note, '请点击上方按钮前往 GitHub Releases 页面下载。');
        return;
      }
      if (MAINTENANCE) return;
      return probeMirrors()
        .then(announceProbe)
        .catch(function () { /* probe is best-effort */ });
    }).catch(function () {
      setText(el.version, '暂无法获取版本信息');
      setText(el.note, '请点击上方按钮前往 GitHub Releases 页面下载。');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
