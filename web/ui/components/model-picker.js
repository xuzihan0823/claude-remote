import { html, useEffect, useState } from '../../vendor/preact-htm-standalone.module.js';
import { findModel, modelCache, modelMainName, modelValue, resolveDefaultName } from '../../core/api.js';
import { cwdTail } from '../utils.js';

export function ModelPicker({ catalog, value, onChange, compact = false }) {
  const { models, defaultModel } = catalog || modelCache;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const sel = findModel(models, value);
  const defName = resolveDefaultName(catalog);
  const triggerMain = sel ? modelMainName(sel) : `默认${defName ? ` · ${defName}` : ''}`;
  const pick = (v) => { onChange(v); setOpen(false); };

  return html`
    <div class="model-picker ${compact ? 'compact' : ''}">
      <button type="button" class="model-trigger" aria-haspopup="dialog" aria-expanded=${open}
        onClick=${() => setOpen(true)}>
        <span class="model-trigger-name">${triggerMain}</span>
        <span class="model-caret">⌄</span>
      </button>
      ${open && html`
        <div class="sheet-overlay" onClick=${() => setOpen(false)}></div>
        <div class="sheet-panel model-menu" role="dialog" aria-modal="true" aria-label="选择模型">
          <span class="sheet-handle"></span>
          <div class="sheet-title">选择模型</div>
          <button type="button" class="model-opt ${!value ? 'on' : ''}" role="option" aria-selected=${!value} onClick=${() => pick('')}>
            <span class="model-opt-text">
              <span class="model-opt-main">跟随 Mac 默认</span>
              <span class="model-opt-sub">${defName ? `当前 ${defName}` : '使用 Mac settings.json 的默认模型'}</span>
            </span>
            ${!value && html`<span class="model-check">✓</span>`}
          </button>
          ${models.map((m) => {
            const v = modelValue(m);
            const on = sel && (sel.alias === m.alias && sel.id === m.id);
            return html`
              <button type="button" key=${v} class="model-opt ${on ? 'on' : ''}" role="option" aria-selected=${on} onClick=${() => pick(v)}>
                <span class="model-opt-text">
                  <span class="model-opt-main">${modelMainName(m)}</span>
                  ${m.alias && m.alias !== m.id && html`<span class="model-opt-sub">别名 ${m.alias}</span>`}
                </span>
                ${on && html`<span class="model-check">✓</span>`}
              </button>`;
          })}
        </div>`}
    </div>`;
}

export function ProjectPicker({ projects, value, onChange, compact = false }) {
  return html`
    <label class="select-control ${compact ? 'compact' : ''}">
      <span class="select-label">项目</span>
      <select value=${value || ''} onChange=${(e) => onChange(e.target.value)} aria-label="选择项目" disabled=${projects.length === 0}>
        ${projects.length === 0
          ? html`<option value="">暂无已知项目</option>`
          : projects.map((cwd) => html`<option key=${cwd} value=${cwd}>${cwdTail(cwd, 3)}</option>`)}
      </select>
    </label>`;
}
