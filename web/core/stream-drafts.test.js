import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStreamFrame, reconcileDrafts } from './stream-drafts.js';

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
