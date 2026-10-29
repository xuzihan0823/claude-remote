import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStreamFrame, reconcileCurrentTurnDrafts, reconcileDrafts, removeDraftKeys } from './stream-drafts.js';

test('追加、重叠、缺口、快照替换、clear', () => {
  let d = [];
  d = applyStreamFrame(d, { key: 'm:0', offset: 0, text: '你好' });
  d = applyStreamFrame(d, { key: 'm:0', offset: 2, text: '世界' });
  assert.equal(d[0].text, '你好世界');
  d = applyStreamFrame(d, { key: 'm:0', offset: 2, text: '世界！' }); // 重发
  assert.equal(d[0].text, '你好世界！');
  const same = applyStreamFrame(d, { key: 'm:0', offset: 99, text: 'x' });
  assert.equal(same, d);
  assert.equal(applyStreamFrame(d, { key: 'm:1', offset: 3, text: 'x' }), d);
  d = applyStreamFrame(d, { key: 'm:0', offset: 0, text: '快照', done: true });
  assert.deepEqual(d, [{ key: 'm:0', text: '快照', done: true }]);
  assert.deepEqual(applyStreamFrame(d, { clear: true }), []);
});

test('转录消息对上草稿就删', () => {
  const d = [{ key: 'a', text: 'Hello  world', done: true }, { key: 'b', text: '继续', done: false }];
  assert.deepEqual(reconcileDrafts(d, { role: 'assistant', kind: 'text', text: 'Hello world\n' }).map((x) => x.key), ['b']);
  assert.equal(reconcileDrafts(d, { role: 'user', kind: 'text', text: '继续' }), d);
  assert.equal(reconcileDrafts(d, { role: 'assistant', kind: 'text', text: '无关' }), d);
});

test('HTTP 正文与流快照双向对账，重复补拉稳定', () => {
  const messages = [
    { seq: 1, role: 'user', kind: 'text', text: '问题' },
    { seq: 2, role: 'assistant', kind: 'text', text: '正式回答' },
  ];
  const streaming = applyStreamFrame([], { key: 'm:0', offset: 0, text: '正式回答', done: true });
  assert.deepEqual(reconcileCurrentTurnDrafts(streaming, messages), []);

  const settled = applyStreamFrame([], { key: 'm:0', offset: 0, text: '正式回答', done: true });
  assert.deepEqual(reconcileCurrentTurnDrafts(settled, messages), []);
  const pending = [{ key: 'm:1', text: '尚未落盘', done: false }];
  assert.equal(reconcileCurrentTurnDrafts(pending, messages), pending);
  assert.equal(reconcileCurrentTurnDrafts(pending, messages), pending);
});

test('历史相同短句和上一轮正文不会误删新草稿', () => {
  const drafts = [{ key: 'new:0', text: '好的', done: false }];
  const history = [
    { seq: 1, role: 'user', kind: 'text', text: '旧问题' },
    { seq: 2, role: 'assistant', kind: 'text', text: '好的' },
    { seq: 3, role: 'user', kind: 'text', text: '新问题' },
  ];
  assert.equal(reconcileCurrentTurnDrafts(drafts, history), drafts);
  assert.equal(reconcileCurrentTurnDrafts(drafts, history.slice(0, 2), 3), drafts);
});

test('同轮多个 text block 与工具消息保持各自对账', () => {
  const drafts = [
    { key: 'm:0', text: '第一段', done: true },
    { key: 'm:1', text: '第二段', done: true },
    { key: 'm:2', text: '仍在输出', done: false },
  ];
  const messages = [
    { seq: 1, role: 'user', kind: 'text', text: '开始' },
    { seq: 2, blockIndex: 0, role: 'assistant', kind: 'text', text: '第一段' },
    { seq: 2, blockIndex: 1, role: 'assistant', kind: 'tool_use', text: '第一段' },
    { seq: 3, blockIndex: 0, role: 'assistant', kind: 'text', text: '第二段' },
  ];
  assert.deepEqual(reconcileCurrentTurnDrafts(drafts, messages).map((d) => d.key), ['m:2']);
});

test('A 轮清理 key 不会删掉 B 轮草稿', () => {
  const drafts = [
    { key: 'a:0', text: 'A 的残留', done: true },
    { key: 'b:0', text: 'B 正在输出', done: false },
  ];
  assert.deepEqual(removeDraftKeys(drafts, new Set(['a:0'])).map((d) => d.key), ['b:0']);
  assert.equal(removeDraftKeys(drafts, new Set(['missing'])), drafts);
});

test('稳定消息/block 身份优先，同文与工具结果不误匹配', () => {
  const drafts = [
    { key: 'old:0', text: '好的', done: true },
    { key: 'new:0', text: '好的', done: true },
    { key: 'new:1', text: '好的', done: true },
  ];
  const messages = [
    { seq: 1, role: 'user', kind: 'text', text: '问题' },
    { seq: 2, role: 'assistant', kind: 'text', apiMessageId: 'new', blockIndex: 1, text: '好的' },
    { seq: 3, role: 'user', kind: 'tool_result', text: '工具返回' },
  ];
  assert.deepEqual(reconcileCurrentTurnDrafts(drafts, messages).map((d) => d.key), ['old:0', 'new:0']);
  assert.deepEqual(reconcileCurrentTurnDrafts(drafts, messages, 99).map((d) => d.key), ['old:0', 'new:0']);
});

test('真实落盘格式：一行一个 block，blockIndex 与流式下标不同仍能对上', () => {
  // SDK 流：thinking(0) text(1) tool_use(2) text(3)；JSONL 每行只有一个 block，blockIndex 都是 0
  const drafts = [
    { key: 'old:0', text: '第二段', done: true },
    { key: 'msg:1', text: '第一段', done: true },
    { key: 'msg:3', text: '第二段', done: true },
  ];
  const line = (seq, kind, text) => ({ seq, blockIndex: 0, apiMessageId: 'msg', role: 'assistant', kind, text });
  const firstOnly = [{ seq: 1, role: 'user', kind: 'text', text: '问题' }, line(2, 'thinking', '想'), line(3, 'text', '第一段')];
  assert.deepEqual(reconcileCurrentTurnDrafts(drafts, firstOnly).map((d) => d.key), ['old:0', 'msg:3']);
  const both = [...firstOnly, line(4, 'tool_use', ''), line(5, 'text', '第二段')];
  assert.deepEqual(reconcileCurrentTurnDrafts(drafts, both).map((d) => d.key), ['old:0']);
});
