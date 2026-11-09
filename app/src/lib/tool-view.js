// 工具调用的可读化：把 Claude Code 工具的 input 转成适合手机展示的结构（纯函数，便于测试）。
//
//   Edit / MultiEdit / Write / NotebookEdit → { kind: 'diff', file, rows, added, removed }
//   Bash                                    → { kind: 'bash', command, description }
//   TodoWrite                               → { kind: 'todos', todos }
//   其它（Read / Grep / Glob / WebFetch …）  → { kind: 'fields', fields: [[标签, 值]] }
// 任何意外结构都退回 { kind: 'json' }，由界面直接显示原始 JSON。

import { cwdTail, msgKey } from './format.js';
import { t } from './i18n.js';

const MAX_DIFF_CELLS = 400_000; // 行级 LCS 的 n*m 上限，超过就整段「删旧加新」
const CONTEXT = 2; // 改动前后保留的未改动行数
const MAX_WRITE_LINES = 400; // Write 新文件最多展示的行数

const splitLines = (s) => {
  const text = String(s ?? '');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // 末尾换行不算一行
  return lines;
};

/** 行级 diff：返回 [{ op: ' ' | '-' | '+', text }]。 */
export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // 去掉公共前后缀，缩小 LCS 规模
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const head = a.slice(0, start).map((text) => ({ op: ' ', text }));
  const tail = a.slice(endA).map((text) => ({ op: ' ', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let mid;
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    mid = [...midA.map((text) => ({ op: '-', text })), ...midB.map((text) => ({ op: '+', text }))];
  } else {
    const n = midA.length;
    const m = midB.length;
    // dp[i][j] = midA[i..] 与 midB[j..] 的 LCS 长度
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { mid.push({ op: ' ', text: midA[i] }); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { mid.push({ op: '-', text: midA[i] }); i += 1; }
      else { mid.push({ op: '+', text: midB[j] }); j += 1; }
    }
    while (i < n) { mid.push({ op: '-', text: midA[i] }); i += 1; }
    while (j < m) { mid.push({ op: '+', text: midB[j] }); j += 1; }
  }
  return [...head, ...mid, ...tail];
}

/** 折叠远离改动的未改动行：保留前后 CONTEXT 行，其余变成 { op: '…', count }。 */
export function foldContext(rows, context = CONTEXT) {
  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k += 1) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skipped > 0) { out.push({ op: '…', count: skipped }); skipped = 0; }
      out.push(r);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ op: '…', count: skipped });
  return out;
}

function countOps(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.op === '+') added += 1;
    else if (r.op === '-') removed += 1;
  }
  return { added, removed };
}

