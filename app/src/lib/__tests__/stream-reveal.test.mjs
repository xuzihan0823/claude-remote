import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alignRevealIndex,
  consumeDraftReveal,
  createRevealState,
  getFadeTailLength,
  isRevealSettled,
  recordDraftReveal,
  splitFadeSegments,
  stepRevealState,
  updateRevealTarget,
} from '../stream-reveal.js';

test('流式步进：分块到达的文本按帧平滑推进，并在尾部带渐变窗口直到收尾为实色', () => {
  let state = createRevealState('这是一段突然到达的流式分块文本', { streaming: true });
  assert.ok(state.revealed > 0 && state.revealed < state.target.length, '首帧只露出开头少量字符');
  assert.ok(getFadeTailLength(state) > 0, '首帧带有尾部渐变窗口');
  assert.equal(isRevealSettled(state), false);

  // 追加第二块流式文本
  state = updateRevealTarget(state, '这是一段突然到达的流式分块文本，后面又追加了一块内容', { streaming: true });
  let prevRevealed = state.revealed;
  let steps = 0;
  let sawGradientWhileRevealing = false;
  let sawFinishingFade = false;

  while (!isRevealSettled(state) && steps < 120) {
    state = stepRevealState(state, 16);
    assert.ok(state.revealed >= prevRevealed, '已揭示长度单调递增');
    if (state.revealed < state.target.length && getFadeTailLength(state) > 0) {
      sawGradientWhileRevealing = true;
    }
    if (state.revealed === state.target.length && !isRevealSettled(state)) {
      sawFinishingFade = true;
    }
    prevRevealed = state.revealed;
    steps += 1;
  }

  assert.equal(isRevealSettled(state), true, '应在有限帧内完成全部揭示与渐变收尾');
  assert.equal(state.revealed, state.target.length);
  assert.equal(getFadeTailLength(state), 0);
  assert.equal(sawGradientWhileRevealing, true);
  assert.equal(sawFinishingFade, true);
});

test('边界对齐：不截断 UTF-16 代理对（Emoji），也不停在连续 Markdown 符号中间', () => {
  const emojiText = '你好👋世界'; // '👋' 在索引 2..3
  assert.equal(alignRevealIndex(emojiText, 3), 4, '落在高低代理对中间时自动前进到完整码点');

  const boldText = '前文**加粗**后文'; // '**' 在索引 2..3
  assert.equal(alignRevealIndex(boldText, 3), 4, '不停在半个 ** 中间');

  const fenceText = '```js\nconst a = 1;\n```';
  assert.equal(alignRevealIndex(fenceText, 1), 6, '代码围栏头部 ```js\\n 一步跨过，避免裸反引号闪烁');
  assert.equal(alignRevealIndex('行内 ``code`` 示例', 4), 5, '行内连续反引号一步跨过');
});

test('长快照与减弱动态效果：断线重连快照或开启 reduceMotion 时直接显示完整实色文本', () => {
  const longSnapshot = '这是一段超过三十六个字符的断线重连完整草稿快照，中途进入会话时不应从头重播打字动画。';
  const snapState = createRevealState(longSnapshot, { streaming: true });
  assert.equal(isRevealSettled(snapState), true);
  assert.equal(snapState.revealed, longSnapshot.length);

  // 快照之后继续收到新增量时，新增量正常进入平滑步进与尾部渐变
  const nextState = updateRevealTarget(snapState, `${longSnapshot}新增的流式尾巴`, { streaming: true });
  assert.equal(nextState.revealed, longSnapshot.length);
  assert.equal(isRevealSettled(nextState), false);
  const stepped = stepRevealState(nextState, 16);
  assert.ok(stepped.revealed > longSnapshot.length);
  assert.ok(getFadeTailLength(stepped) > 0);

  // 开启减弱动态效果
  const reduced = createRevealState('短文本', { streaming: true, reduceMotion: true });
  assert.equal(isRevealSettled(reduced), true);
  assert.equal(getFadeTailLength(reduced), 0);
});

test('尾部渐变切分：实色区返回 null 保持零开销，渐变区生成单调递减的透明度切片且不拆碎 Emoji', () => {
  assert.equal(splitFadeSegments('完全实色段落', 0, 10, 20), null);

  const segs = splitFadeSegments('前半实色后半渐变😊结尾', 6, 10, 18);
  assert.ok(Array.isArray(segs));
  assert.equal(segs.map((s) => s.text).join(''), '前半实色后半渐变😊结尾');
  assert.equal(segs[0].text, '前半实色');
  assert.equal(segs[0].opacity, 1);

  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].opacity < 1 && segs[i].opacity >= 0.18);
    assert.ok(segs[i].opacity <= segs[i - 1].opacity, '越靠尾端透明度越低');
  }
});

test('草稿转正交接：草稿未走完渐变即被正式消息替换时，正式消息无缝接力剩余进度', () => {
  const text = '正在流式输出的回复内容，即将落盘转正';
  let draftState = createRevealState(text, { streaming: true });
  draftState = stepRevealState(draftState, 16);
  draftState = stepRevealState(draftState, 16);
  assert.equal(isRevealSettled(draftState), false);

  recordDraftReveal(text, draftState);
  const handoff = consumeDraftReveal(text);
  assert.ok(handoff);
  assert.equal(handoff.settled, false);

  const liveMsgState = createRevealState(text, { streaming: false, handoff });
  assert.equal(liveMsgState.revealed, draftState.revealed, '正式消息从草稿已揭示位置无缝接力');
  assert.equal(isRevealSettled(liveMsgState), false);

  // 若草稿已完全收敛，则正式消息直接静态完成
  let finishedDraft = draftState;
  for (let i = 0; i < 60 && !isRevealSettled(finishedDraft); i++) {
    finishedDraft = stepRevealState(finishedDraft, 20);
  }
  assert.equal(isRevealSettled(finishedDraft), true);
  recordDraftReveal(text, finishedDraft);
  const settledHandoff = consumeDraftReveal(text);
  const settledMsgState = createRevealState(text, { streaming: false, handoff: settledHandoff });
  assert.equal(isRevealSettled(settledMsgState), true);
});
