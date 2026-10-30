import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines, foldContext, toolHeadline, toolView } from '../tool-view.js';

const ops = (rows) => rows.map((r) => (r.op === '…' ? `…${r.count}` : `${r.op}${r.text}`));

test('diffLines：保留公共行，只标出改动', () => {
  assert.deepEqual(ops(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')), [' a', '-b', '+B', ' c', '+d']);
  assert.deepEqual(ops(diffLines('', 'x')), ['+x']);
  assert.deepEqual(ops(diffLines('x\ny', '')), ['-x', '-y']);
  assert.deepEqual(ops(diffLines('same', 'same')), [' same']);
});

test('foldContext：远离改动的行折叠成计数', () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const neu = old.replace('l10', 'L10');
  assert.deepEqual(ops(foldContext(diffLines(old, neu))), ['…8', ' l8', ' l9', '-l10', '+L10', ' l11', ' l12', '…7']);
});

test('Edit → diff，统计增删', () => {
  const v = toolView('Edit', { file_path: '/r/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;\nconst b = 3;' });
  assert.equal(v.kind, 'diff');
  assert.equal(v.file, '/r/src/a.ts');
  assert.equal(v.added, 2);
  assert.equal(v.removed, 1);
  assert.equal(toolHeadline('Edit', { file_path: '/r/src/a.ts', old_string: 'x', new_string: 'y' }), 'src/a.ts  +1 −1');
  assert.equal(toolView('Edit', { file_path: 'f', old_string: 'a', new_string: 'b', replace_all: true }).note, '全部替换');
});

test('MultiEdit：多段之间插分隔', () => {
  const v = toolView('MultiEdit', { file_path: 'f', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
  assert.deepEqual(ops(v.rows), ['-a', '+b', '…0', '-c', '+d']);
  assert.equal(v.added, 2);
});

test('Write：全部为新增，超长截断', () => {
  const v = toolView('Write', { file_path: 'f', content: Array.from({ length: 450 }, (_, i) => `${i}`).join('\n') });
  assert.equal(v.added, 450);
  assert.equal(v.rows.length, 401);
  assert.deepEqual(v.rows.at(-1), { op: '…', count: 50 });
});

test('Bash / TodoWrite / 其它工具', () => {
  assert.deepEqual(toolView('Bash', { command: 'npm test', description: '跑测试' }), { kind: 'bash', command: 'npm test', description: '跑测试' });
  assert.equal(toolHeadline('Bash', { command: 'ls\npwd' }), '$ ls');
  assert.equal(toolHeadline('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }), '1/2 已完成');
  assert.deepEqual(
    toolView('AskUserQuestion', {
      questions: [{ header: '审批检查', question: '页面正常吗？', options: [{ label: '正常' }, { label: '需要微调' }] }],
    }),
    {
      kind: 'questions',
      questions: [{ header: '审批检查', question: '页面正常吗？', multiSelect: false, options: ['正常', '需要微调'] }],
    },
  );
  assert.equal(
    toolHeadline('AskUserQuestion', { questions: [{ header: '审批检查', question: '页面正常吗？' }] }),
    '审批检查 · 页面正常吗？',
  );
  assert.deepEqual(toolView('Grep', { pattern: 'foo', path: 'src' }), { kind: 'fields', fields: [['路径', 'src'], ['匹配', 'foo']] });
  assert.deepEqual(toolView('Unknown', { x: 1 }), { kind: 'json' });
  assert.deepEqual(toolView('Edit', null), { kind: 'json' });
  assert.equal(toolHeadline('Read', { file_path: 'a' }), null);
});
