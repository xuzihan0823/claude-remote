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
  // Claude Code 落盘时一行只放一个 block，blockIndex 多为 0，与流式下标对不上；
  // 消息 ID 只用来限定范围（避免误删其他轮次的同文草稿），块仍按文本认
  const id = message.apiMessageId;
  const inScope = id ? (d) => d.key.startsWith(`${id}:`) : () => true;
  const exactKey = id && Number.isInteger(message.blockIndex) ? `${id}:${message.blockIndex}` : null;
  let i = drafts.findIndex((d) => d.key === exactKey && norm(d.text) === t);
  if (i < 0) i = drafts.findIndex((d) => inScope(d) && norm(d.text) === t);
  if (i < 0) i = drafts.findIndex((d) => inScope(d) && d.done && (t.startsWith(norm(d.text)) || norm(d.text).startsWith(t)));
  if (i < 0) return drafts;
  return [...drafts.slice(0, i), ...drafts.slice(i + 1)];
}

/** 只清理指定 run 已存在的草稿 key，后续 run 的新草稿不受影响。 */
export function removeDraftKeys(drafts, keys) {
  const next = drafts.filter((d) => !keys.has(d.key));
  return next.length === drafts.length ? drafts : next;
}

/** 只用当前一轮的正式消息对账，避免历史里的相同短句误删新草稿。 */
export function reconcileCurrentTurnDrafts(drafts, messages, minSeq = 0) {
  let turnStart = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user' && messages[i]?.kind === 'text') turnStart = i + 1;
  }
  let next = drafts;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const identified = message?.apiMessageId && Number.isInteger(message.blockIndex);
    if (identified || (i >= turnStart && (message?.seq ?? 0) >= minSeq)) {
      next = reconcileDrafts(next, message);
    }
    if (!next.length) break;
  }
  return next;
}
