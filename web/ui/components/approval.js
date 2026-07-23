import { html, useCallback, useEffect, useRef, useState } from '../../vendor/preact-htm-standalone.module.js';
import { api, sessionCache } from '../../core/api.js';
import { toast, useBus } from '../../core/bus.js';
import { truncate } from '../utils.js';

export function Countdown({ expiresAt, stop }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stop) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [stop]);
  const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const warn = left <= 20;
  return html`<span class="countdown ${warn ? 'warn' : ''}">${left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '已超时'}</span>`;
}

const RESOLVED_LABEL = { allowed: '已允许', denied: '已拒绝', answered: '已作答', expired: '已超时' };

export function ApprovalCard({ item, onDecide }) {
  const it = item.interaction;
  const [busy, setBusy] = useState(false);
  const [denyMsg, setDenyMsg] = useState('');
  const [answers, setAnswers] = useState(() => new Map((it.questions || []).map((q) => [q.question, { sel: new Set(), free: '' }])));
  const sess = sessionCache.get(it.sessionId);
  const sessLabel = sess?.title ? truncate(sess.title, 24) : it.sessionId.slice(0, 8);

  const decide = async (body) => {
    const status = body.type === 'deny' ? 'denied' : (body.type === 'answer' ? 'answered' : 'allowed');
    setBusy(true);
    onDecide(it.interactionId, 'resolve', status);
    try {
      const data = await api(`/api/interactions/${encodeURIComponent(it.interactionId)}/decision`, { method: 'POST', body: JSON.stringify(body) });
      if (data && data.status) onDecide(it.interactionId, 'resolve', data.status);
    } catch (e) {
      if (e.status === 409) toast('该审批已在别处处理', 'info');
      else if (e.status === 404) toast('审批已不存在', 'info');
      else {
        onDecide(it.interactionId, 'rollback');
        if (e.code !== 'unauthorized') toast(`提交失败：${e.code}`, 'error');
      }
    } finally { setBusy(false); }
  };
  const setAns = (q, fn) => setAnswers((old) => {
    const next = new Map(old);
    const cur = next.get(q) || { sel: new Set(), free: '' };
    next.set(q, fn({ sel: new Set(cur.sel), free: cur.free }));
    return next;
  });
  const allAnswered = (it.questions || []).every((q) => {
    const a = answers.get(q.question);
    return a && (a.free.trim() || a.sel.size > 0);
  });
  const submitAnswers = () => {
    const out = {};
    for (const q of it.questions || []) {
      const a = answers.get(q.question);
      out[q.question] = a.free.trim() || [...a.sel].join(', ');
    }
    decide({ type: 'answer', answers: out });
  };

  return html`
    <div class="approval-card ${item.resolved ? 'resolved' : ''}">
      ${item.resolved && html`<div class="stamp ${item.resolved}">${RESOLVED_LABEL[item.resolved] || item.resolved}</div>`}
      <div class="ap-head">
        <span class="ap-kind">${it.kind === 'question' ? '❓ 提问' : '🔐 审批'}</span>
        <span class="ap-tool">${it.toolName || ''}</span>
        <${Countdown} expiresAt=${it.expiresAt} stop=${!!item.resolved} />
      </div>
      <div class="ap-sess">会话：${sessLabel}</div>
      ${it.prompt && html`<div class="ap-prompt">${it.prompt}</div>`}
      ${it.kind === 'approval' && html`
        <details class="block ap-input">
          <summary><span class="blk-ico">⚒</span><span class="blk-sub mono">${truncate(JSON.stringify(it.input ?? {}), 80)}</span></summary>
          <div class="blk-body"><pre class="mono">${JSON.stringify(it.input ?? {}, null, 2)}</pre></div>
        </details>
        <input class="deny-msg" placeholder="拒绝理由（可选）" value=${denyMsg} onInput=${(e) => setDenyMsg(e.target.value)} />
        <div class="ap-actions">
          <button class="btn deny" disabled=${busy || !!item.resolved} onClick=${() => decide(denyMsg.trim() ? { type: 'deny', message: denyMsg.trim() } : { type: 'deny' })}>拒绝</button>
          <button class="btn allow" disabled=${busy || !!item.resolved} onClick=${() => decide({ type: 'allow_once' })}>允许一次</button>
        </div>`}
      ${it.kind === 'question' && html`
        ${(it.questions || []).map((q) => {
          const a = answers.get(q.question) || { sel: new Set(), free: '' };
          return html`
            <div class="ap-q" key=${q.question}>
              ${q.header && html`<span class="q-chip">${q.header}</span>`}
              <div class="q-text">${q.question}${q.multiSelect ? html`<span class="q-multi">（可多选）</span>` : ''}</div>
              <div class="q-opts">
                ${(q.options || []).map((o) => {
                  const on = a.sel.has(o.label);
                  return html`
                    <button key=${o.label} class="q-opt ${on ? 'on' : ''}" disabled=${busy}
                      onClick=${() => setAns(q.question, (cur) => {
                        if (q.multiSelect) { cur.sel.has(o.label) ? cur.sel.delete(o.label) : cur.sel.add(o.label); }
                        else { cur.sel = cur.sel.has(o.label) ? new Set() : new Set([o.label]); }
                        return cur;
                      })}>
                      <span class="q-opt-label">${o.label}</span>
                      ${o.description && html`<span class="q-opt-desc">${o.description}</span>`}
                    </button>`;
                })}
              </div>
              <input class="q-free" placeholder="或自由输入…" value=${a.free}
                onInput=${(e) => setAns(q.question, (cur) => { cur.free = e.target.value; return cur; })} />
            </div>`;
        })}
        <div class="ap-actions">
          <button class="btn allow" disabled=${busy || !allAnswered || !!item.resolved} onClick=${submitAnswers}>提交回答</button>
        </div>`}
    </div>`;
}