function diffView(file, pairs) {
  const rows = [];
  pairs.forEach(([oldText, newText], idx) => {
    if (idx > 0) rows.push({ op: '…', count: 0 }); // MultiEdit 各段之间的分隔
    rows.push(...foldContext(diffLines(oldText, newText)));
  });
  return { kind: 'diff', file: String(file ?? ''), rows, ...countOps(rows) };
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/** 把一次工具调用转成展示结构。name 为工具名，input 为参数对象。 */
export function toolView(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  try {
    switch (name) {
      case 'Edit':
        if (typeof i.old_string === 'string' || typeof i.new_string === 'string') {
          const v = diffView(i.file_path, [[i.old_string, i.new_string]]);
          return i.replace_all ? { ...v, note: t('全部替换') } : v;
        }
        break;
      case 'MultiEdit':
        if (Array.isArray(i.edits)) return diffView(i.file_path, i.edits.map((e) => [e?.old_string, e?.new_string]));
        break;
      case 'Write':
        if (typeof i.content === 'string') {
          const lines = splitLines(i.content);
          const shown = lines.slice(0, MAX_WRITE_LINES).map((text) => ({ op: '+', text }));
          if (lines.length > MAX_WRITE_LINES) shown.push({ op: '…', count: lines.length - MAX_WRITE_LINES });
          return { kind: 'diff', file: str(i.file_path), rows: shown, added: lines.length, removed: 0, note: t('写入整个文件') };
        }
        break;
      case 'NotebookEdit':
        if (typeof i.new_source === 'string') {
          return { ...diffView(i.notebook_path, [['', i.new_source]]), note: t('单元格 {mode}', { mode: i.edit_mode || 'replace' }) };
        }
        break;
      case 'Bash':
        if (typeof i.command === 'string') return { kind: 'bash', command: i.command, description: str(i.description) };
        break;
      case 'TodoWrite':
        if (Array.isArray(i.todos)) {
          return { kind: 'todos', todos: i.todos.map((t) => ({ text: str(t?.content), status: str(t?.status) })) };
        }
        break;
      case 'AskUserQuestion':
        if (Array.isArray(i.questions) && i.questions.length > 0) {
          return {
            kind: 'questions',
            questions: i.questions.map((q) => ({
              header: str(q?.header),
              question: str(q?.question),
              multiSelect: !!q?.multiSelect,
              options: Array.isArray(q?.options)
                ? q.options.map((o) => (typeof o === 'string' ? o : str(o?.label))).filter(Boolean)
                : [],
            })),
          };
        }
        break;
      default:
        break;
    }
  } catch {
    return { kind: 'json' };
  }
  const LABELS = [
    ['file_path', '文件'], ['notebook_path', '笔记本'], ['path', '路径'], ['pattern', '匹配'], ['glob', '文件过滤'],
    ['url', '网址'], ['query', '搜索'], ['description', '说明'], ['prompt', '提示'], ['offset', '起始行'], ['limit', '行数'],
  ];
  const fields = LABELS.filter(([k]) => i[k] !== undefined && i[k] !== '').map(([k, label]) => [t(label), str(i[k])]);
  return fields.length > 0 ? { kind: 'fields', fields } : { kind: 'json' };
}

/** 列表折叠行上的一句话摘要：「a/b.ts +3 −1」「$ npm test」。 */
export function toolHeadline(name, input) {
  const v = toolView(name, input);
  if (v.kind === 'diff') {
    const counts = [v.added ? `+${v.added}` : '', v.removed ? `−${v.removed}` : ''].filter(Boolean).join(' ');
    return `${cwdTail(v.file, 2) || v.file}${counts ? `  ${counts}` : ''}`;
  }
  if (v.kind === 'bash') return `$ ${v.command.split('\n')[0]}`;
  if (v.kind === 'todos') {
    const done = v.todos.filter((t) => t.status === 'completed').length;
    return t('{done}/{total} 已完成', { done, total: v.todos.length });
  }
  if (v.kind === 'questions') {
    const first = v.questions[0];
    if (!first) return null;
    return first.header ? `${first.header} · ${first.question}` : first.question;
  }
  return null;
}

/** 工具执行出错时折叠行上的首行摘要。 */
export function toolErrorHeadline(text) {
  const first = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return '';
  return first.length > 48 ? `${first.slice(0, 48)}…` : first;
}

export const TOOL_BATCH_LIMIT = 3;
export const TOOL_BATCH_INTERVAL_MS = 650;

const pairScopeKey = (m) => (m?.toolUseId ? `${m.agentId || ''}:${m.toolUseId}` : '');

/**
 * 将列表中的 tool_use 与对应的 tool_result 合成为单条展示消息（挂在 tool_use.toolResult 上）。
 * 孤立的 tool_result（如分页边界处对应的 tool_use 尚未加载）原样保留。
 */
export function mergeToolMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const resultsById = new Map();
  const adjacentResults = new Map();
  let lastUnkeyedUse = null;

  for (const m of messages) {
    if (!m) continue;
    if (m.kind === 'tool_use') {
      lastUnkeyedUse = m.toolUseId ? null : m;
      continue;
    }
    if (m.kind === 'tool_result') {
      const scope = pairScopeKey(m);
      if (scope && !resultsById.has(scope)) {
        resultsById.set(scope, m);
      } else if (!scope && lastUnkeyedUse && !adjacentResults.has(lastUnkeyedUse)) {
        adjacentResults.set(lastUnkeyedUse, m);
        lastUnkeyedUse = null;
      }
      continue;
    }
    lastUnkeyedUse = null;
  }

  if (resultsById.size === 0 && adjacentResults.size === 0) return messages;

  const consumedResults = new Set();
  for (const m of messages) {
    if (m?.kind !== 'tool_use') continue;
    const scope = pairScopeKey(m);
    const res = scope ? resultsById.get(scope) : adjacentResults.get(m);
    if (res && !consumedResults.has(res)) consumedResults.add(res);
  }
  if (consumedResults.size === 0) return messages;

  const out = [];
  const pairedUses = new Set();
  for (const m of messages) {
    if (!m) continue;
    if (m.kind === 'tool_use') {
      const scope = pairScopeKey(m);
      const res = scope && !pairedUses.has(scope) ? resultsById.get(scope) : adjacentResults.get(m);
      if (res && consumedResults.has(res)) {
        if (scope) pairedUses.add(scope);
        const permissionDenial = res.permissionDenial || m.permissionDenial;
        out.push({
          ...m,
          toolResult: res,
          ...(permissionDenial ? { permissionDenial } : {}),
        });
        continue;
      }
    }
    if (m.kind === 'tool_result' && consumedResults.has(m)) continue;
    out.push(m);
  }
  return out;
}

