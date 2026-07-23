import { html, useCallback, useEffect, useRef, useState } from '../../vendor/preact-htm-standalone.module.js';
import { api } from '../../core/api.js';
import { toast } from '../../core/bus.js';
import { getNewSessionMode, setNewSessionMode, setSessionMode } from '../../core/modes.js';
import { fmtBytes, truncate } from '../utils.js';
import { ModePill, ModeSheet } from './mode-sheet.js';
import { ModelPicker } from './model-picker.js';

export function NewChatComposer({ projects, catalog, onCreated }) {
  const [draft, setDraft] = useState('');
  const [cwd, setCwd] = useState(projects[0] || '');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState(getNewSessionMode);
  const [modeOpen, setModeOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!cwd || !projects.includes(cwd)) setCwd(projects[0] || '');
  }, [projects, cwd]);

  const removeFile = (idx) => setFiles((xs) => xs.filter((_, i) => i !== idx));
  const create = useCallback(async () => {
    let text = draft.trim();
    if (!text || !cwd || busy) return;
    setBusy(true);
    try {
      if (files.length) {
        const uploaded = [];
        for (const f of files) {
          const r = await api(`/api/upload?filename=${encodeURIComponent(f.name)}`, {
            method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' },
          });
          uploaded.push(r.path);
        }
        text = `${text}\n\n[手机端上传的附件，已保存在本机，可直接读取]\n${uploaded.map((p) => `- ${p}`).join('\n')}`;
      }
      const body = { cwd, text, ...(model ? { model } : {}), ...(mode !== 'default' ? { permissionMode: mode } : {}) };
      const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
      setSessionMode(result.sessionId, mode);
      onCreated(result, body);
      setDraft('');
      setFiles([]);
    } catch (e) {
      if (e.status === 409) toast('所选项目当前不可创建新会话', 'error');
      else if (e.status === 413) toast('附件过大（上限 25MB）', 'error');
      else if (e.code === 'unknown_model') toast('该模型已不可用，请重新选择', 'error');
      else if (e.code === 'unknown_cwd') toast('该项目已不可用，请刷新后重试', 'error');
      else if (e.code !== 'unauthorized') toast(`新建失败：${e.code}`, 'error');
    } finally { setBusy(false); }
  }, [draft, cwd, model, mode, busy, files, onCreated]);

  const onInput = (e) => {
    setDraft(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
  };

  return html`
    <div class="new-composer">
      <div class="composer-card ${busy ? 'disabled' : ''}">
        ${files.length > 0 && html`
          <div class="attach-chips">
            ${files.map((f, i) => html`
              <span class="chip" key=${`${f.name}:${i}`}>
                <span class="chip-name">${truncate(f.name, 24)}</span>
                <span class="chip-size">${fmtBytes(f.size)}</span>
                <button type="button" class="chip-x" onClick=${() => removeFile(i)} aria-label="移除附件">✕</button>
              </span>`)}
          </div>`}
        <textarea ref=${taRef} rows="2" placeholder="今天想做什么？" value=${draft} disabled=${busy}
          onInput=${onInput}
          onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); } }}></textarea>
        <div class="composer-tools">
          <input ref=${fileRef} type="file" multiple hidden
            onChange=${(e) => { setFiles((xs) => [...xs, ...(e.target.files || [])]); e.target.value = ''; }} />
          <button type="button" class="tool-btn" title="选择附件" aria-label="选择附件" disabled=${busy} onClick=${() => fileRef.current?.click()}>+</button>
          <${ModelPicker} catalog=${catalog} value=${model} onChange=${setModel} compact=${true} />
          <${ModePill} mode=${mode} onOpen=${() => setModeOpen(true)} />
          <span class="flex1"></span>
          <button type="button" class="send-btn" disabled=${busy || !draft.trim() || !cwd} onClick=${create} aria-label="创建会话并发送">
            ${busy ? html`<span class="spin">⟳</span>` : '↑'}
          </button>
        </div>
      </div>
      ${files.length > 0 && html`<div class="new-attach-note">附件将随首条消息一起发送。</div>`}
      ${modeOpen && html`<${ModeSheet} mode=${mode} onSelect=${(m) => { setMode(m); setNewSessionMode(m); }} onClose=${() => setModeOpen(false)} />`}
    </div>`;
}
