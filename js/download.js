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
  var API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var API_LIST = 'https://api.github.com/repos/' + REPO + '/releases?per_page=10';
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
    note: document.getElementById('dl-note')
  };

  var state = { release: null, asset: null, mirrors: [], measured: {}, primaryMirrorId: null };

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

  function buildMirrorUrl(mirror, asset, tag) {
    var url = null;
    if (asset.external) {
      // Notes-derived direct link: it already points at the mirror host itself, so
      // prefix/template acceleration does not apply — offer it as-is only.
      if (mirror.mode !== 'direct') return null;
      url = asset.url;
    } else if (mirror.mode === 'direct') url = asset.url;
    else if (mirror.mode === 'prefix') url = mirror.prefix + asset.url;
    else if (mirror.mode === 'template') {
      if (Array.isArray(mirror.tags) && mirror.tags.indexOf(tag) === -1) return null;
      url = mirror.template.replace('{tag}', tag).replace('{name}', asset.name);
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

  /** Newest stable release that carries an APK; falls back to the release list when the
   *  brand-newest release exists but its APK has not been attached yet. */
  function fetchLatestWithApk() {
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
        return { name: a.name, size: a.size, url: a.browser_download_url, digest: a.digest || null };
      })
    };
    // Newer releases ship the APK out-of-band: the notes carry a direct .apk link (with a
    // fallback size when the notes mention one). Normalize it into a pseudo-asset so the
    // rest of the page treats it exactly like a release asset.
    if (!hasApk(release)) {
      var link = apkLinkFromBody(rel.body);
      if (link && allowedHostsExt(link)) {
        var sizeMatch = String(rel.body || '').match(/([\d.]+)\s*(MB|MiB|GB|GiB)/i);
        var size = sizeMatch ? Math.round(parseFloat(sizeMatch[1]) *
          (sizeMatch[2].toUpperCase().charAt(0) === 'G' ? 1073741824 : 1048576)) : null;
        release.assets.push({
          name: link.split('/').pop().split(/[?#]/)[0] || 'app-release.apk',
          size: size,
          url: link,
          digest: null,
          external: true
        });
      }
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
    // Notes-derived direct links point at the mirror host itself; there is nothing to
    // accelerate, so only the primary button is offered.
    if (state.asset && state.asset.external) return;
    var applicable = 0;
    state.mirrors.forEach(function (mirror) {
      var url = buildMirrorUrl(mirror, state.asset, state.release.tag);
      if (!url) return;
      applicable += 1;
      if (state.primaryMirrorId === null) state.primaryMirrorId = mirror.id;
      el.mirrors.appendChild(mirrorButton(mirror, url, state.asset));
    });
    if (!applicable) setText(el.note, '镜像清单暂不可用，可直接使用上方按钮从 GitHub 下载。');
  }

  function render() {
    var release = state.release;
    var asset = state.asset;
    if (!release || !asset) return;

    setText(el.version, '最新版 ' + release.tag);
    setText(el.size, fmtMB(asset.size));
    setText(el.primaryLabel, '下载 Android 客户端');

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

  function applyPrimary() {
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
    if (chosen && !url) url = buildMirrorUrl(chosen, state.asset, state.release.tag);
    if (!url) return;
    state.primaryMirrorId = chosen.id;
    el.primary.href = url;
    el.primary.title = '下载最新版 Android 客户端（' + chosen.name + '）';
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
      setText(el.note, '已实测：' + (m ? m.name : id) + ' ≈ ' + probe.mbps.toFixed(1) + ' MB/s（本次网络）· 支持断点续传；慢时切换其它镜像或用 aria2c -x8 -s8 多线程');
      var fastest = fastestMirror();
      Object.keys(state.measured).forEach(function (key) { state.measured[key].fastest = false; });
      if (fastest && state.measured[fastest.id]) state.measured[fastest.id].fastest = true;
      renderMirrors();
    }
  }

  /* ---- hash copy ------------------------------------------------------------------- */

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
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () { window.prompt('SHA256', value); });
      } else {
        window.prompt('SHA256', value);
      }
    });
  }

  /* ---- boot ------------------------------------------------------------------------ */

  function start() {
    wireHashButton();

    fetchJson('./data/mirrors.json', 8000).then(function (data) {
      state.mirrors = (data && data.mirrors) || [];
      // First paint with the bundled snapshot, then refresh from the live API.
      return fetchJson('./data/releases.json', 8000).catch(function () { return null; }).then(function (snap) {
        if (snap && snap.releases) {
          state.release = normalizeRelease(pickRelease(snap.releases.map(function (r) {
            return { tag_name: r.tag, name: r.name, published_at: r.published_at, prerelease: r.prerelease,
              draft: false, assets: r.assets.map(function (a) {
                return { name: a.name, size: a.size, browser_download_url: a.url, digest: a.digest };
              }) };
          })));
          state.asset = pickAsset(state.release);
          render();
        }
        return fetchLatestWithApk().then(function (live) {
          if (live && (!state.release || live.tag !== state.release.tag)) {
            state.release = live;
            state.asset = pickAsset(live);
            state.measured = {};
            render();
          }
        }).catch(function () { /* offline / rate-limited: the snapshot stays */ });
      });
    }).then(function () {
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
