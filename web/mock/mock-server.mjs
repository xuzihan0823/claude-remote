#!/usr/bin/env node
// mock-server.mjs — 任务卡 05 的自测假后端。
// 实现 docs/api-contract.md 的全部端点 + WS 事件；纯 Node 内置模块，零依赖。
//
//   node web/mock/mock-server.mjs
//   BRIDGE_TOKEN=mock-token BRIDGE_PORT=8787
//
// mock 专属（契约之外，仅本文件）：
//   POST /__mock/drop-ws   强制断开所有 WS 连接，用于测试前端重连补缺口
//   发送内容含「审批」或 "approve" 会在模拟 run 中途触发一张审批卡

import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BRIDGE_PORT || process.env.PORT || 8787);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const TOKEN = process.env.BRIDGE_TOKEN || 'mock-token';
const APPROVAL_TTL_MS = Number(process.env.PERMISSION_TIMEOUT_MS || 90_000);

// ---------------------------------------------------------------- 假数据

const now = Date.now();
let uuidCounter = 0;
const nextUuid = () => `u-${(++uuidCounter).toString(36).padStart(6, '0')}`;

const MD_SAMPLES = [
  '先说结论：**watcher 需要 mtime 轮询兜底**。\n\n`fs.watch` 在 macOS 上对 append 触发 `change`，但编辑器原子写会触发 `rename`，两类都要处理：\n\n- `change` → 增量 tail\n- `rename` → 重新 open + seek\n- 轮询兜底间隔建议 `2000ms`\n\n详见 [Node 文档](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)。',
  '这个函数有个边界问题，修改如下：\n\n```ts\nexport function readTail(buf: Buffer, maxLines: number): string[] {\n  let idx = buf.length;\n  const lines: string[] = [];\n  while (idx > 0 && lines.length < maxLines) {\n    const nl = buf.lastIndexOf(0x0a, idx - 1);\n    lines.unshift(buf.subarray(nl + 1, idx).toString("utf8"));\n    idx = nl < 0 ? 0 : nl; // 这行修复了 nl === -1 时的死循环，同时保证首行不被丢弃\n  }\n  return lines;\n}\n```\n\n注意 `lastIndexOf` 的第二个参数是**包含**语义。',
  '三个方案对比：\n\n| 方案 | 延迟 | 复杂度 |\n|---|---|---|\n| fs.watch | ~10ms | 中（平台差异） |\n| 纯轮询 | ~2s | 低 |\n| FSEvents 原生 | ~5ms | 高（需编译） |\n\n阶段一选 **fs.watch + 轮询兜底**，理由是零依赖且延迟够用。',
  '已经改完了。要点：\n\n1. `SessionIndexer` 扫描改为惰性，首屏只 stat 不 parse\n2. 空文件直接返回 `(空会话)` 占位\n3. `cwd` 从行内字段读，目录名只做分组展示\n\n跑一下 `pnpm test` 应该 17 个全绿。',
];
const THINKING_SAMPLES = [
  '用户想要修 watcher 的抖动问题。先看 fs.watch 在 macOS 的行为差异……原子写会 rename，简单 change 监听会丢事件。需要 mtime 轮询兜底，间隔取 2s 比较均衡。',
  '这段代码的边界：nl 为 -1 时 subarray(0, idx) 是对的，但 idx 要落到 0 否则死循环。lines.length 上限判断放 while 条件里即可。',
  '先确认契约：seq 是行号，blockIndex 区分同行多 block。分页不能把同 seq 组切开，否则 beforeSeq 会跳过残块。',
];
const USER_PROMPTS = [
  '帮我看看 watcher 为什么偶尔丢事件',
  '把轮询间隔改成可配置的，默认 2 秒',
  'readTail 处理 7MB 文件要多久？给个基准',
  '这个报错是什么意思：ENOENT scandir .claude/projects',
  '把 parseTranscriptLine 的容错补全，未知 type 不要 throw',
  '给 SessionIndexer 加个 limit/offset 分页',
  '状态机 terminal-driving 回落的 120s 从哪读配置？',
  'review 一下我刚才那段 diff',
];

