/* selfcheck.js — 「不安全」自助诊断（v2）。
 *
 * 为什么需要它：Chrome 对 https 页面显示「不安全」时，原因几乎总是**页面里混进了走 http 的
 * 资源**。但这类资源经常不是站点自己带的 —— 浏览器扩展、安全软件、运营商注入都可能塞进来，
 * 而站长的机器上复现不到。所以做这个面板：让用户在本机浏览器里一眼看到"到底是哪个资源"。
 *
 * v2 修正一个会误导人的缺陷：把两类东西分开了 ——
 *   ① 「会触发不安全的 http 资源」：performance 里**实际加载过**的 http 请求，或 DOM 里带
 *      http 的**加载型**属性（img/script/iframe/link/audio/video/source 的 src、srcset、poster）。
 *      这些才是 Chrome 判混合内容的依据；只有这一桶有东西时才自动弹面板。
 *   ② 「页面里的 http 链接」：`<a href="http://...">`。**不会**让页面变不安全（Chrome 实测：
 *      带 10 个 http 链接的清单页安全状态仍是 secure），点击也只是离开本站；只作参考列出，
 *      不自动弹面板（否则服务器清单页会对所有访客弹窗）。
 *
 * 用法：?diag=1 强制显示；平时只在 ① 非空时自动显示。
 */
(function () {
  'use strict';

  var FORCE = /[?&]diag=1\b/.test(location.search);
  var shown = false;

  function collect() {
    var loaded = [];
    var links = [];
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        if (/^http:\/\//i.test(e.name)) loaded.push('已加载 · ' + e.name);
      });
    } catch (err) { /* ignore */ }
    try {
      var nodes = document.querySelectorAll('[src],[srcset],[poster],[data-src],[action],[href]');
      Array.prototype.forEach.call(nodes, function (el) {
        var tag = el.tagName.toLowerCase();
        ['src', 'srcset', 'poster', 'data-src', 'action'].forEach(function (attr) {
          var v = el.getAttribute && el.getAttribute(attr);
          if (v && /^http:\/\//i.test(String(v))) {
            loaded.push(tag + '[' + attr + '] · ' + String(v).slice(0, 160));
          }
        });
        var h = el.getAttribute && el.getAttribute('href');
        if (h && /^http:\/\//i.test(String(h))) {
          // a[href] 是链接不是资源；link[href] 是样式/图标等**加载型**引用 → 归入 loaded
          if (tag === 'a') links.push('链接 ' + String(h).slice(0, 160));
          else loaded.push(tag + '[href] · ' + String(h).slice(0, 160));
        }
      });
    } catch (err) { /* ignore */ }
    try {
      Array.prototype.forEach.call(document.querySelectorAll('style'), function (s) {
        var m = String(s.textContent || '').match(/http:\/\/[^\s)"'<>]+/g);
        if (m) m.forEach(function (u) { loaded.push('内联样式 · ' + u); });
      });
    } catch (err) { /* ignore */ }
    var seen = {};
    var uniq = function (list) {
      return list.filter(function (u) { if (seen[u]) return false; seen[u] = 1; return true; });
    };
    return { loaded: uniq(loaded).slice(0, 12), links: uniq(links).slice(0, 20) };
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

  function show(data) {
    if (shown || !document.body) return;
    shown = true;
    var ua = navigator.userAgent;
    var bad = data.loaded.length;
    var head = bad
      ? '发现 ' + bad + ' 个会触发「不安全」的 http 资源 —— 这些不是本站页面的内容'
      : '页内没有任何会触发「不安全」的 http 资源（实际加载的 http 请求 = 0）';
    var tail = bad
      ? '它们多半来自浏览器扩展 / 安全软件 / 网络注入。请把这份清单截图或复制发站长；装扩展的浏览器可先停用扩展再刷新对比。'
      : ('也就是说"不安全"不是本页面造成的。请用无痕窗口再开一次本页对比（无痕不吃缓存、默认不跑扩展）：'
        + '无痕下正常 → 是扩展/缓存问题；无痕下同样提示 → 把地址栏左侧那个面板截图发站长。');
    if (data.links.length) {
      tail += '（页面里另有 ' + data.links.length + ' 个 http 服务器链接，属于"打开"按钮的跳转地址：'
        + '点击才会离开本站，不会让页面变不安全，Chrome 实测带这些链接时安全状态仍是 secure。）';
    }

    var box = document.createElement('div');
    box.setAttribute('data-sp-selfcheck', '1');
    box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#1a1206;color:#f0e0bc;' +
      'font:13px/1.6 -apple-system,"Microsoft YaHei",sans-serif;padding:10px 12px;border-bottom:2px solid #d9a83c;' +
      'max-height:60vh;overflow:auto;box-shadow:0 2px 10px rgba(0,0,0,.5)';
    var t = document.createElement('div');
    t.style.cssText = 'font-weight:700;margin-bottom:4px';
    t.textContent = '安全自检 · ' + head;
    box.appendChild(t);
    var tip = document.createElement('div');
    tip.style.cssText = 'opacity:.88;margin-bottom:6px';
    tip.textContent = tail;
    box.appendChild(tip);
    if (bad) {
      var ul = document.createElement('div');
      ul.style.cssText = 'font-family:Consolas,monospace;font-size:12px;word-break:break-all;margin-bottom:6px';
      data.loaded.forEach(function (line) {
        var d = document.createElement('div');
        d.textContent = '· ' + line;
        ul.appendChild(d);
      });
      box.appendChild(ul);
    }
    var meta = document.createElement('div');
    meta.style.cssText = 'opacity:.7;font-size:11px;margin-bottom:6px;word-break:break-all';
    meta.textContent = '页面 ' + location.pathname + ' · 参考：' + data.links.length + ' 个 http 链接未列入 · UA ' + ua.slice(0, 110);
    box.appendChild(meta);
    var btnCss = 'font:inherit;font-size:12px;color:#f0e0bc;background:transparent;border:1px solid #d9a83c;' +
      'padding:2px 10px;margin-right:8px;cursor:pointer';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.style.cssText = btnCss;
    copyBtn.textContent = '复制诊断结果';
    copyBtn.addEventListener('click', function () {
      copy('安全自检 ' + location.href + '\n' + head + '\n' + (data.loaded.join('\n') || '(无会触发不安全的 http 资源)') +
        '\nhttp 链接 ' + data.links.length + ' 个\nUA ' + ua, copyBtn);
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
    var data = collect();
    // 只有"会触发不安全的资源"才自动弹；http 链接（服务器清单页有 10 个）不打扰访客
    if (FORCE || data.loaded.length) show(data);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  // 扩展/注入常常在首屏之后才插入节点：补扫几轮
  setTimeout(run, 3000);
  setTimeout(run, 8000);
  setTimeout(run, 15000);
})();
