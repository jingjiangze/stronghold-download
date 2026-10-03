/* ==========================================================================================
   admin.js — server list editor.

   Two publishing paths:
   - With a publish key (admin.html?k=<key> or typed into the key field once, kept in
     localStorage): writes straight to the R2 hot list (site/servers.json) via the R2 REST
     API through a Pages Function at /api/servers — the key never appears in page source.
   - Without a key: edits are staged in localStorage and the servers page merges them in
     ("only for me"); a "copy JSON" button hands over the diff for manual publishing.

   The same validation as the probe page applies: public http(s) URLs only, no credentials
   in URLs, no localhost / private / reserved targets.
   ========================================================================================== */
(function () {
  'use strict';

  var LIST_SOURCES = [
    'https://weishucdn.jiangjiangze.icu/site/servers.json',
    './data/servers.json'
  ];
  var LS_DRAFT = 'sp.serverList.draft.v1';
  var LS_KEY = 'sp.serverList.key.v1';
  var LIST_TIMEOUT_MS = 8000;

  var el = {
    status: document.getElementById('ad-status'),
    list: document.getElementById('ad-list'),
    form: document.getElementById('ad-form'),
    name: document.getElementById('ad-name'),
    url: document.getElementById('ad-url'),
    probe: document.getElementById('ad-probe'),
    note: document.getElementById('ad-note'),
    err: document.getElementById('ad-err'),
    save: document.getElementById('ad-save'),
    submit: document.getElementById('ad-submit'),
    revert: document.getElementById('ad-revert'),
    review: document.getElementById('ad-review'),
    pending: document.getElementById('ad-pending'),
    reload: document.getElementById('ad-reload')
  };

  var base = [];   // published list as loaded
  var draft = null; // working copy (array of entries) when dirty

  function setText(node, text) { if (node) node.textContent = text; }

  function showError(text) {
    if (!el.err) return;
    if (text) { el.err.hidden = false; setText(el.err, text); }
    else { el.err.hidden = true; setText(el.err, ''); }
  }

  /* ---- validation (mirrors functions/api/_verify.js) --------------------------------- */

  var PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
                    /^172\.(1[6-9]|2[0-9]|3[01])\./];

  function isUnsafeHostname(host) {
    var h = String(host || '').toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h.charAt(0) === '[') {
      var v6 = h.slice(1, -1);
      if (v6 === '::1' || v6 === '::') return true;
      if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
      return false;
    }
    if (h === '0.0.0.0') return true;
    return PRIVATE_V4.some(function (re) { return re.test(h); });
  }

  function validateUrl(raw) {
    var url;
    try { url = new URL(String(raw).trim()); } catch (err) { return { error: '地址无法解析' }; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: '仅允许 http/https' };
    if (url.username || url.password) return { error: '地址中不能包含账号密码' };
    if (isUnsafeHostname(url.hostname)) return { error: '拒绝内网/环回/保留地址' };
    return { url: url };
  }

  /* ---- visitor submission (no key; server verifies and auto-publishes) --------------- */

  function onSubmit(event) {
    event.preventDefault();
    showError('');
    var check = validateUrl(el.url.value);
    if (check.error) { showError(check.error); return; }
    var entry = { name: (el.name.value || '').trim() || check.url.host,
                  url: check.url.href,
                  probe: (el.probe.value || '/healthz').trim() || '/healthz' };
    if ((el.note.value || '').trim()) entry.note = el.note.value.trim();
    if (el.submit) { el.submit.disabled = true; setText(el.submit.querySelector('.btn__label'), '校验中…'); }
    fetch('/api/servers/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers: [entry] })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }).then(function (outcome) {
      if (!outcome.data.ok) throw new Error(outcome.data.error || ('HTTP ' + outcome.status));
      setText(el.status, '校验通过，已加入公共清单');
      setText(el.note, '「' + entry.name + '」已上线（服务端实测 /healthz 确认为卫戍协议服务器）。');
      el.name.value = ''; el.url.value = ''; el.note.value = '';
    }).catch(function (err) {
      showError('提交失败：' + (err && err.message ? err.message : '网络'));
    }).finally(function () {
      if (el.submit) { el.submit.disabled = false; setText(el.submit.querySelector('.btn__label'), '校验并提交'); }
    });
  }

  /* ---- boot -------------------------------------------------------------------------- */

  function boot() {
    if (el.form) el.form.addEventListener('submit', onSubmit);
    setText(el.status, '填写下方表单提交服务器');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
