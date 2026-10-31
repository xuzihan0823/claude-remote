import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Marked, marked } from '../vendor/marked.esm.min.js';
import { installLinkify } from './linkify.js';
import { installMath } from './md-math.js';

const m = new Marked({ gfm: true, breaks: true });
installMath(m);
const lex = (s) => m.lexer(s);
const inlineMath = (s) => {
  const out = [];
  const walk = (ts) => { for (const t of ts || []) { if (t.type === 'math') out.push(t); walk(t.tokens); } };
  walk(lex(s));
  return out.map((t) => [t.display, t.text]);
};

test('块级 $$ 与 \\[ \\]，可跨行', () => {
  const t = lex('前文\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n后文');
  assert.ok(t.some((x) => x.type === 'math' && x.display && x.text === '\\int_0^1 x\\,dx'));
  assert.deepEqual(inlineMath('\\[a^2+b^2\\]'), [[true, 'a^2+b^2']]);
});

test('行内 $…$ 与 \\( \\)', () => {
  assert.deepEqual(inlineMath('勾股 $a^2+b^2=c^2$ 成立'), [[false, 'a^2+b^2=c^2']]);
  assert.deepEqual(inlineMath('欧拉 \\(e^{i\\pi}+1=0\\)。'), [[false, 'e^{i\\pi}+1=0']]);
});

test('金额不误判', () => {
  assert.deepEqual(inlineMath('价格 $5 和 $10 之间'), []);
  assert.deepEqual(inlineMath('花了 $5, 又花 $6'), []);
  assert.deepEqual(inlineMath('$ x $'), []);
});

test('代码里的 $ 不受影响', () => {
  assert.deepEqual(inlineMath('`echo $HOME $PATH`'), []);
  assert.deepEqual(inlineMath('```sh\necho $a$b\n```'), []);
});

test('未闭合（流式半截）保持原文', () => {
  assert.deepEqual(inlineMath('正在输出 $a^2+'), []);
  const t = lex('$$\n\\frac{1}{2');
  assert.ok(!t.some((x) => x.type === 'math'));
});

test('全局 marked 实例：带 marked.defaults 时公式与自动链接共存', () => {
  installLinkify(marked);
  installMath(marked);
  const tokens = marked.lexer('公式 $x^2+y^2=r^2$ 与链接 https://example.com/a，完。\n\n$$\n\\sum_{i=1}^n i\n$$', {
    ...marked.defaults,
    gfm: true,
    breaks: true,
  });
  const mathTokens = [];
  const linkHrefs = [];
  marked.walkTokens(tokens, (t) => {
    if (t.type === 'math') mathTokens.push([t.display, t.text]);
    if (t.type === 'link') linkHrefs.push(t.href);
  });
  assert.deepEqual(mathTokens, [[false, 'x^2+y^2=r^2'], [true, '\\sum_{i=1}^n i']]);
  assert.deepEqual(linkHrefs, ['https://example.com/a']);
});
