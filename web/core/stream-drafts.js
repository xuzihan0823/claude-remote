// 流式草稿：daemon 推来的 {type:'stream'} 帧 → 末尾「正在输出」的文字。
// 正文以 JSONL 落盘后经 ws:message 来的消息为准，对上了就把对应草稿删掉。
// 纯函数，web 与 App 共用。

/** @typedef {{ key: string, text: string, done: boolean }} Draft */

/** 应用一帧，返回新数组（不改原数组）。 */
export function applyStreamFrame(drafts, frame) {
  if (frame.clear) return drafts.length ? [] : drafts;
  if (typeof frame.key !== 'string' || typeof frame.text !== 'string') return drafts;
  const offset = Number.isInteger(frame.offset) ? frame.offset : 0;
  const i = drafts.findIndex((d) => d.key === frame.key);
  if (i < 0) {
    if (offset !== 0) return drafts; // 没见过开头：等订阅时的快照
    return [...drafts, { key: frame.key, text: frame.text, done: !!frame.done }];
  }
  const cur = drafts[i];
  let text = cur.text;
  if (offset === 0) text = frame.text;
  else if (offset <= text.length) text = text.slice(0, offset) + frame.text;
  else return drafts; // 有缺口：丢帧，等快照或落盘
  const next = drafts.slice();
  next[i] = { key: cur.key, text, done: cur.done || !!frame.done };
  return next;
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** 转录里来了一条消息：assistant 文本对上某份草稿就删掉它。 */
export function reconcileDrafts(drafts, message) {
  if (!drafts.length || message?.role !== 'assistant' || message.kind !== 'text') return drafts;
  const t = norm(message.text);
  if (!t) return drafts;
  let i = drafts.findIndex((d) => norm(d.text) === t);
  if (i < 0) i = drafts.findIndex((d) => d.done && (t.startsWith(norm(d.text)) || norm(d.text).startsWith(t)));
  if (i < 0) return drafts;
  return [...drafts.slice(0, i), ...drafts.slice(i + 1)];
}
