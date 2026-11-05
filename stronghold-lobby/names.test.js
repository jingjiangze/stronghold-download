// names.test.js — 房间牌用户文本的审核策略（src/names.js + src/names-words.js）。
//
// 这份策略是**唯一真源**：房间牌（src/board.js）在 add/update 两条路上都用它，页面只负责把
// 错误码翻成中文（page.test.mjs 断言页面文案与这里的 BLOCKED_TEXT_HINT 一致）。
//
// 这里钉住三件事：
//   * 判定矩阵：审计点名的绕过手法（同形字/全角/分隔符/leet/组合记号）都要拦住，正常名字不许误伤；
//   * 多线程/多 isolate 就绪：纯函数 + 无状态（换调用顺序、重复调用结果一致）+ 词表是冻结数据；
//   * 词表是数据、引擎不含词（引擎里不该出现任何被屏蔽的词）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasBlockedText, textVariants, BLOCKED_TEXT_HINT } from './src/names.js';
import { BLOCKED_EN, BLOCKED_ZH } from './src/names-words.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test('names: 命中词表（含审计点名的绕过手法）', () => {
  const blocked = [
    'fuck', 'asshole', 'ass', ' fucking server ',
    'аsshole',        // 西里尔 а（同形字）
    'ＦｕＣｋ',        // 全角（NFKC）
    'f.u.c.k',        // 分隔符夹字母
    'cl ass',         // 空格隔开
    'f4ck',           // leet + 去数字
    'fu1ck',          // 词表变体
    'fͯuck',           // 组合记号（\p{M}）
    '傻逼', '笨蛋', '某人的死全家',
  ];
  for (const raw of blocked) assert.equal(hasBlockedText(raw), true, `${JSON.stringify(raw)} 应被拦下`);
});

test('names: 不误伤（词边界生效）', () => {
  const allowed = [
    'grass', 'class', 'bass', 'pass', 'assassin', 'badassery', 'Kelsey', 'Doctor',
    '站长服务', '小鹿宝', '共学服', '阿里云服', '国内-2', '香港', 'raiya服', 'Lunar', '梨子湖',
    '缺两人，速来', '满员了，勿进', '房主：阿米娅', '', '   ',
  ];
  for (const raw of allowed) assert.equal(hasBlockedText(raw), false, `${JSON.stringify(raw)} 不该被拦下`);
  assert.equal(hasBlockedText(null), false);
  assert.equal(hasBlockedText(42), false);
});

test('names: 纯函数 + 无状态（多线程/多 isolate 就绪）', () => {
  // 逐项断言（而不是比较「排序后的布尔值」—— 那样两个输入互换结果也能骗过测试）
  const expect = { fuck: true, '站长服务': false, 'аsshole': true, '小鹿宝': false, f4ck: true, '缺两人，速来': false };
  const inputs = Object.keys(expect);
  for (const s of inputs) assert.equal(hasBlockedText(s), expect[s], `顺序 A：${s}`);
  for (const s of inputs.slice().reverse()) assert.equal(hasBlockedText(s), expect[s], `顺序 B：${s}`);
  assert.equal(hasBlockedText('fuck'), true, '重复调用结果一致');
  assert.equal(hasBlockedText('fuck'), true);
  // 变体函数也是纯的（同输入同输出）
  assert.deepEqual(textVariants('f.u.c.k'), textVariants('f.u.c.k'));
  // 词表是冻结数据
  assert.ok(Object.isFrozen(BLOCKED_EN) && Object.isFrozen(BLOCKED_ZH));
  assert.ok(BLOCKED_EN.length > 100 && BLOCKED_ZH.length > 10);
  assert.ok(BLOCKED_EN.every((w) => typeof w === 'string' && w.trim() === w));
});

test('names: 引擎不含词（词表是数据）', () => {
  const engine = readFileSync(path.join(ROOT, 'src/names.js'), 'utf8');
  // 注释里会举例子（f.u.c.k / аsshole …），所以只看**代码行**
  const code = engine.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10));
  for (const w of ['asshole', '傻逼', 'fuck']) {
    assert.ok(!code.includes(w), `引擎代码里不该出现词表条目 ${w}`);
  }
  assert.match(engine, /from '\.\/names-words\.js'/, '引擎只从词表模块取数据');
  assert.ok(BLOCKED_TEXT_HINT.length > 0);
});