export function ApprovalLayer() {
  const [items, setItems] = useState([]);
  const removalTimers = useRef(new Map());
  const scheduleRemoval = useCallback((id) => {
    if (removalTimers.current.has(id)) return;
    const t = setTimeout(() => {
      removalTimers.current.delete(id);
      setItems((xs) => xs.filter((x) => x.interaction.interactionId !== id));
    }, 500);
    removalTimers.current.set(id, t);
  }, []);
  const cancelRemoval = useCallback((id) => {
    const t = removalTimers.current.get(id);
    if (t) { clearTimeout(t); removalTimers.current.delete(id); }
  }, []);
  useBus('ws:approval', ({ interaction }) => {
    setItems((xs) => (xs.some((x) => x.interaction.interactionId === interaction.interactionId) ? xs : [...xs, { interaction }]));
  }, []);
  useBus('ws:approval.resolved', ({ interactionId, status }) => {
    setItems((xs) => xs.map((x) => (x.interaction.interactionId === interactionId ? { ...x, resolved: status } : x)));
    scheduleRemoval(interactionId);
  }, []);
  const drop = (id, why, status) => {
    if (why === 'gone') { cancelRemoval(id); setItems((xs) => xs.filter((x) => x.interaction.interactionId !== id)); return; }
    if (why === 'rollback') { cancelRemoval(id); setItems((xs) => xs.map((x) => (x.interaction.interactionId === id ? { ...x, resolved: null } : x))); return; }
    setItems((xs) => xs.map((x) => (x.interaction.interactionId === id ? { ...x, resolved: status } : x)));
    scheduleRemoval(id);
  };
  if (items.length === 0) return null;
  const current = items[0];
  return html`
    <div class="approval-layer">
      ${items.length > 1 && html`<div class="approval-queue">还有 ${items.length - 1} 个待处理</div>`}
      <${ApprovalCard} key=${current.interaction.interactionId} item=${current} onDecide=${drop} />
    </div>`;
}