/** 生成一段会话 transcript：返回 RenderMessage[]（seq 有跳号、assistant 行拆多 block） */
function genTranscript(turns, startAt) {
  const out = [];
  let seq = 0;
  let t = startAt;
  const skip = () => { seq += 1 + (seq % 7 === 3 ? 2 : 0); }; // 模拟被过滤的行造成 seq 跳号
  const ts = () => new Date(t += 15_000 + (seq % 5) * 9_000).toISOString();
  let prevUuid = null;
  const push = (m) => { const uuid = nextUuid(); out.push({ uuid, parentUuid: prevUuid, ...m }); prevUuid = uuid; };

  for (let i = 0; i < turns; i++) {
    skip();
    push({ seq, blockIndex: 0, role: 'user', kind: 'text', text: USER_PROMPTS[i % USER_PROMPTS.length] + (i >= USER_PROMPTS.length ? `（第 ${i + 1} 轮）` : ''), timestamp: ts() });

    skip();
    const withThinking = i % 2 === 0;
    let bi = 0;
    if (withThinking) push({ seq, blockIndex: bi++, role: 'assistant', kind: 'thinking', text: THINKING_SAMPLES[i % THINKING_SAMPLES.length], timestamp: ts() });
    if (i % 3 === 1) {
      // 工具轮：assistant 同行 text+tool_use，随后 user 行 tool_result
      push({ seq, blockIndex: bi++, role: 'assistant', kind: 'text', text: '我先看一下现在的实现。', timestamp: ts() });
      const toolUseId = `toolu_${seq.toString(36)}`;
      const tools = [
        ['Bash', { command: `node --test packages/daemon/test/transcript.test.ts --reporter tap 2>&1 | tail -n 40`, description: '跑 transcript 测试' }],
        ['Read', { file_path: '/Users/mac/Desktop/claude-remote/packages/daemon/src/transcript.ts', limit: 120 }],
        ['Edit', { file_path: 'packages/daemon/src/watcher.ts', old_string: 'const POLL_MS = 2000', new_string: 'const POLL_MS = Number(process.env.WATCH_POLL_MS ?? 2000)' }],
      ];
      const [toolName, toolInput] = tools[i % tools.length];
      push({ seq, blockIndex: bi++, role: 'assistant', kind: 'tool_use', toolName, toolInput, toolUseId, timestamp: ts() });
      skip();
      const isError = i % 9 === 4;
      push({
        seq, blockIndex: 0, role: 'user', kind: 'tool_result', toolUseId, isError,
        text: isError
          ? `node:internal/modules/cjs/loader:1145\n  throw err;\n  ^\nError: Cannot find module 'tsx'\nRequire stack:\n- /Users/mac/Desktop/claude-remote/scripts/dev.cjs\n    at Function._resolveFilename (node:internal/modules/cjs/loader:1142:15)`
          : `TAP version 13\n# Subtest: readTail 处理 CRLF 与空行\nok 1 - readTail 处理 CRLF 与空行\n# Subtest: 7.88MB 文件 readTail(100) 耗时\nok 2 - 49ms < 200ms 预算\n1..2\n# pass 2\n# fail 0\n这是一行特别长的输出用来验证代码块横向滚动xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==END`,
        timestamp: ts(),
      });
      skip();
      push({ seq, blockIndex: 0, role: 'assistant', kind: 'text', text: MD_SAMPLES[i % MD_SAMPLES.length], timestamp: ts() });
    } else {
      push({ seq, blockIndex: bi++, role: 'assistant', kind: 'text', text: MD_SAMPLES[i % MD_SAMPLES.length], timestamp: ts() });
    }
    if (i % 10 === 6) { skip(); push({ seq, blockIndex: 0, role: 'user', kind: 'meta', rawType: 'file-history-snapshot', timestamp: ts() }); }
  }
  return out;
}

/** @type {Map<string, any[]>} sessionId -> RenderMessage[] */
const transcripts = new Map();
const sessions = [];

function addSession({ id, cwd, title, turns, status, agoMs }) {
  const sessionId = id;
  const startAt = now - agoMs - turns * 60_000;
  const msgs = turns > 0 ? genTranscript(turns, startAt) : [];
  transcripts.set(sessionId, msgs);
  const lastText = [...msgs].reverse().find((m) => m.kind === 'text');
  sessions.push({
    sessionId,
    cwd,
    projectDirName: cwd.replaceAll('/', '-'),
    title: turns > 0 ? title : '(空会话)',
    lastPreview: lastText ? lastText.text.replace(/\s+/g, ' ').slice(0, 80) : '',
    lastActiveAt: now - agoMs,
    sizeBytes: msgs.length * 987 + 1024,
    status,
  });
}

