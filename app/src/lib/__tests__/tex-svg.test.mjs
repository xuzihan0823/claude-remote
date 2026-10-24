import assert from 'node:assert/strict';
import { test } from 'node:test';

// 依赖 app/node_modules 里的 mathjax-full；没装（只跑 web 测试的环境）时跳过
let mod = null;
try { mod = await import('../tex-svg.js'); } catch { mod = null; }

test('texToSvg：块级 / 行内产出带尺寸的 SVG', { skip: !mod && 'mathjax-full 未安装' }, () => {
  const d = mod.texToSvg('\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}', true);
  assert.match(d.xml, /^<svg[\s\S]*currentColor[\s\S]*<\/svg>$/);
  assert.ok(d.widthEx > 5 && d.heightEx > 2);
  const i = mod.texToSvg('x^2', false);
  assert.ok(i.valignEx <= 0);
  assert.equal(mod.texToSvg('x^2', false), i, '命中缓存');
});

test('texToSvg：语法错误返回 error 而不是抛出', { skip: !mod && 'mathjax-full 未安装' }, () => {
  assert.ok(mod.texToSvg('\\frac{1}{', false).error);
});

test('常用环境与宏可用', { skip: !mod && 'mathjax-full 未安装' }, () => {
  for (const t of ['\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', '\\mathbb{R}^n', '\\boldsymbol{x}', '\\cancel{x}', '\\ket{\\psi}', '\\dv{f}{x}', '\\color{red}{a}', '\\text{中文}']) {
    assert.ok(!mod.texToSvg(t, true).error, t);
  }
});
