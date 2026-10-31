// 工具调用的可读化：把 Claude Code 工具的 input 转成适合手机展示的结构（纯函数，便于测试）。
//
//   Edit / MultiEdit / Write / NotebookEdit → { kind: 'diff', file, rows, added, removed }
//   Bash                                    → { kind: 'bash', command, description }
//   TodoWrite                               → { kind: 'todos', todos }
//   其它（Read / Grep / Glob / WebFetch …）  → { kind: 'fields', fields: [[标签, 值]] }
// 任何意外结构都退回 { kind: 'json' }，由界面直接显示原始 JSON。

import { cwdTail } from './format.js';

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
          return i.replace_all ? { ...v, note: '全部替换' } : v;
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
          return { kind: 'diff', file: str(i.file_path), rows: shown, added: lines.length, removed: 0, note: '写入整个文件' };
        }
        break;
      case 'NotebookEdit':
        if (typeof i.new_source === 'string') {
          return { ...diffView(i.notebook_path, [['', i.new_source]]), note: `单元格 ${i.edit_mode || 'replace'}` };
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
  const fields = LABELS.filter(([k]) => i[k] !== undefined && i[k] !== '').map(([k, label]) => [label, str(i[k])]);
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
    return `${done}/${v.todos.length} 已完成`;
  }
  if (v.kind === 'questions') {
    const first = v.questions[0];
    if (!first) return null;
    return first.header ? `${first.header} · ${first.question}` : first.question;
  }
  return null;
}