addSession({ id: '3e8a4b9c-1111-4000-8000-aaaaaaaaaaaa', cwd: '/Users/mac/Desktop/claude-remote', title: '帮我看看 watcher 为什么偶尔丢事件，顺便把轮询间隔做成可配置', turns: 120, status: 'idle', agoMs: 3 * 60_000 });
addSession({ id: '5c2d7e0f-2222-4000-8000-bbbbbbbbbbbb', cwd: '/Users/mac/Desktop/qq-claude-bridge', title: '审查 interactions 包的悬空 promise', turns: 18, status: 'terminal-driving', agoMs: 40_000 });
addSession({ id: '9f1a3b5d-3333-4000-8000-cccccccccccc', cwd: '/Users/mac/work/new-api', title: '渠道 failover 的排除逻辑改成带亲和性', turns: 9, status: 'idle', agoMs: 2 * 3600_000 });
addSession({ id: '7b4c6d8e-4444-4000-8000-dddddddddddd', cwd: '/Users/mac/Desktop/托管脚本迁移-中文路径', title: 'Trellis 初始化，Claude 与 Codex 双平台适配', turns: 5, status: 'idle', agoMs: 26 * 3600_000 });
addSession({ id: '1d9e2f3a-5555-4000-8000-eeeeeeeeeeee', cwd: '/Users/mac/Desktop/scratch', title: '', turns: 0, status: 'idle', agoMs: 3 * 24 * 3600_000 });

const bySession = (id) => sessions.find((s) => s.sessionId === id);
const maxSeq = (id) => { const a = transcripts.get(id) || []; return a.length ? a[a.length - 1].seq : 0; };
const MOCK_MODELS = [
  { id: 'claude-sonnet-4-20250514', alias: 'sonnet', displayName: 'Sonnet' },
  { id: 'claude-opus-4-20250514', alias: 'opus', displayName: 'Opus' },
  { id: 'claude-haiku-3-5-20241022', alias: 'haiku', displayName: 'Haiku' },
];
const runRecords = new Map();

// ---------------------------------------------------------------- WS server（手写最小实现）

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** @type {Set<{sock: import('net').Socket, subs: Set<string>}>} */
const wsClients = new Set();

function wsEncode(str, opcode = 0x1) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function wsAttach(req, sock) {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { sock, subs: new Set() };
  wsClients.add(client);
  log(`WS 连接建立（当前 ${wsClients.size} 个）`);

  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) break;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < off + 2) break; len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (buf.length < off + 8) break; len = Number(buf.readBigUInt64BE(off)); off += 8; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) break; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) break;
      const payload = buf.subarray(off, off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { try { sock.write(wsEncode('', 0x8)); } catch {} sock.destroy(); return; }
      if (opcode === 0x9) { sock.write(wsEncode(payload.toString(), 0xa)); continue; }
      if (opcode !== 0x1) continue;
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.type === 'subscribe' && typeof msg.sessionId === 'string') { client.subs.add(msg.sessionId); log(`  subscribe ${msg.sessionId}`); }
        if (msg.type === 'unsubscribe' && typeof msg.sessionId === 'string') client.subs.delete(msg.sessionId);
      } catch { /* 非 JSON 帧忽略 */ }
    }
  });
  const drop = () => { wsClients.delete(client); sock.destroy(); };
  sock.on('close', drop);
  sock.on('error', drop);
}

/** 按契约的订阅语义分发：session 订阅收该会话全部事件；"*" 只收 status/approval（resolved 广播给所有人） */
function broadcast(event) {
  const json = JSON.stringify(event);
  for (const c of wsClients) {
    let want = false;
    if (event.type === 'message' || event.type === 'run') want = c.subs.has(event.sessionId);
    else if (event.type === 'status') want = c.subs.has(event.sessionId) || c.subs.has('*');
    else if (event.type === 'approval') want = c.subs.has(event.interaction.sessionId) || c.subs.has('*');
    else if (event.type === 'approval.resolved') want = true;
    if (want) { try { c.sock.write(wsEncode(json)); } catch { /* 忽略写失败 */ } }
  }
}

function setStatus(sessionId, status) {
  const s = bySession(sessionId);
  if (!s || s.status === status) return;
  s.status = status;
  broadcast({ type: 'status', sessionId, status });
  log(`status ${sessionId.slice(0, 8)} → ${status}`);
}

