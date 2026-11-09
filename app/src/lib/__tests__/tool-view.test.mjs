import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffLines,
  foldContext,
  matchesMessageKey,
  mergeToolMessages,
  takeToolBatch,
  toolErrorHeadline,
  toolHeadline,
  toolView,
} from '../tool-view.js';

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

test('toolErrorHeadline：提取首行非空报错并限制长度', () => {
  assert.equal(toolErrorHeadline('\n  Exit code 1\nstack line 2'), 'Exit code 1');
  assert.equal(toolErrorHeadline(''), '');
  assert.equal(toolErrorHeadline('x'.repeat(60)), `${'x'.repeat(48)}…`);
});

test('mergeToolMessages：按 toolUseId 将 tool_use 与 tool_result 合成单张卡片，保留孤立 tool_result 与拒绝信息', () => {
  const orphan = { seq: 1, blockIndex: 0, role: 'user', kind: 'tool_result', toolUseId: 'orphan', text: '旧页结果' };
  const use1 = { seq: 2, blockIndex: 0, role: 'assistant', kind: 'tool_use', toolUseId: 't1', toolName: 'Read', toolInput: { file_path: 'a.js' } };
  const use2 = { seq: 2, blockIndex: 1, role: 'assistant', kind: 'tool_use', toolUseId: 't2', toolName: 'Bash', toolInput: { command: 'ls' } };
  const res1 = { seq: 3, blockIndex: 0, role: 'user', kind: 'tool_result', toolUseId: 't1', text: 'content a' };
  const res2 = {
    seq: 3,
    blockIndex: 1,
    role: 'user',
    kind: 'tool_result',
    toolUseId: 't2',
    text: 'denied',
    isError: true,
    permissionDenial: { toolUseId: 't2', toolName: 'Bash', message: 'Denied' },
  };
  const answer = { seq: 4, blockIndex: 0, role: 'assistant', kind: 'text', text: '完成' };

  const merged = mergeToolMessages([orphan, use1, use2, res1, res2, answer]);
  assert.equal(merged.length, 4);
  assert.equal(merged[0], orphan);
  assert.equal(merged[1].toolName, 'Read');
  assert.equal(merged[1].toolResult, res1);
  assert.equal(merged[2].toolName, 'Bash');
  assert.equal(merged[2].toolResult, res2);
  assert.equal(merged[2].permissionDenial?.message, 'Denied');
  assert.equal(merged[3], answer);

  assert.equal(matchesMessageKey(merged[1], '2:0'), true);
  assert.equal(matchesMessageKey(merged[1], '3:0'), true);
  assert.equal(matchesMessageKey(merged[1], '3:1'), false);
});

test('takeToolBatch：连续工具调用每次最多取出 3 个（含配对结果），普通文本立即排空', () => {
  const tools = [];
  for (let i = 1; i <= 5; i += 1) {
    tools.push({ seq: i * 2, blockIndex: 0, role: 'assistant', kind: 'tool_use', toolUseId: `t${i}`, toolName: 'Read' });
    tools.push({ seq: i * 2 + 1, blockIndex: 0, role: 'user', kind: 'tool_result', toolUseId: `t${i}`, text: `r${i}` });
  }
  const step1 = takeToolBatch(tools);
  assert.equal(step1.immediate, false);
  assert.deepEqual(
    step1.batch.map((m) => `${m.kind}:${m.toolUseId}`),
    ['tool_use:t1', 'tool_result:t1', 'tool_use:t2', 'tool_result:t2', 'tool_use:t3', 'tool_result:t3'],
  );
  const step2 = takeToolBatch(step1.rest);
  assert.equal(step2.immediate, false);
  assert.deepEqual(
    step2.batch.map((m) => `${m.kind}:${m.toolUseId}`),
    ['tool_use:t4', 'tool_result:t4', 'tool_use:t5', 'tool_result:t5'],
  );
  assert.deepEqual(step2.rest, []);

  // 含最终文本时立即排空前缀工具调用与该文本
  const withAnswer = [...tools.slice(0, 4), { seq: 99, blockIndex: 0, role: 'assistant', kind: 'text', text: '总结' }];
  const immediateStep = takeToolBatch(withAnswer);
  assert.equal(immediateStep.immediate, true);
  assert.equal(immediateStep.batch.length, 5);
  assert.deepEqual(immediateStep.rest, []);
});
