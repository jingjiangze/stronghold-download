/* ==========================================================================================
   admin.js — key-gated list management.

   Auth: the key is entered once (kept in sessionStorage only), then verified server-side
   by PUT /api/servers with the x-admin-key header — a wrong key returns 401 and the gate
   stays up. With a valid key the page can:
     - toggle (enable/disable) or delete any published server (PUT /api/servers);
     - add a server (POST /api/servers/submit — server-side health check + auto-publish);
     - re-admit or drop servers quarantined by /api/servers/verify (the live list still
       holds them; re-publishing unchanged data restores the entry).
   The key never appears in page source; it lives only in this tab's sessionStorage.
   ========================================================================================== */
(function () {
  'use strict';

  var LIST_SOURCES = [
    'https://weishucdn.jiangjiangze.icu/site/servers.json',
    './data/servers.json'
  ];
  var VERIFIED_URL = 'https://weishucdn.jiangjiangze.icu/site/verified.json';
  var LIST_TIMEOUT_MS = 8000;
  var KEY_STORE = 'sp.adminKey';

  var el = {
    status: document.getElementById('ad-status'),
    gate: document.getElementById('ad-gate'),
    gateLogin: document.getElementById('ad-gate-login'),
    keyForm: document.getElementById('ad-key-form'),
    keyInput: document.getElementById('ad-key-input'),
    keyErr: document.getElementById('ad-key-err'),
    keyGo: document.getElementById('ad-key-go'),
    list: document.getElementById('ad-list'),
    review: document.getElementById('ad-review'),
    pending: document.getElementById('ad-pending'),
    reload: document.getElementById('ad-reload'),
    form: document.getElementById('ad-form'),
    name: document.getElementById('ad-name'),
    url: document.getElementById('ad-url'),
    probe: document.getElementById('ad-probe'),
    note: document.getElementById('ad-note'),
    err: document.getElementById('ad-err'),
    submit: document.getElementById('ad-submit')
  };

  var base = [];
  var baseUpdated = null;   // 现网清单的版本号，写回时做乐观并发检查

  function setText(node, text) { if (node) node.textContent = text; }

  function showError(text) {
    if (!el.err) return;
    if (text) { el.err.hidden = false; setText(el.err, text); }
    else { el.err.hidden = true; setText(el.err, ''); }
  }

  function key() {
    try { return sessionStorage.getItem(KEY_STORE) || ''; } catch (err) { return ''; }
  }

  /* ---- data -------------------------------------------------------------------------- */

  function fetchJson(url, headers) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, LIST_TIMEOUT_MS);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store', headers: headers || {} })
      .then(function (res) {
        clearTimeout(timer);
        return res.json().then(function (data) { return { status: res.status, data: data }; },
          function () { return { status: res.status, data: null }; });
      }, function (err) { clearTimeout(timer); throw err; });
  }

  function loadPublished() {
    var chain = Promise.resolve(null);
    return LIST_SOURCES.reduce(function (acc, src) {
      return acc.then(function (data) {
        return data || fetchJson(src).then(function (out) { return out.data; }).catch(function () { return null; });
      });
    }, chain).then(function (data) {
      base = (data && Array.isArray(data.servers)) ? data.servers.slice() : [];
      baseUpdated = (data && data.updated) || null;
    });
  }

  // 票数文案单独成函数：与本机离线自测 (_tmp/vouch_test.mjs) 用的是同一段逻辑，
  // 免得为了看这行字要在浏览器里敲管理口令。
  function vouchTagText(v) {
    if (!v) return '';
    var ok = Number(v.ok != null ? v.ok : v.count) || 0;   // 旧形状只有 count，等同正向票
    var bad = Number(v.bad) || 0;
    if (!ok && !bad) return '';
    var at = Date.parse(v.at || '');
    return '玩家审核 ' + ok + ' 能进 / ' + bad + ' 进不去'
      + (isNaN(at) ? '' : '（' + new Date(at).toLocaleString('zh-CN', { hour12: false }) + '）');
  }

  // 玩家匿名核验的票数（verified.json 的 vouches）：暂存区每行都要显示「谁把它放回前台的」，
  // 所以顺手存在模块变量里，而不是把 loadVerified 的返回值改成对象（调用点只认数组）。
  var lastVouches = {};

  function loadVerified() {
    return fetchJson(VERIFIED_URL).then(function (out) {
      lastVouches = (out.data && out.data.vouches) || {};
      return (out.data && out.data.invalid) || [];
    }).catch(function () { return []; });
  }


  // 所有写操作都先重新读一次现网清单、再按 id 施加改动。之前是直接拿内存里那份
  // （打开页面时的快照）整份回写：只要期间有人新增/删除过服务器，就会被旧标签页静默
  // 回滚（今天发生过两次），而且按 index 定位还会错位。「该条目已不在清单中」的误报
  // 也是同一成因——它比的是内存里的旧版本。
  function mutateById(id, transform, okMsg) {
    return loadPublished().then(function () {
      if (!base.some(function (x) { return x.id === id; })) {
        showError('该条目不在线上清单里（清单已更新，界面已重新加载），请重试');
        render();
        return null;
      }
      base = base.map(function (x) { return x.id === id ? transform(x) : x; });
      return publishList().then(function () {
        if (okMsg) setText(el.status, okMsg);
        render();
        return true;
      });
    });
  }

  function removeById(id, okMsg) {
    return loadPublished().then(function () {
      if (!base.some(function (x) { return x.id === id; })) {
        showError('该条目已不在线上清单里，界面已重新加载');
        render();
        return null;
      }
      base = base.filter(function (x) { return x.id !== id; });
      return publishList().then(function () {
        if (okMsg) setText(el.status, okMsg);
        render();
        return true;
      });
    });
  }

  function publishList() {
    var payload = {
      updated: new Date().toISOString(),
      servers: base.map(function (s) {
        var clean = {
          id: s.id, name: s.name, url: s.url,
          probe: s.probe || '/healthz', enabled: s.enabled !== false
        };
        if (s.note) clean.note = s.note;
        // direct_cn 这类维护标记必须跟着走：之前重建条目会把它们抹掉，
        // 于是「海外探不到、国内可达」的服在下次保存时又被隐藏
        if (s.direct_cn === true) clean.direct_cn = true;
        ["region", "tier", "weight", "protocol", "app"].forEach(function (k) { if (s[k] != null) clean[k] = s[k]; });
        return clean;
      })
    };
    var url = '/api/servers' + (baseUpdated ? '?ifUpdated=' + encodeURIComponent(baseUpdated) : '');
    return fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key() },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    }).then(function (out) {
      if (out.status === 401) throw new Error('密钥无效');
      if (out.status === 409) { loadPublished().catch(function () {}); throw new Error((out.data && out.data.error) || '清单已被他人改动，界面已重新加载，请重试'); }
      if (!out.data.ok) throw new Error(out.data.error || ('HTTP ' + out.status));
      return out.data;
    });
  }

  /* ---- rendering --------------------------------------------------------------------- */

  function pubRow(entry, index) {
    var disabled = entry.enabled === false;
    var div = document.createElement('div');
    div.className = 'sv-row' + (disabled ? ' is-disabled' : '');

    var dot = document.createElement('span');
    dot.className = 'sv-dot';
    div.appendChild(dot);

    var main = document.createElement('div');
    main.className = 'sv-main';

    // Editable fields: name / url / note. The row enters edit mode via 编辑 and saves
    // through publishList(); url changes re-run the server-side health check on the next
    // verify round (a bad address simply quarantines again, data is never lost).
    var nameSpan = document.createElement('span');
    nameSpan.className = 'sv-name';
    nameSpan.textContent = entry.name || entry.url;
    var hostSpan = document.createElement('span');
    hostSpan.className = 'sv-host';
    hostSpan.textContent = entry.url + (entry.note ? ' · ' + entry.note : '');
    main.appendChild(nameSpan);
    main.appendChild(hostSpan);

    var editForm = null;
    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'sv-toggle';
    editBtn.textContent = '编辑';

    function leaveEditMode() {
      if (editForm && editForm.parentNode) { editForm.parentNode.removeChild(editForm); }
      editForm = null;
      editBtn.textContent = '编辑';
      nameSpan.classList.remove('is-hidden');
      hostSpan.classList.remove('is-hidden');
      div.classList.remove('is-editing');
    }

    function enterEditMode() {
      if (editForm) return;
      nameSpan.classList.add('is-hidden');
      hostSpan.classList.add('is-hidden');
      div.classList.add('is-editing');
      editForm = document.createElement('div');
      editForm.className = 'sv-edit';
      var fields = [
        { key: 'name', label: '名称', value: entry.name || '', max: 24 },
        { key: 'url', label: '地址', value: entry.url || '', max: 200 },
        { key: 'note', label: '备注', value: entry.note || '', max: 24 }
      ];
      var inputs = {};
      fields.forEach(function (f) {
        var wrap = document.createElement('label');
        wrap.className = 'sv-edit__field';
        var lbl = document.createElement('span');
        lbl.className = 'micro';
        lbl.textContent = f.label;
        var input = document.createElement('input');
        input.maxLength = f.max;
        input.value = f.value;
        input.placeholder = f.label;
        input.dataset.field = f.key;
        wrap.appendChild(lbl);
        wrap.appendChild(input);
        editForm.appendChild(wrap);
        inputs[f.key] = input;
      });
      var actions = document.createElement('div');
      actions.className = 'sv-edit__actions';
      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn--primary btn--sm';
      var saveLabel = document.createElement('span');
      saveLabel.className = 'btn__label';
      saveLabel.textContent = '保存';
      save.appendChild(saveLabel);
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn--ghost btn--sm';
      cancel.textContent = '取消';
      actions.appendChild(save);
      actions.appendChild(cancel);
      editForm.appendChild(actions);
      main.appendChild(editForm);

      save.addEventListener('click', function () {
        var nextName = inputs.name.value.trim();
        var nextUrl = inputs.url.value.trim();
        var nextNote = inputs.note.value.trim();
        var check = validateUrl(nextUrl);
        if (check.error) { showError('地址：' + check.error); return; }
        // duplicate guard (another row may already use this URL)
        var dup = base.some(function (s, i) { return i !== index && s.url === check.url.href; });
        if (dup) { showError('该地址已被其他服务器使用'); return; }
        var updated = Object.assign({}, entry, {
          name: nextName || check.url.host,
          url: check.url.href,
          note: nextNote || undefined
        });
        if (!nextNote) delete updated.note;
        save.disabled = true;
        setText(saveLabel, '保存中…');
        mutateById(entry.id, function (cur) {
          var merged = Object.assign({}, cur, { name: updated.name, url: updated.url });
          if (updated.note) merged.note = updated.note; else delete merged.note;
          merged.direct_cn = cur.direct_cn;
          return merged;
        }, '已保存（地址变更将在下轮校验中重新确认）').then(function () {
          showError('');
          leaveEditMode();
        }).catch(function (err) {
          showError(err.message);
          save.disabled = false;
          setText(saveLabel, '保存');
        });
      });
      cancel.addEventListener('click', leaveEditMode);
    }

    editBtn.addEventListener('click', function () {
      if (editForm) leaveEditMode();
      else enterEditMode();
    });

    main.appendChild(editBtn);
    div.appendChild(main);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sv-toggle';
    toggle.textContent = disabled ? '已停用' : '启用中';
    toggle.addEventListener('click', function () {
      mutateById(entry.id, function (cur) { return Object.assign({}, cur, { enabled: disabled }); })
        .catch(function (err) { showError(err.message); render(); });
    });
    div.appendChild(toggle);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'sv-del';
    del.textContent = '删除';
    del.addEventListener('click', function () {
      removeById(entry.id).catch(function (err) { showError(err.message); render(); });
    });
    div.appendChild(del);
    return div;
  }

  function quarRow(item) {
    var div = document.createElement('div');
    div.className = 'sv-row is-disabled';

    var dot = document.createElement('span');
    dot.className = 'sv-dot';
    div.appendChild(dot);

    var main = document.createElement('div');
    main.className = 'sv-main';
    var name = document.createElement('span');
    name.className = 'sv-name';
    name.textContent = item.name || item.id;
    var host = document.createElement('span');
    host.className = 'sv-host';
    host.textContent = (item.url || '') + ' · ' + (item.reason || '校验未通过');
    main.appendChild(name);
    main.appendChild(host);
    // 票数挂在行上：匿名票能把「探不到版本号」的条目放回前台，维护者必须看得见是谁放的，
    // 觉得不对就点「停用」—— 停用是终审，玩家票翻不动（verify.js 里的 disabledIds）。
    var v = lastVouches[item.id];
    var vtagText = vouchTagText(v);
    if (vtagText) {
      var tag = document.createElement('span');
      tag.className = 'sv-vouchbadge';
      tag.textContent = vtagText;
      tag.title = '由 /api/servers/vouch 收集，未做实名；7 天后自动失效';
      main.appendChild(tag);
    }
    div.appendChild(main);

    var restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'sv-toggle';
    restore.textContent = '恢复展示';
    restore.addEventListener('click', function () {
      // Quarantine hides the entry in the UI but never deletes it from the published
      // list; re-publishing unchanged data is enough, the next verify round re-checks it.
      mutateById(item.id, function (cur) { return Object.assign({}, cur, { enabled: true }); },
        '已恢复（下轮校验通过后自动回到前台）').then(function (ok) { if (ok) loadReview(); })
        .catch(function (err) { showError(err.message); });
    });
    div.appendChild(restore);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'sv-del';
    del.textContent = '删除';
    del.addEventListener('click', function () {
      removeById(item.id).then(function (ok) { if (ok) loadReview(); })
        .catch(function (err) { showError(err.message); });
    });
    div.appendChild(del);
    return div;
  }

  function render() {
    if (!el.list) return;
    el.list.textContent = '';
    base.forEach(function (entry, index) { el.list.appendChild(pubRow(entry, index)); });
    setText(el.status, '清单 ' + base.length + ' 台');
  }

  function loadReview() {
    return loadVerified().then(function (invalid) {
      if (!el.review) return;
      if (!invalid.length) { el.review.hidden = true; return; }
      el.review.hidden = false;
      el.pending.textContent = '';
      invalid.forEach(function (item) { el.pending.appendChild(quarRow(item)); });
    });
  }

  /* ---- add server -------------------------------------------------------------------- */

  var PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
                    /^172\.(1[6-9]|2[0-9]|3[01])\./];

  function validateUrl(raw) {
    var url;
    try { url = new URL(String(raw).trim()); } catch (err) { return { error: '地址无法解析' }; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: '仅允许 http/https' };
    if (url.username || url.password) return { error: '地址中不能包含账号密码' };
    var h = url.hostname.toLowerCase();
    var unsafe = !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
    if (!unsafe && h.charAt(0) === '[') {
      var v6 = h.slice(1, -1);
      unsafe = v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
    }
    if (!unsafe && h !== '0.0.0.0') {
      unsafe = PRIVATE_V4.some(function (re) { return re.test(h); });
    }
    if (unsafe) return { error: '拒绝内网/环回/保留地址' };
    return { url: url };
  }

  function onAdd(event) {
    event.preventDefault();
    showError('');
    var check = validateUrl(el.url.value);
    if (check.error) { showError(check.error); return; }
    var probe = String(el.probe.value || '/healthz').trim() || '/healthz';
    if (!probe.startsWith('/')) probe = '/' + probe;
    var entry = { name: (el.name.value || '').trim() || check.url.host, url: check.url.href, probe: probe };
    if ((el.note.value || '').trim()) entry.note = el.note.value.trim();
    if (el.submit) { el.submit.disabled = true; setText(el.submit.querySelector('.btn__label'), '校验中…'); }
    fetch('/api/servers/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers: [entry] })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }).then(function (out) {
      if (!out.data.ok) throw new Error(out.data.error || ('HTTP ' + out.status));
      setText(el.status, '「' + entry.name + '」已通过校验并加入清单');
      el.name.value = ''; el.url.value = ''; el.note.value = '';
      return loadPublished().then(render);
    }).catch(function (err) {
      showError('提交失败：' + (err && err.message ? err.message : '网络'));
    }).finally(function () {
      if (el.submit) { el.submit.disabled = false; setText(el.submit.querySelector('.btn__label'), '校验并添加'); }
    });
  }

  /* ---- key gate ---------------------------------------------------------------------- */

  function enterGate() {
    el.gate.hidden = false;
    el.gateLogin.hidden = true;
    loadPublished().then(function () { render(); loadReview(); })
      .catch(function () { setText(el.status, '清单加载失败，可稍后刷新'); });
  }

  function onKeySubmit(event) {
    event.preventDefault();
    var value = (el.keyInput.value || '').trim();
    if (!value) return;
    if (el.keyGo) { el.keyGo.disabled = true; setText(el.keyGo.querySelector('.btn__label'), '验证中…'); }
    if (el.keyErr) el.keyErr.hidden = true;
    // Server-side key check: the same key protects PUT /api/servers. An empty-body PUT
    // with a VALID key answers 400 (bad servers[]) — that status proves the key.
    fetch('/api/servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': value },
      body: JSON.stringify({ noop: true })
    }).then(function (res) {
      if (res.status === 401) throw new Error('密钥无效');
      try { sessionStorage.setItem(KEY_STORE, value); } catch (err) { /* ignore */ }
      enterGate();
    }).catch(function (err) {
      if (el.keyErr) { el.keyErr.hidden = false; setText(el.keyErr, err && err.message ? err.message : '验证失败'); }
    }).finally(function () {
      if (el.keyGo) { el.keyGo.disabled = false; setText(el.keyGo.querySelector('.btn__label'), '进入管理'); }
    });
  }

  /* ---- boot -------------------------------------------------------------------------- */

  function boot() {
    if (el.keyForm) el.keyForm.addEventListener('submit', onKeySubmit);
    if (el.form) el.form.addEventListener('submit', onAdd);
    if (el.reload) el.reload.addEventListener('click', loadReview);

    var stored = '';
    try { stored = sessionStorage.getItem(KEY_STORE) || ''; } catch (err) { /* ignore */ }
    if (stored) {
      el.keyInput.value = stored;
      onKeySubmit.call(el.keyForm, { preventDefault: function () {} });
    } else {
      // Locked: show ONLY the key gate. The management panel stays hidden until the key
      // verifies server-side (401 = wrong key, gate stays up).
      el.gate.hidden = true;
      el.gateLogin.hidden = false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
