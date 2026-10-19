import { html, useCallback, useEffect, useLayoutEffect, useRef, useState } from "../../vendor/preact-htm-standalone.module.js";
import { api, fetchSessions, sessionCache } from "../../core/api.js";
import { toast, useBus } from "../../core/bus.js";
import { createConversationState, displayKey, newClientMessageId } from "../../core/conversation-state.js";
import { PERMISSION_MODES, getSessionMode, setSessionMode } from "../../core/modes.js";
import { ws } from "../../core/ws.js";
import { useModelCatalog } from "../hooks.js";
import { cwdTail, fmtBytes, fmtClock, toolSummary, truncate } from "../utils.js";
import { StatusBadge } from "../components/conn-bar.js";
import { Markdown } from "../components/markdown.js";
import { ModePill, ModeSheet } from "../components/mode-sheet.js";
import { ModelPicker } from "../components/model-picker.js";
import { Spark } from "../components/spark.js";
export function MessageRow({ m, onRetry }) {
  if (m.kind === 'meta') {
    return html`<div class="msg-meta">· ${m.rawType || 'meta'} ·</div>`;
  }
  if (m.kind === 'thinking') {
    return html`
      <details class="block thinking">
        <summary><${Spark} cls="blk-spark" />思考过程</summary>
        <div class="blk-body pre">${m.text}</div>
      </details>`;
  }
  if (m.kind === 'tool_use') {
    return html`
      <details class="block tool-use">
        <summary><span class="blk-ico">⚒</span><b>${m.toolName}</b><span class="blk-sub mono">${toolSummary(m)}</span></summary>
        <div class="blk-body"><pre class="mono">${JSON.stringify(m.toolInput ?? {}, null, 2)}</pre></div>
      </details>`;
  }
  if (m.kind === 'tool_result') {
    const chars = (m.text || '').length;
    return html`
      <details class="block tool-result ${m.isError ? 'is-err' : ''}">
        <summary><span class="blk-ico">${m.isError ? '✕' : '✓'}</span>${m.isError ? '工具出错' : '工具结果'}<span class="blk-sub">${chars} 字符</span></summary>
        <div class="blk-body pre mono">${m.text}</div>
      </details>`;
  }
  // kind === text
  if (m.role === 'user') {
    const status = m.status;
    const failed = status === 'failed';
    let label = fmtClock(m.timestamp);
    if (status === 'sending') label = '发送中…';
    else if (status === 'accepted') label = fmtClock(m.timestamp) || '已发送';
    else if (failed) label = '发送失败 · 重试';
    else if (status === 'unconfirmed') label = '发送结果待确认';
    return html`
      <div class="msg user ${status ? 'local' : ''}">
        <span class="avatar user-avatar">我</span>
        <div class="bubble">${m.text}</div>
        <div class="msg-time">${failed && onRetry
          ? html`<button class="retry-link" type="button" onClick=${() => onRetry(m)} aria-label="发送失败，重试">${label}</button>`
          : label}</div>
      </div>`;
  }
  return html`
    <div class="msg assistant">
      <span class="avatar ai-avatar"><${Spark} /></span>
      <div class="msg-body">
        <${Markdown} text=${m.text} />
        <div class="msg-time">${fmtClock(m.timestamp)}</div>
      </div>
    </div>`;
}
// ================================================================ 聊天页
export function Chat({ sessionId, goList }) {
  const catalog = useModelCatalog();
  const stateRef = useRef(null);
  if (!stateRef.current) stateRef.current = createConversationState();
  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState(sessionCache.get(sessionId) || null);
  const [status, setStatus] = useState(sessionCache.get(sessionId)?.status || null);
  const [hasMore, setHasMore] = useState(false);
  const [firstSeq, setFirstSeq] = useState(null);
  const [initLoading, setInitLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [runActive, setRunActive] = useState(() => sessionCache.get(sessionId)?.status === 'daemon-driving');
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState([]); // 待上传附件 File[]
  const [sendBusy, setSendBusy] = useState(false);
  const [modelOverride, setModelOverride] = useState('');
  const [mode, setMode] = useState(() => getSessionMode(sessionId));
  const [modeOpen, setModeOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef(null);
  const stick = useRef(true);
  const prependRef = useRef(null);
  const loadingOlder = useRef(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const sendLock = useRef(false); // 同步锁：sendBusy state 来不及阻止双击
  const activeRunIdRef = useRef(null);
  const runEpoch = useRef(0); // run 帧版本：快照飞行途中若 run 已变化，不回写陈旧运行状态
  const snapshotGen = useRef(0);
  const subscribed = useRef(false);
  const frameBuffer = useRef([]);
  const subTimer = useRef(null);
  const settling = useRef(false);
  const bumpScheduled = useRef(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const scheduleBump = useCallback(() => {
    if (bumpScheduled.current) return;
    bumpScheduled.current = true;
    queueMicrotask(() => { bumpScheduled.current = false; bump(); });
  }, [bump]);
  const refreshMeta = useCallback(async () => {
    try { await fetchSessions(200); } catch { return; }
    const s = sessionCache.get(sessionId);
    if (s) setMeta(s);
  }, [sessionId]);
  const refreshSessionStatus = useCallback(async () => {
    try { await fetchSessions(200); } catch { return; }
    const s = sessionCache.get(sessionId);
    if (s) { setMeta(s); setStatus(s.status); }
  }, [sessionId]);
  // ---- 快照：尾部 200 条 + 权威运行状态；旧连接的迟到响应由 generation 丢弃
  const snapshot = useCallback(async ({ retry = false, initial = false } = {}) => {
    const gen = ++snapshotGen.current;
    const epoch = runEpoch.current;
    try {
      let d;
      for (let attempt = 0; attempt < (retry ? 8 : 1); attempt++) {
        try {
          d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`);
          break;
        } catch (error) {
          if (!retry || error.code !== 'session_not_found' || attempt === 7) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (gen !== snapshotGen.current) return;
      stateRef.current.applySnapshot({
        messages: d.messages || [],
        firstSeq: d.firstSeq ?? null,
        hasMore: !!d.hasMore,
      });
      setFirstSeq(d.firstSeq ?? null);
      setHasMore(!!d.hasMore);
      if (d.status !== undefined) setStatus(d.status);
      if (epoch === runEpoch.current) {
        const runId = d.activeRunId ?? null;
        activeRunIdRef.current = runId;
        setActiveRunId(runId);
        setRunActive(d.status === 'daemon-driving' || runId != null);
      }
      if (!stick.current) setShowJump(true);
      if (initial) setLoadErr('');
      setInitLoading(false);
      bump();
      await refreshMeta();
    } catch (e) {
      if (gen !== snapshotGen.current) return;
      if (initial) setLoadErr(e.code === 'session_not_found' ? '会话不存在' : `加载失败：${e.code}`);
    } finally {
      if (initial) setInitLoading(false);
    }
  }, [sessionId, bump, refreshMeta]);
  const applyFrame = useCallback(({ type, event }) => {
    const state = stateRef.current;
    if (type === 'message') state.upsertOfficial(event.message);
    else if (type === 'stream') state.applyStream(event);
    else if (type === 'stream_snapshot') state.applyStreamSnapshot(event);
  }, []);
  const flushFrames = useCallback(() => {
    const frames = frameBuffer.current;
    frameBuffer.current = [];
    for (const frame of frames) applyFrame(frame);
    if (frames.length) bump();
  }, [applyFrame, bump]);
  const settleSubscription = useCallback(async () => {
    if (settling.current || subscribed.current) return;
    settling.current = true;
    clearTimeout(subTimer.current);
    try { await snapshot(); }
    finally {
      settling.current = false;
      subscribed.current = true;
      flushFrames();
    }
  }, [snapshot, flushFrames]);
  const beginSubscribeWait = useCallback(() => {
    subscribed.current = false;
    frameBuffer.current = [];
    clearTimeout(subTimer.current);
    subTimer.current = setTimeout(() => { void settleSubscription(); }, 3000);
  }, [settleSubscription]);
  const handleFrame = useCallback((type, event) => {
    if (!subscribed.current) { frameBuffer.current.push({ type, event }); return; }
    applyFrame({ type, event });
    scheduleBump();
  }, [applyFrame, scheduleBump]);
  // ---- 初始加载（等订阅 ack 后仍会再对账一次）
  useEffect(() => {
    stateRef.current.reset();
    bump();
    setInitLoading(true);
    setLoadErr('');
    setShowJump(false);
    stick.current = true;
    ws.subscribe(sessionId);
    beginSubscribeWait();
    void snapshot({ retry: true, initial: true });
    return () => {
      snapshotGen.current++;
      clearTimeout(subTimer.current);
      ws.unsubscribe(sessionId);
    };
  }, [sessionId]);
  // ---- WS 事件：订阅 ack 前先缓冲 live 帧，ack 后先快照再按序回放
  useBus('ws:subscribed', (e) => {
    if (e.sessionId !== sessionId || e.ok === false) return;
    void settleSubscription();
  }, [sessionId, settleSubscription]);
  useBus('ws:message', (e) => {
    if (e.sessionId !== sessionId) return;
    handleFrame('message', e);
  }, [sessionId, handleFrame]);
  useBus('ws:stream', (e) => {
    if (e.sessionId !== sessionId) return;
    handleFrame('stream', e);
  }, [sessionId, handleFrame]);
  useBus('ws:stream_snapshot', (e) => {
    if (e.sessionId !== sessionId) return;
    handleFrame('stream_snapshot', e);
  }, [sessionId, handleFrame]);
  useBus('ws:status', (e) => {
    if (e.sessionId !== sessionId) return;
    setStatus(e.status);
  }, [sessionId]);
  useBus('ws:run', (e) => {
    if (e.sessionId !== sessionId) return;
    if (e.state === 'started') {
      runEpoch.current++;
      if (activeRunIdRef.current && activeRunIdRef.current !== e.runId) {
        stateRef.current.clearStream(activeRunIdRef.current);
        bump();
      }
      activeRunIdRef.current = e.runId || null;
      setActiveRunId(e.runId || null);
      setRunActive(true);
      // 本轮显式指定过模式才随帧带 permissionMode；缺席≠default，不据此降级本地记忆
      if (e.permissionMode && PERMISSION_MODES.includes(e.permissionMode)) {
        setMode(e.permissionMode);
        setSessionMode(sessionId, e.permissionMode);
      }
      return;
    }
    if (activeRunIdRef.current !== null && activeRunIdRef.current !== e.runId) return;
    runEpoch.current++;
    stateRef.current.clearStream(e.runId);
    activeRunIdRef.current = null;
    setActiveRunId(null);
    setRunActive(false);
    bump();
    if (e.state === 'error') toast(`运行出错：${e.error || '未知错误'}`, 'error');
    void refreshSessionStatus();
  }, [sessionId, bump, refreshSessionStatus]);
  // ---- resync：daemon 侧链视图失效（终端 rewind/fork 或文件截断），清空本地列表全量重拉
  useBus('ws:resync', (e) => {
    if (e.sessionId !== sessionId) return;
    stateRef.current.reset();
    setFirstSeq(null);
    setHasMore(false);
    bump();
    void snapshot();
  }, [sessionId, bump, snapshot]);
  // ---- 重连对账：不因本地为空而跳过；ack 前缓冲 live 帧，同时先拉尾部补状态
  useBus('ws-open', () => {
    beginSubscribeWait();
    void snapshot();
  }, [beginSubscribeWait, snapshot]);
  // ---- 向上翻页
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || firstSeq == null) return;
    loadingOlder.current = true;
    const el = scrollRef.current;
    prependRef.current = { h: el.scrollHeight, top: el.scrollTop };
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${firstSeq}`);
      stateRef.current.applySnapshot({
        messages: d.messages || [],
        firstSeq: d.firstSeq ?? null,
        hasMore: !!d.hasMore,
      });
      setFirstSeq(d.firstSeq ?? null);
      setHasMore(!!d.hasMore);
      bump();
    } catch (e) {
      prependRef.current = null;
      toast(`历史加载失败：${e.code}`, 'error');
    } finally { loadingOlder.current = false; }
  }, [sessionId, hasMore, firstSeq, bump]);
  // ---- 滚动维护：只有贴底时才跟随；读旧历史时保留视口并显示“回到最新”
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependRef.current) {
      el.scrollTop = el.scrollHeight - prependRef.current.h + prependRef.current.top;
      prependRef.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [version, runActive, initLoading]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    stick.current = nearBottom;
    setShowJump(!nearBottom);
    if (el.scrollTop < 60) loadOlder();
  }, [loadOlder]);
  // ---- 键盘弹出时保持贴底：浏览器走 visualViewport；壳内 kb-change 高度过渡期间逐帧跟随
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const h = () => { if (stick.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; };
    vv.addEventListener('resize', h);
    return () => vv.removeEventListener('resize', h);
  }, []);
  useBus('kb-change', () => {
    const t0 = performance.now();
    const step = () => {
      if (stick.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      if (performance.now() - t0 < 350) requestAnimationFrame(step); // 覆盖 250ms 高度过渡
    };
    requestAnimationFrame(step);
  }, []);
  // ---- 附件
  const onPickFiles = (e) => {
    const picked = [...(e.target.files || [])];
    if (picked.length) setFiles((xs) => [...xs, ...picked]);
    e.target.value = '';
  };
  const removeFile = (i) => setFiles((xs) => xs.filter((_, idx) => idx !== i));
  // ---- 发送
  const isRunning = runActive || status === 'daemon-driving';
  const canSend = status === 'idle' && !sendBusy;
  const hasContent = draft.trim() !== '' || files.length > 0;
  const disabledReason = sendBusy ? '发送中…'
    : status === 'terminal-driving' ? '终端驾驶中，暂不可发送'
    : status === 'daemon-driving' ? 'Claude 正在运行…'
    : status == null ? '状态获取中…' : '';
  const stopRun = useCallback(async () => {
    if (!isRunning) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: JSON.stringify({ runId: activeRunId || undefined }) });
      runEpoch.current++;
      if (activeRunIdRef.current) stateRef.current.clearStream(activeRunIdRef.current);
      activeRunIdRef.current = null;
      setRunActive(false);
      setActiveRunId(null);
      setStatus('idle');
      bump();
      toast('已停止当前运行', 'info');
    } catch (e) {
      if (e.status === 404 || e.status === 409 || e.code === 'no_active_run' || e.code === 'already_finished') {
        runEpoch.current++;
        activeRunIdRef.current = null;
        setRunActive(false);
        setActiveRunId(null);
        setStatus('idle');
        toast('运行已结束', 'info');
      } else if (e.code !== 'unauthorized') toast(`停止失败：${e.code}`, 'error');
    }
  }, [sessionId, activeRunId, isRunning, bump]);
  const doSend = useCallback(async () => {
    if (!hasContent || !canSend || sendLock.current) return;
    sendLock.current = true;
    setSendBusy(true);
    const clientMessageId = newClientMessageId();
    const baseText = draft.trim();
    const pendingFiles = files;
    const localText = baseText || (pendingFiles.length ? '请查看我上传的附件。' : '');
    // 先落本地气泡（拿到同步 id），再清草稿；失败时文本仍可在气泡里恢复
    stateRef.current.addLocal(localText, clientMessageId);
    setDraft('');
    setFiles([]);
    if (taRef.current) taRef.current.style.height = 'auto';
    stick.current = true;
    bump();
    try {
      // 先传附件（存到 Mac 本地），再把路径写进消息文本让 Claude 直接读
      const uploaded = [];
      for (const f of pendingFiles) {
        const r = await api(`/api/sessions/${encodeURIComponent(sessionId)}/upload?filename=${encodeURIComponent(f.name)}`, {
          method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' },
        });
        uploaded.push(r.path);
      }
      let text = baseText;
      if (uploaded.length) {
        const list = uploaded.map((p) => `- ${p}`).join('\n');
        text = `${text || '请查看我上传的附件。'}\n\n[手机端上传的附件，已保存在本机，可直接读取]\n${list}`;
      }
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          clientMessageId,
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(mode !== 'default' ? { permissionMode: mode } : {}),
        }),
      });
      stateRef.current.markAccepted(clientMessageId, result?.runId ?? null);
      bump();
    } catch (e) {
      const statusCode = e.status ?? 0;
      const definite = (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429)
        || e.code === 'not_idle';
      stateRef.current.markFailed(clientMessageId, { definite });
      bump();
      if (e.status === 409) {
        setStatus(e.data?.status || null);
        const why = e.data?.status === 'terminal-driving' ? '会话正被终端驾驶' : e.data?.status === 'daemon-driving' ? 'Claude 正在运行' : '会话被占用';
        toast(`${why}，发送被拒`, 'error');
      } else if (e.status === 413) {
        toast('附件过大（上限 25MB）', 'error');
      } else if (e.code !== 'unauthorized') {
        toast(`发送失败：${e.code}`, 'error');
      }
    } finally {
      sendLock.current = false;
      setSendBusy(false);
    }
  }, [draft, files, hasContent, canSend, sessionId, modelOverride, mode, bump]);
  // 失败气泡只做用户显式重试；绝不自动重发
  const retryLocal = useCallback(async (m) => {
    if (sendLock.current) return;
    sendLock.current = true;
    const clientMessageId = m.clientMessageId;
    m.status = 'sending';
    bump();
    try {
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: m.text, clientMessageId }),
      });
      stateRef.current.markAccepted(clientMessageId, result?.runId ?? null);
    } catch (e) {
      const statusCode = e.status ?? 0;
      const definite = (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429)
        || e.code === 'not_idle';
      stateRef.current.markFailed(clientMessageId, { definite });
      if (e.code !== 'unauthorized') toast(`重试失败：${e.code}`, 'error');
    } finally {
      sendLock.current = false;
      bump();
    }
  }, [sessionId, bump]);
  const onTaInput = (e) => {
    setDraft(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  };
  const onTaKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); }
  };
  const msgs = stateRef.current.items();
  const hasStreamText = msgs.some((m) => m.key?.startsWith('stream:') && m.text);
  const title = meta?.title || sessionId.slice(0, 8);
  return html`
    <div class="page chat-page">
      <header class="topbar">
        <button class="icon-btn back" onClick=${goList} aria-label="返回">‹</button>
        <div class="topbar-mid">
          <div class="topbar-title serif ellip">${title}</div>
          <div class="topbar-sub"><span class="mono">${cwdTail(meta?.cwd || '')}</span> <${StatusBadge} status=${status} />${mode === 'bypassPermissions' && html` <span class="badge bypass">Bypass</span>`}</div>
        </div>
      </header>
      <div class="scroll msgs" ref=${scrollRef} onScroll=${onScroll}>
        <div class="msgs-inner">
          ${hasMore && html`<div class="load-older" onClick=${loadOlder}>↑ 加载更早消息</div>`}
          ${initLoading && html`<div class="empty">加载中…</div>`}
          ${loadErr && html`<div class="page-err">${loadErr}</div>`}
          ${!initLoading && !loadErr && msgs.length === 0 && html`<div class="empty">（空会话）</div>`}
          ${msgs.map((m) => html`<${MessageRow} key=${m.key || displayKey(m)} m=${m} onRetry=${retryLocal} />`)}
          ${runActive && !hasStreamText && html`
            <div class="msg assistant typing">
              <span class="avatar ai-avatar"><${Spark} /></span>
              <div class="msg-body"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>
            </div>`}
        </div>
      </div>
      ${showJump && html`<button class="jump-btn" onClick=${() => { stick.current = true; const el = scrollRef.current; el.scrollTop = el.scrollHeight; setShowJump(false); }} aria-label="回到最新消息">↓</button>`}
      <footer class="composer">
        ${isRunning && html`<div class="runbar"><span class="pulse"></span>Claude 正在运行… <button class="stop-link" onClick=${stopRun}>停止</button></div>`}
        ${!canSend && !isRunning && disabledReason && html`<div class="runbar muted">${disabledReason}</div>`}
        <div class="composer-card ${canSend ? '' : 'disabled'}">
          ${files.length > 0 && html`
            <div class="attach-chips">
              ${files.map((f, i) => html`
                <span class="chip" key=${`${f.name}:${i}`}>
                  <span class="chip-name">${truncate(f.name, 24)}</span>
                  <span class="chip-size">${fmtBytes(f.size)}</span>
                  <button class="chip-x" onClick=${() => removeFile(i)} aria-label="移除">✕</button>
                </span>`)}
            </div>`}
          <textarea ref=${taRef} rows="1" placeholder=${canSend ? '输入消息…' : disabledReason}
            value=${draft} disabled=${!canSend}
            onInput=${onTaInput} onKeyDown=${onTaKey}></textarea>
          <div class="composer-options">
            <${ModelPicker} catalog=${catalog} value=${modelOverride} onChange=${setModelOverride} compact=${true} />
            <${ModePill} mode=${mode} onOpen=${() => setModeOpen(true)} />
            <span class="override-note">${modelOverride ? '仅本轮' : '跟随 Mac 默认'}</span>
          </div>
          <div class="composer-tools">
            <input ref=${fileRef} type="file" multiple hidden onChange=${onPickFiles} />
            <button class="tool-btn" title="上传文件" disabled=${!canSend} onClick=${() => fileRef.current?.click()}>+</button>
            <span class="flex1"></span>
            ${isRunning
              ? html`<button class="send-btn stop-btn" disabled=${false} onClick=${stopRun} aria-label="停止生成">■</button>`
              : html`<button class="send-btn" disabled=${!canSend || !hasContent} onClick=${doSend} aria-label="发送">↑</button>`}
          </div>
        </div>
      </footer>
      ${modeOpen && html`<${ModeSheet} mode=${mode} onSelect=${(m) => { setMode(m); setSessionMode(sessionId, m); }} onClose=${() => setModeOpen(false)} />`}
    </div>`;
}
