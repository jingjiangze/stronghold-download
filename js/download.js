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
  var API_EDGE = '/api/latest';
  var API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var API_LIST = 'https://api.github.com/repos/' + REPO + '/releases?per_page=10';
  var API_DOWNLOADS = 'https://api.github.com/repos/' + REPO + '/releases?per_page=100';
  var PRIMARY_ASSET = 'app-release.apk';
  var PROBE_BYTES = 3 * 1024 * 1024;
  var PROBE_TIMEOUT_MS = 12000;
  var API_TIMEOUT_MS = 9000;

  var el = {
    primary: document.getElementById('dl-primary'),
    primaryLabel: document.getElementById('dl-primary-label'),
    mirrors: document.getElementById('dl-mirrors'),
    version: document.getElementById('dl-version'),
    size: document.getElementById('dl-size'),
    hash: document.getElementById('dl-hash'),
    note: document.getElementById('dl-note'),
    downloads: document.getElementById('dl-downloads')
  };

  var state = {
    release: null, asset: null, mirrors: [], measured: {}, primaryMirrorId: null,
    versionSuffix: '', ghDownloads: null, cdn: null
  };

  var CDN_REASON = {
    missing: '首方 CDN 还没有这个构建',
    'size-unknown': '无法校验首方 CDN 上的构建',
    'probe-failed': '首方 CDN 探测超时'
  };

  /** Why the primary button is not using the first-party CDN, in one readable line. The
   *  byte counts are printed because "size-mismatch" is only actionable with them. */
  function cdnNote(cdn) {
    if (!cdn || cdn.ok !== false) return '';
    var why = cdn.reason === 'size-mismatch' && cdn.size && cdn.expected
      ? '首方 CDN 上的同名文件与本版本字节数不一致（CDN ' + cdn.size + ' B · 发布 ' + cdn.expected + ' B）'
      : (CDN_REASON[cdn.reason] || '首方 CDN 暂不可用');
    return why + ' · 主按钮改走公共加速器，也可点上方镜像按钮换源';
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
    state.mirrors.forEach(function (m) {
      [m.prefix, m.template].forEach(function (tpl) {
        if (!tpl) return;
        try { hosts[new URL(tpl).host] = true; } catch (e) { /* ignore malformed */ }
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
      state.cdn = rel._cdn || null;
      state.versionSuffix = rel._stale ? '（缓存版本）' : '';
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
      if (hasApk(latest)) return latest;
      return fetchJson(API_LIST, API_TIMEOUT_MS).then(function (list) {
        return normalizeRelease(pickRelease(list));
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
      var sizeMatch = String(rel.body || '').match(/([\d.]+)\s*(MB|MiB|GB|GiB)/i);
      var size = sizeMatch ? Math.round(parseFloat(sizeMatch[1]) *
        (sizeMatch[2].toUpperCase().charAt(0) === 'G' ? 1073741824 : 1048576)) : null;
      release.assets = release.assets.filter(function (a) { return !/\.apk$/i.test(a.name); });
      release.assets.push({
        name: notesLink.split('/').pop().split(/[?#]/)[0] || 'app-release.apk',
        size: size,
        url: notesLink,
        digest: null,
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
    a.title = '通过 ' + mirror.name + ' 下载' + (mirror.range === false ? '（该镜像不支持断点续传）' : '');

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

  function renderMirrors() {
    if (!el.mirrors) return;
    el.mirrors.textContent = '';
    var applicable = 0;
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
          state.cdn.ok ? '首方 CDN' : '首方 CDN 未校验 · 服务端自动选加速器') + '）';
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

  /* ---- mirror manifests (R2 first-party mirror advertises what it holds) ------------ */

  function refreshManifests() {
    var targets = state.mirrors.filter(function (m) { return !!m.manifest; });
    return Promise.all(targets.map(function (mirror) {
      return fetchJson(mirror.manifest, 8000).then(function (manifest) {
        // Base URL must stay on the mirror's own host before anything is built from it.
        var host = null;
        try { host = new URL(mirror.manifest).host; } catch (err) { host = null; }
        if (!host || !manifest || typeof manifest.tag !== 'string') return;
        if (!allowedHosts()[host]) return;
        var names = Array.isArray(manifest.assets) ? manifest.assets : [];
        var holdsApk = !names.length || names.some(function (n) { return n === state.asset.name; });
        if (holdsApk) mirror.tags = [manifest.tag];
      }).catch(function () { /* unreachable manifest: keep the static tags gate */ });
    })).then(function () {
      render();
    });
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
        (state.cdn && state.cdn.ok === false ? ' · 首方 CDN 未通过校验，主按钮走加速器' : ''));
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

  function start() {
    wireHashButton();
    wireQqFooter();

    fetchJson('./data/mirrors.json', 8000).then(function (data) {
      state.mirrors = (data && data.mirrors) || [];
      // First paint with the bundled snapshot, then refresh from the live API.
      return fetchJson('./data/releases.json', 8000).catch(function () { return null; }).then(function (snap) {
        if (snap && snap.releases) {
          state.release = normalizeRelease(pickRelease(snap.releases.map(function (r) {
            return { tag_name: r.tag, name: r.name, published_at: r.published_at, prerelease: r.prerelease,
              draft: false, body: r.body || '', assets: r.assets.map(function (a) {
                return { name: a.name, size: a.size, browser_download_url: a.url, digest: a.digest,
                         external: !!a.external };
              }) };
          })));
          state.asset = pickAsset(state.release);
          render();
        }
        return fetchLatestWithApk().then(function (live) {
          if (live) {
            if (!state.release || live.tag !== state.release.tag) {
              state.release = live;
              state.asset = pickAsset(live);
              state.measured = {};
            }
          } else if (state.release) {
            // Nothing answered: what is on screen came from the bundled snapshot and may be
            // an older build — label it instead of presenting it as the latest.
            state.versionSuffix = '（离线快照，可能非最新）';
          }
          render();
        });
      });
    }).then(function () {
      fetchDownloadTotal();
      if (!state.release || !state.asset) {
        setText(el.version, '暂无法获取版本信息');
        setText(el.note, '请点击上方按钮前往 GitHub Releases 页面下载。');
        return;
      }
      return refreshManifests()
        .then(function () { return probeMirrors(); })
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