/** 追加 RenderMessage 并广播（模拟 watcher 增量） */
function appendMsgs(sessionId, msgs) {
  const arr = transcripts.get(sessionId);
  const s = bySession(sessionId);
  for (const m of msgs) {
    arr.push(m);
    s.lastActiveAt = Date.now();
    s.sizeBytes += 900;
    if (m.kind === 'text') s.lastPreview = m.text.replace(/\s+/g, ' ').slice(0, 80);
    broadcast({ type: 'message', sessionId, message: m });
  }
}

// ---------------------------------------------------------------- interactions（审批）

/** @type {Map<string, {interaction:any,status:string,timer:any,onResolve:((st:string,answers?:any)=>void)|null}>} */
const interactions = new Map();
let approvalRotation = 0;

function createInteraction(sessionId, tpl, onResolve = null) {
  const interactionId = randomUUID();
  const interaction = { interactionId, sessionId, expiresAt: Date.now() + APPROVAL_TTL_MS, ...tpl };
  const rec = { interaction, status: 'pending', onResolve, timer: setTimeout(() => resolveInteraction(interactionId, 'expired'), APPROVAL_TTL_MS) };
  interactions.set(interactionId, rec);
  broadcast({ type: 'approval', interaction });
  log(`审批创建 ${tpl.kind} ${interaction.toolName || ''} (${interactionId.slice(0, 8)})`);
  return interactionId;
}

function resolveInteraction(id, status, answers) {
  const rec = interactions.get(id);
  if (!rec || rec.status !== 'pending') return false;
  rec.status = status;
  clearTimeout(rec.timer);
  broadcast({ type: 'approval.resolved', interactionId: id, status });
  log(`审批落定 ${id.slice(0, 8)} → ${status}`);
  rec.onResolve?.(status, answers);
  return true;
}

const APPROVAL_TEMPLATES = [
  () => ({ kind: 'approval', toolName: 'Bash', prompt: 'Claude 请求执行 shell 命令', input: { command: 'rm -rf node_modules && pnpm install --frozen-lockfile', description: '清理并重装依赖' } }),
  () => ({ kind: 'approval', toolName: 'Write', prompt: 'Claude 请求写入文件', input: { file_path: '/Users/mac/Desktop/claude-remote/packages/daemon/src/notify.ts', content: 'import http from "node:http";\n\nexport async function pushBark(url: string, title: string, body: string) {\n  // …省略 40 行…\n}\n' } }),
  () => ({
    kind: 'question', toolName: 'AskUserQuestion', prompt: '部署方式需要确认', input: {},
    questions: [{ question: '选择 daemon 的部署方式？', header: '部署', multiSelect: false, options: [
      { label: 'launchd 常驻', description: '开机自启，崩溃自动拉起' },
      { label: 'tmux 手动跑', description: '调试期用，重启后需手动' },
      { label: 'pm2', description: '需要多装一个全局依赖' },
    ] }],
  }),
  () => ({
    kind: 'question', toolName: 'AskUserQuestion', prompt: '通知渠道可多选', input: {},
    questions: [{ question: '启用哪些通知渠道？', header: '通知', multiSelect: true, options: [
      { label: 'Bark', description: 'iOS 推送，最快' },
      { label: 'ntfy', description: '跨平台，自建友好' },
      { label: '不通知', description: '只在网页里看' },
    ] }],
  }),
];

// ---------------------------------------------------------------- 模拟 run（POST messages 之后）

