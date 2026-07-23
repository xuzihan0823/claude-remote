import { html, useCallback, useEffect, useLayoutEffect, useRef, useState } from "../../vendor/preact-htm-standalone.module.js";
import { api, fetchSessions, pendingSessionMessages, sessionCache } from "../../core/api.js";
import { toast, useBus } from "../../core/bus.js";
import { PERMISSION_MODES, getSessionMode, setSessionMode } from "../../core/modes.js";
import { ws } from "../../core/ws.js";
import { useModelCatalog } from "../hooks.js";
import { cmpMsg, cwdTail, fmtBytes, fmtClock, msgKey, toolSummary, truncate } from "../utils.js";
import { StatusBadge } from "../components/conn-bar.js";
import { Markdown } from "../components/markdown.js";
import { ModePill, ModeSheet } from "../components/mode-sheet.js";
import { ModelPicker } from "../components/model-picker.js";
import { Spark } from "../components/spark.js";
export function MessageRow({ m }) {
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
    return html`
      <div class="msg user">
        <span class="avatar user-avatar">我</span>
        <div class="bubble">${m.text}</div>
        <div class="msg-time">${fmtClock(m.timestamp)}</div>
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
  const store = useRef({ map: new Map(), sorted: [] });
  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState(sessionCache.get(sessionId) || null);
  const [status, setStatus] = useState(sessionCache.get(sessionId)?.status || null);
  const [hasMore, setHasMore] = useState(false);
  const [firstSeq, setFirstSeq] = useState(null);
  const [initLoading, setInitLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [runActive, setRunActive] = useState(() => sessionCache.get(sessionId)?.status === 'daemon-driving');
  const [pending, setPending] = useState(null); // 已 POST、尚未从 WS 回显的用户消息
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
  const addMsgs = useCallback((list) => {
    const st = store.current;
    const fresh = [];
    for (const m of list) {
      const k = msgKey(m);
      if (!st.map.has(k)) { st.map.set(k, m); fresh.push(m); }
    }
    if (fresh.length === 0) return false;
    fresh.sort(cmpMsg);
    const sorted = st.sorted;
    // 快路径：fresh 内部已排序，若整体 ≥ 当前尾部则直接追加，跳过全量 sort。
    const canAppend = sorted.length === 0 || cmpMsg(sorted[sorted.length - 1], fresh[0]) <= 0;
    st.sorted = canAppend ? sorted.concat(fresh) : [...st.map.values()].sort(cmpMsg);
    setVersion((v) => v + 1);
    return true;
  }, []);
  // ---- 初始加载：尾部 100 条 + 会话元信息
  useEffect(() => {
    store.current = { map: new Map(), sorted: [] };
    setVersion((v) => v + 1);
    setInitLoading(true);
    setLoadErr('');
    stick.current = true;
    const initialText = pendingSessionMessages.get(sessionId);
    if (initialText) {
      setPending(initialText);
      pendingSessionMessages.delete(sessionId);
    }
    ws.subscribe(sessionId);
    (async () => {
      try {
        let d;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
            break;
          } catch (error) {
            if (error.code !== 'session_not_found' || attempt === 7) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        addMsgs(d.messages);
        setFirstSeq(d.firstSeq);
        setHasMore(d.hasMore);
      } catch (e) {
        setLoadErr(e.code === 'session_not_found' ? '会话不存在' : `加载失败：${e.code}`);
      } finally { setInitLoading(false); }
      if (!sessionCache.has(sessionId)) { try { await fetchSessions(200); } catch { /* 列表拿不到就用兜底展示 */ } }
      const s = sessionCache.get(sessionId);
      if (s) { setMeta(s); setStatus((st) => st ?? s.status); }
    })();
    return () => ws.unsubscribe(sessionId);
  }, [sessionId, addMsgs]);
  // ---- WS 事件
  const pendingBatch = useRef(null); // 同 tick 内多条 ws:message 合并成一次 addMsgs
  useBus('ws:message', (e) => {
    if (e.sessionId !== sessionId) return;
    const m = e.message;
    if (m.role === 'user' && m.kind === 'text') {
      setPending((p) => (p && m.text?.trim() === p.trim() ? null : p));
    }
    if (!pendingBatch.current) {
      pendingBatch.current = [];
      queueMicrotask(() => {
        const batch = pendingBatch.current;
        pendingBatch.current = null;
        if (batch && batch.length) addMsgs(batch);
      });
    }
    pendingBatch.current.push(m);
  }, [sessionId, addMsgs]);
  useBus('ws:status', (e) => { if (e.sessionId === sessionId) setStatus(e.status); }, [sessionId]);
  useBus('ws:run', (e) => {
    if (e.sessionId !== sessionId) return;
    if (e.state === 'started') {
      setRunActive(true);
      setActiveRunId(e.runId || null);
      // 本轮显式指定过模式才随帧带 permissionMode；缺席≠default，不据此降级本地记忆
      if (e.permissionMode && PERMISSION_MODES.includes(e.permissionMode)) {
        setMode(e.permissionMode);
        setSessionMode(sessionId, e.permissionMode);
      }
    } else {
      setRunActive(false);
      setActiveRunId(null);
      setPending(null);
      if (e.state === 'error') toast(`运行出错：${e.error || '未知错误'}`, 'error');
    }
  }, [sessionId]);
  // ---- resync：daemon 侧链视图失效（终端 rewind/fork 或文件截断），清空本地列表全量重拉
  useBus('ws:resync', async (e) => {
    if (e.sessionId !== sessionId) return;
    store.current = { map: new Map(), sorted: [] };
    setVersion((v) => v + 1);
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
      addMsgs(d.messages);
      setFirstSeq(d.firstSeq);
      setHasMore(d.hasMore);
    } catch { /* 拉取失败：等下次 ws-open 补缺口或用户翻页 */ }
  }, [sessionId, addMsgs]);
  // ---- 重连补缺口：拉尾部，若与已有消息无重叠则继续向前翻，直到接上（最多 3 页）
  useBus('ws-open', async () => {
    const st = store.current;
    if (st.map.size === 0) return;
    try {
      let d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
      let overlap = d.messages.some((m) => st.map.has(msgKey(m)));
      const pages = [d.messages];
      let guard = 0;
      let cursor = d.firstSeq;
      while (!overlap && d.hasMore && guard++ < 3) {
        d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${cursor}`);
        overlap = d.messages.some((m) => st.map.has(msgKey(m)));
        pages.push(d.messages);
        cursor = d.firstSeq;
      }
      addMsgs(pages.flat());
    } catch { /* 断线补拉失败，等下次重连 */ }
    // 断线期间可能错过 status 事件，顺带刷新会话状态
    try {
      await fetchSessions(200);
      const s = sessionCache.get(sessionId);
      if (s) { setMeta(s); setStatus(s.status); }
    } catch { /* 状态刷新失败不阻塞 */ }
  }, [sessionId, addMsgs]);
  // ---- 向上翻页
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || firstSeq == null) return;
    loadingOlder.current = true;
    const el = scrollRef.current;
    prependRef.current = { h: el.scrollHeight, top: el.scrollTop };
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${firstSeq}`);
      setFirstSeq(d.firstSeq);
      setHasMore(d.hasMore);
      if (!addMsgs(d.messages)) prependRef.current = null;
    } catch (e) {
      prependRef.current = null;
      toast(`历史加载失败：${e.code}`, 'error');
    } finally { loadingOlder.current = false; }
  }, [sessionId, hasMore, firstSeq, addMsgs]);
  // ---- 滚动维护
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependRef.current) {
      el.scrollTop = el.scrollHeight - prependRef.current.h + prependRef.current.top;
      prependRef.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [version, runActive, pending, initLoading]);
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
      setRunActive(false);
      setActiveRunId(null);
      setStatus('idle');
      toast('已停止当前运行', 'info');
    } catch (e) {
      if (e.status === 404 || e.status === 409 || e.code === 'no_active_run' || e.code === 'already_finished') {
        setRunActive(false);
        setActiveRunId(null);
        setStatus('idle');
        toast('运行已结束', 'info');
      } else if (e.code !== 'unauthorized') toast(`停止失败：${e.code}`, 'error');
    }
  }, [sessionId, activeRunId, isRunning]);
  const doSend = useCallback(async () => {
    if (!hasContent || !canSend) return;
    setSendBusy(true);
    try {
      // 先传附件（存到 Mac 本地），再把路径写进消息文本让 Claude 直接读
      const uploaded = [];
      for (const f of files) {
        const r = await api(`/api/sessions/${encodeURIComponent(sessionId)}/upload?filename=${encodeURIComponent(f.name)}`, {
          method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' },
        });
        uploaded.push(r.path);
      }
      let text = draft.trim();
      if (uploaded.length) {
        const list = uploaded.map((p) => `- ${p}`).join('\n');
        text = `${text || '请查看我上传的附件。'}\n\n[手机端上传的附件，已保存在本机，可直接读取]\n${list}`;
      }
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, ...(modelOverride ? { model: modelOverride } : {}), ...(mode !== 'default' ? { permissionMode: mode } : {}) }),
      });
      setPending(text);
      setDraft('');
      setFiles([]);
      if (taRef.current) taRef.current.style.height = 'auto';
      stick.current = true;
    } catch (e) {
      if (e.status === 409) {
        setStatus(e.data.status || null);
        const why = e.data.status === 'terminal-driving' ? '会话正被终端驾驶' : e.data.status === 'daemon-driving' ? 'Claude 正在运行' : '会话被占用';
        toast(`${why}，发送被拒`, 'error');
      } else if (e.status === 413) {
        toast('附件过大（上限 25MB）', 'error');
      } else if (e.code !== 'unauthorized') {
        toast(`发送失败：${e.code}`, 'error');
      }
    } finally { setSendBusy(false); }
  }, [draft, files, hasContent, canSend, sessionId, modelOverride, mode]);
  const onTaInput = (e) => {
    setDraft(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  };
  const onTaKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); }
  };
  const msgs = store.current.sorted;
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
          ${msgs.map((m) => html`<${MessageRow} key=${msgKey(m)} m=${m} />`)}
          ${pending && html`
            <div class="msg user pending">
              <span class="avatar user-avatar">我</span>
              <div class="bubble">${pending}</div>
              <div class="msg-time">发送中…</div>
            </div>`}
          ${runActive && html`
            <div class="msg assistant typing">
              <span class="avatar ai-avatar"><${Spark} /></span>
              <div class="msg-body"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>
            </div>`}
        </div>
      </div>
      ${showJump && html`<button class="jump-btn" onClick=${() => { stick.current = true; const el = scrollRef.current; el.scrollTop = el.scrollHeight; setShowJump(false); }}>↓</button>`}
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
