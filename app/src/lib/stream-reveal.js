// 流式输出平滑步进与尾部渐变显影：
// - 把网络分块到达的流式文本拆解为按帧连续推进的字符流，消除「一块一块蹦出来」的跳变；
// - 末尾最新浮现的字符带从浅到深的透明度渐变（0.18 -> 1.0），停顿或结束时自然加深收尾；
// - 草稿被落盘的正式消息替换时，通过交接表延续尚未走完的揭示与渐变进度，避免切换跳变。

const SNAPSHOT_THRESHOLD = 36;
const MAX_FADE_WINDOW = 16;
const MIN_REVEAL_RATE = 0.055; // 字符/ms（保底约 55 字/秒）
const BACKLOG_REVEAL_FACTOR = 0.014; // 积压追赶系数（约 70ms 时间常数）
const SOLID_FOLLOW_RATE = 0.045;
const SOLID_FOLLOW_FACTOR = 0.013;
const SOLID_FINISH_RATE = 0.085;
const SOLID_FINISH_FACTOR = 0.02;

const INLINE_MARKERS = new Set([42, 95, 96, 126]); // * _ ` ~

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 对齐截断位置：不劈开 UTF-16 代理对，也不停在连续内联 Markdown 标记符或代码围栏头部中间。 */
export function alignRevealIndex(text, rawIndex) {
  const len = text.length;
  if (rawIndex <= 0) return 0;
  if (rawIndex >= len) return len;
  let idx = Math.floor(rawIndex);
  if (isHighSurrogate(text.charCodeAt(idx - 1)) && idx < len) {
    idx += 1;
  }
  if (idx < len) {
    const prev = text.charCodeAt(idx - 1);
    // 若刚踏入 ```lang\n 代码块围栏头，一步跨过整行围栏声明，避免先闪出裸反引号
    if (prev === 96) {
      let fenceStart = idx - 1;
      while (fenceStart > 0 && text.charCodeAt(fenceStart - 1) === 96) fenceStart -= 1;
      if (fenceStart === 0 || text.charCodeAt(fenceStart - 1) === 10) {
        const fenceMatch = text.slice(fenceStart).match(/^`{3}[a-zA-Z0-9_-]*\n?/);
        if (fenceMatch) {
          return Math.min(len, fenceStart + fenceMatch[0].length);
        }
      }
    }
    if (INLINE_MARKERS.has(prev) && text.charCodeAt(idx) === prev) {
      let limit = 3;
      while (idx < len && limit-- > 0 && text.charCodeAt(idx) === prev) {
        idx += 1;
      }
    }
  }
  return idx;
}

/** 判断状态是否已完全揭示且尾部渐变已收尾为 100% 实色。 */
export function isRevealSettled(state) {
  const len = state.target.length;
  return state.revealed >= len && state.solidPos >= len;
}

/** 创建初始揭示状态。 */
export function createRevealState(initialText = '', { streaming = false, reduceMotion = false, handoff = null } = {}) {
  const target = String(initialText ?? '');
  const len = target.length;
  if (reduceMotion) {
    return { target, revealed: len, revealPos: len, solidPos: len };
  }
  if (handoff && typeof handoff.revealPos === 'number') {
    if (handoff.settled && handoff.revealPos >= len) {
      return { target, revealed: len, revealPos: len, solidPos: len };
    }
    const revealPos = Math.max(0, Math.min(len, handoff.revealPos));
    const solidPos = Math.max(0, Math.min(revealPos, handoff.solidPos ?? revealPos));
    const revealed = alignRevealIndex(target, Math.floor(revealPos));
    return { target, revealed, revealPos, solidPos };
  }
  if (!streaming) {
    return { target, revealed: len, revealPos: len, solidPos: len };
  }
  // 断线重连或中途打开会话收到的长快照：直接显示已有部分，后续增量再做渐变
  if (len > SNAPSHOT_THRESHOLD) {
    return { target, revealed: len, revealPos: len, solidPos: len };
  }
  // 首帧立即露出开头 1~2 个字符进入渐变，避免挂载首帧空白
  const initialPos = Math.min(len, Math.max(1, Math.min(2, Math.ceil(len * 0.25))));
  const revealed = alignRevealIndex(target, initialPos);
  return {
    target,
    revealed,
    revealPos: revealed,
    solidPos: 0,
  };
}

/** 目标文本变化时更新状态（不丢失当前已揭示进度）。 */
export function updateRevealTarget(state, nextText, { streaming = false, reduceMotion = false } = {}) {
  const target = String(nextText ?? '');
  const len = target.length;
  if (reduceMotion || (!streaming && isRevealSettled(state) && target === state.target)) {
    return { target, revealed: len, revealPos: len, solidPos: len };
  }
  if (target === state.target) return state;

  // 若发生快照回退或改写，钳制游标不超过新长度
  const revealPos = Math.min(len, state.revealPos);
  const solidPos = Math.min(revealPos, state.solidPos);
  const revealed = alignRevealIndex(target, Math.floor(revealPos));
  return { target, revealed, revealPos, solidPos };
}

/** 按帧时间差 dtMs（毫秒）推进揭示位置与尾部实色边界。 */
export function stepRevealState(state, dtMs = 16) {
  const len = state.target.length;
  if (state.revealed >= len && state.solidPos >= len) return state;

  const dt = Math.max(4, Math.min(64, Number.isFinite(dtMs) ? dtMs : 16));
  const backlog = Math.max(0, len - state.revealPos);

  let nextRevealPos = state.revealPos;
  if (backlog > 0) {
    const step = (MIN_REVEAL_RATE + backlog * BACKLOG_REVEAL_FACTOR) * dt;
    nextRevealPos = Math.min(len, state.revealPos + step);
    if (len - nextRevealPos < 0.35) nextRevealPos = len;
  }

  const revealed = alignRevealIndex(state.target, Math.floor(nextRevealPos));
  const effectiveRevealPos = Math.max(nextRevealPos, revealed);

  // 尾部实色游标推进：限制最大渐变窗口宽度，并在揭示完成后快速收尾为实色
  const minSolid = Math.max(0, effectiveRevealPos - MAX_FADE_WINDOW);
  const fadeGap = Math.max(0, effectiveRevealPos - state.solidPos);
  const finishing = revealed >= len;
  const solidStep = finishing
    ? (SOLID_FINISH_RATE + fadeGap * SOLID_FINISH_FACTOR) * dt
    : (SOLID_FOLLOW_RATE + fadeGap * SOLID_FOLLOW_FACTOR) * dt;

  let nextSolidPos = Math.max(minSolid, Math.min(effectiveRevealPos, state.solidPos + solidStep));
  if (finishing && len - nextSolidPos < 0.4) {
    nextSolidPos = len;
  }

  if (
    revealed === state.revealed &&
    Math.abs(nextRevealPos - state.revealPos) < 1e-3 &&
    Math.abs(nextSolidPos - state.solidPos) < 1e-3
  ) {
    return state;
  }

  return {
    target: state.target,
    revealed,
    revealPos: nextRevealPos,
    solidPos: nextSolidPos,
  };
}

/** 当前需要做尾部渐变的字符数。 */
export function getFadeTailLength(state) {
  return Math.max(0, state.revealed - Math.floor(state.solidPos));
}

/**
 * 将一段位于 [segStart, segStart + str.length) 的叶子文本切分为实色与尾部渐变片段。
 * 若整段都在实色区（segEnd <= fadeStart），返回 null，调用方直接渲染原字符串以保持零开销。
 */
export function splitFadeSegments(str, segStart, fadeStart, fadeTotal) {
  if (!str) return null;
  const segEnd = segStart + str.length;
  if (fadeTotal <= fadeStart || segEnd <= fadeStart) return null;

  const out = [];
  let cursor = 0;

  // 实色前缀
  if (segStart < fadeStart) {
    let solidLen = Math.min(str.length, fadeStart - segStart);
    if (solidLen > 0 && solidLen < str.length && isHighSurrogate(str.charCodeAt(solidLen - 1))) {
      solidLen += 1;
    }
    if (solidLen > 0) {
      out.push({ text: str.slice(0, solidLen), opacity: 1 });
      cursor = solidLen;
    }
  }

  const span = Math.max(1, fadeTotal - fadeStart);
  const chunkSize = 2;

  while (cursor < str.length) {
    let end = Math.min(str.length, cursor + chunkSize);
    if (end < str.length && isHighSurrogate(str.charCodeAt(end - 1))) {
      end += 1;
    }
    const slice = str.slice(cursor, end);
    const midPos = segStart + (cursor + end) * 0.5;
    const u = Math.max(0, Math.min(1, (midPos - fadeStart) / span));
    // 从靠近正文的 ~0.88 平滑过渡到最尾端刚浮现的 0.18
    const opacity = Math.round(Math.max(0.18, Math.min(0.94, 1 - 0.82 * (u ** 1.15))) * 100) / 100;

    if (out.length > 0 && out[out.length - 1].opacity === opacity) {
      out[out.length - 1].text += slice;
    } else {
      out.push({ text: slice, opacity });
    }
    cursor = end;
  }

  return out;
}

// ---- 草稿 -> 正式消息的揭示进度交接缓存 ----
const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const handoffStore = new Map();
const MAX_HANDOFF_ENTRIES = 24;

export function recordDraftReveal(text, state) {
  const key = normText(text);
  if (!key) return;
  if (handoffStore.size >= MAX_HANDOFF_ENTRIES && !handoffStore.has(key)) {
    const oldest = handoffStore.keys().next().value;
    handoffStore.delete(oldest);
  }
  handoffStore.set(key, {
    revealPos: state.revealPos,
    solidPos: state.solidPos,
    settled: isRevealSettled(state),
    ts: Date.now(),
  });
}

export function consumeDraftReveal(text) {
  const key = normText(text);
  if (!key) return null;
  const exact = handoffStore.get(key);
  if (exact) {
    handoffStore.delete(key);
    return Date.now() - exact.ts <= 5000 ? exact : null;
  }
  // 兼容草稿末尾与落盘文本存在轻微前缀差异的情况
  for (const [k, v] of handoffStore.entries()) {
    if (Date.now() - v.ts > 5000) {
      handoffStore.delete(k);
      continue;
    }
    if (key.startsWith(k) || k.startsWith(key)) {
      handoffStore.delete(k);
      return v;
    }
  }
  return null;
}