async function simulateRun(sessionId, text, runId) {
  const s = bySession(sessionId);
  const record = runRecords.get(runId) || { sessionId, canceled: false };
  runRecords.set(runId, record);
  setStatus(sessionId, 'daemon-driving');
  broadcast({ type: 'run', sessionId, runId, state: 'started' });
  let seq = maxSeq(sessionId);
  const ts = () => new Date().toISOString();
  const wait = (ms) => new Promise((resolve) => {
    if (record.canceled) { resolve(); return; }
    const timer = setTimeout(() => { record.cancelWait = null; resolve(); }, ms);
    record.cancelWait = () => { clearTimeout(timer); record.cancelWait = null; resolve(); };
  });
  const checkpoint = () => {
    if (!record.canceled) return false;
    broadcast({ type: 'run', sessionId, runId, state: 'error', error: 'aborted' });
    return true;
  };
  try {
    await wait(500);
    if (checkpoint()) return;
    seq += 2;
    appendMsgs(sessionId, [{ seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'user', kind: 'text', text, timestamp: ts() }]);
    await wait(1200);
    if (checkpoint()) return;
    seq += 1;
    const wantApproval = /审批|approve/i.test(text);
    if (wantApproval) {
      appendMsgs(sessionId, [
        { seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'assistant', kind: 'thinking', text: '用户想验证审批链路。我发起一个需要授权的 Bash 调用，等待网页端决定。', timestamp: ts() },
        { seq, blockIndex: 1, uuid: nextUuid(), parentUuid: null, role: 'assistant', kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'pnpm test --filter daemon', description: '跑 daemon 测试' }, toolUseId: `toolu_run_${seq}`, timestamp: ts() },
      ]);
      const decided = await new Promise((resolve) => {
        if (record.canceled) { resolve('aborted'); return; }
        const finish = (status) => { record.cancelWait = null; resolve(status); };
        record.cancelWait = () => finish('aborted');
        createInteraction(sessionId, { kind: 'approval', toolName: 'Bash', prompt: 'Claude 请求执行 shell 命令（本卡由你发的消息触发）', input: { command: 'pnpm test --filter daemon', description: '跑 daemon 测试' } }, finish);
      });
      if (record.canceled) { checkpoint(); return; }
      await wait(400);
      seq += 2;
      if (decided === 'allowed') {
        appendMsgs(sessionId, [
          { seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'user', kind: 'tool_result', toolUseId: `toolu_run_${seq}`, isError: false, text: '# pass 17\n# fail 0\n17 个测试全绿。', timestamp: ts() },
        ]);
        seq += 1;
        appendMsgs(sessionId, [{ seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'assistant', kind: 'text', text: '你**允许**了这次执行，测试已跑完：`17 passed / 0 failed`。审批链路（卡片 → 决策 → 工具继续）打通了。', timestamp: ts() }]);
      } else {
        appendMsgs(sessionId, [
          { seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'user', kind: 'tool_result', toolUseId: `toolu_run_${seq}`, isError: true, text: decided === 'denied' ? 'User denied the tool call.' : 'Permission request expired.', timestamp: ts() },
        ]);
        seq += 1;
        appendMsgs(sessionId, [{ seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'assistant', kind: 'text', text: decided === 'denied' ? '收到，这次执行被**拒绝**，我不跑测试了。拒绝路径验证 OK。' : '审批**超时**未决，按契约自动 deny。', timestamp: ts() }]);
      }
    } else {
      appendMsgs(sessionId, [
        { seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'assistant', kind: 'thinking', text: `收到手机端消息：「${text.slice(0, 60)}」。这是 mock 回复，演示 markdown 渲染与多 block 同 seq 去重。`, timestamp: ts() },
        { seq, blockIndex: 1, uuid: nextUuid(), parentUuid: null, role: 'assistant', kind: 'text', text: `收到：「${text.slice(0, 80)}」\n\n这是 **mock 的回复**，验证以下渲染：\n\n1. 同一 \`seq\` 的 thinking + text 两个 block\n2. 行内代码 \`readTail(100) = 49ms\`\n3. 代码块：\n\n\`\`\`bash\ncurl -s localhost:${PORT}/api/health -H "Authorization: Bearer ${TOKEN}"\n\`\`\`\n\n> 提示：发送内容里带「审批」两个字，可以触发一张审批卡走完整流程。`, timestamp: ts() },
      ]);
    }
    if (checkpoint()) return;
    broadcast({ type: 'run', sessionId, runId, state: 'done' });
  } catch (err) {
    if (!record.canceled) broadcast({ type: 'run', sessionId, runId, state: 'error', error: String(err) });
  } finally {
    runRecords.delete(runId);
    setStatus(sessionId, 'idle');
  }
}

// ---------------------------------------------------------------- 周期模拟器

