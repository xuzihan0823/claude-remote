import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { exToPx, texToSvg } from '../tex-svg.js';

const req = createRequire(new URL('../../../package.json', import.meta.url));
const originalRequire = globalThis.require;
globalThis.require = req;
after(() => { if (originalRequire === undefined) delete globalThis.require; else globalThis.require = originalRequire; });
const mathjaxEntry = req.resolve('mathjax-full/js/mathjax.js');

test('按需加载：import tex-svg 时不加载 mathjax-full，首次调用 texToSvg 才 require', () => {
  assert.equal(Boolean(req.cache[mathjaxEntry]), false);
  const d = texToSvg('\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}', true);
  assert.equal(Boolean(req.cache[mathjaxEntry]), true);
  assert.ok(!d.error, d.error);
  assert.match(d.xml, /^<svg[\s\S]*currentColor[\s\S]*<\/svg>$/);
  assert.ok(d.widthEx > 5 && d.heightEx > 2);
});

test('texToSvg：行内基线对齐、缓存命中与 exToPx 换算', () => {
  const i = texToSvg('x^2 + y_1', false);
  assert.ok(!i.error, i.error);
  assert.ok(i.valignEx <= 0);
  assert.equal(texToSvg('x^2 + y_1', false), i, '相同 (tex, display) 命中缓存');
  assert.notEqual(texToSvg('x^2 + y_1', true), i, 'display 不同不混用缓存');
  assert.equal(exToPx(10, 17), 10 * 17 * 0.442);
});

test('texToSvg：语法错误返回 error 而不是抛出', () => {
  const res = texToSvg('\\frac{1}{', false);
  assert.ok(res.error);
});

test('常用环境与宏可用', () => {
  for (const t of [
    '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}',
    '\\mathbb{R}^n',
    '\\boldsymbol{x}',
    '\\cancel{x}',
    '\\ket{\\psi}',
    '\\dv{f}{x}',
    '\\color{red}{a}',
    '\\text{中文}',
  ]) {
    const r = texToSvg(t, true);
    assert.ok(!r.error, `${t}: ${r.error}`);
    assert.match(r.xml, /^<svg[\s\S]*<\/svg>$/);
  }
});
