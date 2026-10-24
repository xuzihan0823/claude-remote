import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Marked } from '../vendor/marked.esm.min.js';
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
