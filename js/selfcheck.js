/* selfcheck.js — 「不安全」自助诊断。
 *
 * 为什么需要它：Chrome 对 https 页面显示「不安全」时，原因几乎总是**页面里混进了走 http 的
 * 资源**。但这类资源经常不是站点自己带的 —— 浏览器扩展、安全软件、运营商注入都可能塞进来，
 * 而站长的机器上复现不到。10-08 有用户报 dl.jiangjiangze.icu 一直显示不安全，站点侧实测
 * （Chromium 走代理与直连）0 个 http 请求、0 条混合内容告警，所以做这个面板：让用户在本机
 * 浏览器里一眼看到"到底是哪个资源"，不用开 DevTools。
 *
 * 用法：?diag=1 强制显示诊断盒；平时只在真的扫到 http 资源时才自动显示。
 * 扫描三个来源：performance 资源条目、DOM 属性、内联 <style> 里的 url()。
 */
(function () {
  'use strict';

  var FORCE = /[?&]diag=1\b/.test(location.search);
  var shown = false;

  function collect() {
    var out = [];
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        if (/^http:\/\//i.test(e.name)) out.push('请求 · ' + e.name);
      });
    } catch (err) { /* ignore */ }
    try {
      var nodes = document.querySelectorAll('[src],[href],[action],[srcset],[poster],[data-src]');
      Array.prototype.forEach.call(nodes, function (el) {
        ['src', 'href', 'action', 'srcset', 'poster', 'data-src'].forEach(function (attr) {
          var v = el.getAttribute && el.getAttribute(attr);
          if (v && /^http:\/\//i.test(String(v))) {
            out.push(el.tagName.toLowerCase() + '[' + attr + '] · ' + String(v).slice(0, 160));
          }
        });
      });
    } catch (err) { /* ignore */ }
    try {
      Array.prototype.forEach.call(document.querySelectorAll('style'), function (s) {
        var m = String(s.textContent || '').match(/http:\/\/[^\s)"'<>]+/g);
        if (m) m.forEach(function (u) { out.push('内联样式 · ' + u); });
      });
    } catch (err) { /* ignore */ }
    var seen = {};
    return out.filter(function (u) { if (seen[u]) return false; seen[u] = 1; return true; }).slice(0, 12);
  }

  function copy(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { window.prompt('复制下面的内容：', text); });
    } else {
      window.prompt('复制下面的内容：', text);
    }
  }

  function show(list) {
    if (shown || !document.body) return;
    shown = true;
    var ua = navigator.userAgent;
    var head = list.length
      ? '发现 ' + list.length + ' 个走 http 的资源 —— 这些不是本站页面的内容'
      : '本站页面未发现任何 http 资源（扫描结果 0 个）';
    var tail = list.length
      ? '它们多半来自浏览器扩展 / 安全软件 / 网络注入。请把这份清单截图或复制发站长；装扩展的浏览器可先停用扩展再刷新对比。'
      : '也就是说"不安全"不是本页面的资源造成的：请把浏览器地址栏左侧那个面板（点开显示"证书有效 / 连接不安全"的那个）截图发站长。';
    var box = document.createElement('div');
    box.setAttribute('data-sp-selfcheck', '1');
    box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#1a1206;color:#f0e0bc;' +
      'font:13px/1.6 -apple-system,"Microsoft YaHei",sans-serif;padding:10px 12px;border-bottom:2px solid #d9a83c;' +
      'max-height:60vh;overflow:auto;box-shadow:0 2px 10px rgba(0,0,0,.5)';
    var t = document.createElement('div');
    t.style.cssText = 'font-weight:700;margin-bottom:4px';
    t.textContent = '安全自检（?diag=1）· ' + head;
    box.appendChild(t);
    var tip = document.createElement('div');
    tip.style.cssText = 'opacity:.85;margin-bottom:6px';
    tip.textContent = tail;
    box.appendChild(tip);
    if (list.length) {
      var ul = document.createElement('div');
      ul.style.cssText = 'font-family:Consolas,monospace;font-size:12px;word-break:break-all;margin-bottom:6px';
      list.forEach(function (line) {
        var d = document.createElement('div');
        d.textContent = '· ' + line;
        ul.appendChild(d);
      });
      box.appendChild(ul);
    }
    var meta = document.createElement('div');
    meta.style.cssText = 'opacity:.7;font-size:11px;margin-bottom:6px;word-break:break-all';
    meta.textContent = '页面 ' + location.pathname + ' · UA ' + ua.slice(0, 120);
    box.appendChild(meta);
    var btnCss = 'font:inherit;font-size:12px;color:#f0e0bc;background:transparent;border:1px solid #d9a83c;' +
      'padding:2px 10px;margin-right:8px;cursor:pointer';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.style.cssText = btnCss;
    copyBtn.textContent = '复制诊断结果';
    copyBtn.addEventListener('click', function () {
      copy('安全自检 ' + location.href + '\n' + head + '\n' + (list.join('\n') || '(无 http 资源)') + '\nUA ' + ua, copyBtn);
    });
    box.appendChild(copyBtn);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.style.cssText = btnCss;
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', function () { box.remove(); shown = false; });
    box.appendChild(closeBtn);
    document.body.appendChild(box);
  }

  function run() {
    var list = collect();
    if (FORCE || list.length) show(list);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  // 扩展/注入常常在首屏之后才插入节点：补扫几轮
  setTimeout(run, 3000);
  setTimeout(run, 8000);
  setTimeout(run, 15000);
})();