// 每 20s：给 terminal-driving 的会话追加一条消息（模拟终端驾驶时的实时旁观）
const TERMINAL_SESSION = sessions[1].sessionId;
setInterval(() => {
  const s = bySession(TERMINAL_SESSION);
  if (s.status === 'daemon-driving') return;
  setStatus(TERMINAL_SESSION, 'terminal-driving');
  const seq = maxSeq(TERMINAL_SESSION) + 2;
  const roll = Math.floor(Date.now() / 20_000) % 3;
  const msgs = roll === 0
    ? [{ seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'user', kind: 'text', text: '（终端里敲的）继续，把剩下的测试补完', timestamp: new Date().toISOString() }]
    : [{ seq, blockIndex: 0, uuid: nextUuid(), parentUuid: null, role: 'assistant', kind: 'text', text: `终端驾驶中的实时消息 · ${new Date().toLocaleTimeString('zh-CN')}\n\n- watcher 每 20s 落一行\n- 网页端应当**同步滚出**这条`, timestamp: new Date().toISOString() }];
  appendMsgs(TERMINAL_SESSION, msgs);
}, 20_000);

// terminal-driving 静默回落：mock 简化为 60s 后回 idle（真实为 120s）
setInterval(() => {
  const s = bySession(TERMINAL_SESSION);
  if (s.status === 'terminal-driving' && Date.now() - s.lastActiveAt > 60_000) setStatus(TERMINAL_SESSION, 'idle');
}, 10_000);

// 每 45s：s3 状态翻转，演示列表徽标实时刷新
setInterval(() => {
  const s = sessions[2];
  setStatus(s.sessionId, s.status === 'idle' ? 'terminal-driving' : 'idle');
}, 45_000);

// 每 30s：推一张假审批（轮换四种模板）
setInterval(() => {
  const target = sessions[approvalRotation % 2 === 0 ? 0 : 2].sessionId;
  createInteraction(target, APPROVAL_TEMPLATES[approvalRotation++ % APPROVAL_TEMPLATES.length]());
}, 30_000);

// ---------------------------------------------------------------- HTTP

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function authed(req) {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1_000_000) throw new Error('body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return null; }
}

