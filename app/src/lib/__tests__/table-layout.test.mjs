import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitColumnWidths, naturalColumnWidths } from '../table-layout.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('naturalColumnWidths：取每列最宽单元格，中文比英文宽', () => {
  const tok = {
    header: [{ text: '类别' }, { text: 'abcd' }],
    rows: [[{ text: '配置与依赖' }, { text: 'ab' }]],
  };
  assert.deepEqual(naturalColumnWidths(tok, 10, 0), [52, 26]);
});

test('fitColumnWidths：放得下时保持原宽', () => {
  assert.deepEqual(fitColumnWidths([100, 150], 300, 96), [100, 150]);
});

test('fitColumnWidths：超宽时只收窄长列并刚好占满', () => {
  const widths = fitColumnWidths([140, 500], 360, 96);
  assert.deepEqual(widths, [140, 220]);
  assert.equal(sum(widths), 360);
});

test('fitColumnWidths：多个长列平分剩余空间', () => {
  assert.deepEqual(fitColumnWidths([60, 400, 300], 360, 96), [60, 150, 150]);
});

test('fitColumnWidths：列太多时不低于最小宽度，改为横向滚动', () => {
  const widths = fitColumnWidths([200, 200, 200, 200, 200], 360, 96);
  assert.deepEqual(widths, [96, 96, 96, 96, 96]);
  assert.ok(sum(widths) > 360);
});