/** 判断合并后的消息（或其内嵌的 toolResult）是否命中指定 msgKey。 */
export function matchesMessageKey(m, key) {
  if (!m || !key) return false;
  if (msgKey(m) === key) return true;
  return !!(m.toolResult && msgKey(m.toolResult) === key);
}

const isStepKind = (kind) => kind === 'tool_use' || kind === 'tool_result' || kind === 'thinking';

/**
 * 从实时消息队列中切出一批消息：
 * - 若存在非工具/思考类消息（如 user/assistant 文本），或队列仅有已露出卡片的 tool_result，则立即取出；
 * - 否则每次最多取出 maxTools 个 tool_use（连同其前置思考块及已到达的配对 tool_result）。
 */
export function takeToolBatch(queue, maxTools = TOOL_BATCH_LIMIT) {
  if (!Array.isArray(queue) || queue.length === 0) {
    return { batch: [], rest: [], immediate: false };
  }
  let lastImmediateIdx = -1;
  let hasNewStepCard = false;
  for (let i = 0; i < queue.length; i += 1) {
    const kind = queue[i]?.kind;
    if (!isStepKind(kind)) lastImmediateIdx = i;
    else if (kind === 'tool_use' || kind === 'thinking') hasNewStepCard = true;
  }
  if (lastImmediateIdx >= 0) {
    return {
      batch: queue.slice(0, lastImmediateIdx + 1),
      rest: queue.slice(lastImmediateIdx + 1),
      immediate: true,
    };
  }
  if (!hasNewStepCard) {
    return { batch: queue.slice(), rest: [], immediate: true };
  }

  const batch = [];
  const rest = [];
  const takenScopes = new Set();
  let toolCount = 0;
  let stopped = false;

  for (const m of queue) {
    const kind = m?.kind;
    if (!stopped) {
      if (kind === 'tool_use') {
        if (toolCount >= maxTools) {
          stopped = true;
          rest.push(m);
          continue;
        }
        toolCount += 1;
        const scope = pairScopeKey(m);
        if (scope) takenScopes.add(scope);
        batch.push(m);
      } else if (kind === 'thinking' && toolCount >= maxTools) {
        stopped = true;
        rest.push(m);
      } else {
        batch.push(m);
      }
      continue;
    }
    const scope = kind === 'tool_result' ? pairScopeKey(m) : '';
    if (scope && takenScopes.has(scope)) {
      batch.push(m);
    } else {
      rest.push(m);
    }
  }
  return { batch, rest, immediate: false };
}