async function readRawBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function pageMessages(list, beforeSeq, limit) {
  const pool = beforeSeq ? list.filter((m) => m.seq < beforeSeq) : list;
  let start = Math.max(0, pool.length - limit);
  while (start > 0 && pool[start - 1].seq === pool[start].seq) start--; // 不把同 seq 的 block 组切开
  const page = pool.slice(start);
  return { messages: page, firstSeq: page.length ? page[0].seq : beforeSeq ?? 0, hasMore: start > 0 };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/') || p.startsWith('/__mock/')) {
      if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && p === '/api/health') {
        return sendJson(res, 200, { ok: true, version: 'mock-0.1.0', claudeCliVersion: '2.1.209' });
      }

      if (req.method === 'GET' && p === '/api/models') {
        return sendJson(res, 200, { defaultModel: 'sonnet', models: MOCK_MODELS });
      }

      if (req.method === 'GET' && p === '/api/sessions') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
        const offset = Number(url.searchParams.get('offset') || 0);
        const sorted = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        return sendJson(res, 200, { sessions: sorted.slice(offset, offset + limit), total: sessions.length });
      }

      if (req.method === 'POST' && p === '/api/sessions') {
        const body = await readBody(req);
        if (!body || typeof body.text !== 'string' || !body.text.trim()) return sendJson(res, 400, { error: 'bad_request' });
        const knownCwds = new Set(sessions.map((session) => session.cwd).filter(Boolean));
        if (typeof body.cwd !== 'string' || !knownCwds.has(body.cwd)) return sendJson(res, 400, { error: 'unknown_cwd' });
        if (body.model && !MOCK_MODELS.some((model) => model.alias === body.model || model.id === body.model)) return sendJson(res, 400, { error: 'unknown_model' });
        const sessionId = randomUUID();
        transcripts.set(sessionId, []);
        sessions.push({
          sessionId, cwd: body.cwd, projectDirName: body.cwd.replaceAll('/', '-'),
          title: body.text.trim().slice(0, 60), lastPreview: body.text.trim().slice(0, 80),
          lastActiveAt: Date.now(), sizeBytes: 0, status: 'idle',
        });
        const runId = randomUUID();
        simulateRun(sessionId, body.text.trim(), runId);
        return sendJson(res, 202, { sessionId, runId });
      }

      let m = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const list = transcripts.get(id);
        if (!list) return sendJson(res, 404, { error: 'session_not_found' });
        if (req.method === 'GET') {
          const beforeSeq = url.searchParams.has('beforeSeq') ? Number(url.searchParams.get('beforeSeq')) : undefined;
          const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
          return sendJson(res, 200, pageMessages(list, beforeSeq, limit));
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (!body || typeof body.text !== 'string' || !body.text.trim()) return sendJson(res, 400, { error: 'bad_request' });
          if (body.model && !MOCK_MODELS.some((model) => model.alias === body.model || model.id === body.model)) return sendJson(res, 400, { error: 'unknown_model' });
          const s = bySession(id);
          if (s.status !== 'idle') return sendJson(res, 409, { error: 'not_idle', status: s.status });
          const runId = randomUUID();
          simulateRun(id, body.text.trim(), runId); // 显式后台任务；内部自兜底，无未消费 rejection
          return sendJson(res, 202, { runId });
        }
      }

      m = p.match(/^\/api\/sessions\/([^/]+)\/abort$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        if (!bySession(id)) return sendJson(res, 404, { error: 'session_not_found' });
        const entry = [...runRecords.entries()].find(([, record]) => record.sessionId === id);
        if (!entry) return sendJson(res, 200, { runId: null, status: 'idle' });
        const [runId, record] = entry;
        record.canceled = true;
        record.cancelWait?.();
        return sendJson(res, 200, { runId, status: 'aborted' });
      }

      m = p.match(/^\/api\/sessions\/([^/]+)\/upload$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        if (!bySession(id)) return sendJson(res, 404, { error: 'session_not_found' });
        const body = await readRawBody(req);
        if (body.length === 0) return sendJson(res, 400, { error: 'empty_file' });
        const name = path.basename(url.searchParams.get('filename') || 'attachment.bin');
        return sendJson(res, 200, { path: `/tmp/claude-remote-mock/${id}/${name}`, name, sizeBytes: body.length });
      }

      m = p.match(/^\/api\/interactions\/([^/]+)\/decision$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const rec = interactions.get(id);
        if (!rec) return sendJson(res, 404, { error: 'not_found' });
        if (rec.status !== 'pending') return sendJson(res, 409, { error: 'already_resolved' });
        const body = await readBody(req);
        const kind = rec.interaction.kind;
        if (body?.type === 'allow_once' && kind === 'approval') { resolveInteraction(id, 'allowed'); return sendJson(res, 200, { status: 'allowed' }); }
        if (body?.type === 'deny' && kind === 'approval') { resolveInteraction(id, 'denied'); return sendJson(res, 200, { status: 'denied' }); }
        if (body?.type === 'answer' && kind === 'question' && body.answers && typeof body.answers === 'object') { resolveInteraction(id, 'answered', body.answers); return sendJson(res, 200, { status: 'answered' }); }
        return sendJson(res, 400, { error: 'decision_mismatch' });
      }

      if (req.method === 'POST' && p === '/__mock/drop-ws') {
        const n = wsClients.size;
        for (const c of wsClients) c.sock.destroy();
        wsClients.clear();
        log(`[mock] 强制断开 ${n} 个 WS 连接`);
        return sendJson(res, 200, { dropped: n });
      }

      return sendJson(res, 404, { error: 'not_found' });
    }

    // 静态托管 web/
    let rel = p === '/' ? '/index.html' : p;
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); return res.end(); }
    try {
      const st = await stat(file);
      const real = st.isDirectory() ? path.join(file, 'index.html') : file;
      const data = await readFile(real);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(real)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
  } catch (err) {
    log(`请求处理异常 ${p}: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
  }
});

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== TOKEN) {
    sock.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"error":"unauthorized"}');
    return sock.destroy();
  }
  wsAttach(req, sock);
});

function log(msg) { console.log(`[mock ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`); }

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换个端口再起：\n  BRIDGE_PORT=8788 node web/mock/mock-server.mjs`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`
┌─────────────────────────────────────────────────────┐
│  claude-remote mock server（任务卡 05 自测环境）
│
│  地址    http://${HOST}:${PORT}
│  Token   ${TOKEN}
│
│  · 每 20s 给「terminal-driving」会话推一条实时消息
│  · 每 30s 推一张审批卡（approval/question 轮换）
│  · 每 45s 翻转一个会话的状态徽标
│  · 发送内容带「审批」触发 run 中审批流程
│  · curl -X POST -H "Authorization: Bearer ${TOKEN}" \\
│      http://${HOST}:${PORT}/__mock/drop-ws   ← 测断线重连
└─────────────────────────────────────────────────────┘`);
});
