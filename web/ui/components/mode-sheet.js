// mode-sheet.js — 权限模式 pill + 底部 sheet；选 Bypass 需二次确认
import { html, useState } from '../../vendor/preact-htm-standalone.module.js';
import { PERMISSION_MODES } from '../../core/modes.js';

const MODE_LABELS = {
  default: '标准',
  acceptEdits: '自动编辑',
  plan: '规划',
  bypassPermissions: 'Bypass',
};

export function ModePill({ mode, onOpen }) {
  return html`<button class="mode-pill${mode !== 'default' ? ' active' : ''}" type="button" onClick=${onOpen} aria-haspopup="dialog">
    ${MODE_LABELS[mode] || '标准'}
  </button>`;
}

export function ModeSheet({ mode, onSelect, onClose }) {
  const [confirming, setConfirming] = useState(false);
  const pick = (m) => {
    // 已处于 bypass 时再点 bypass 不再确认；从其它模式切入才拦
    if (m === 'bypassPermissions' && mode !== 'bypassPermissions') { setConfirming(true); return; }
    onSelect(m);
    onClose();
  };
  return html`
    <div class="sheet-overlay" onClick=${onClose}></div>
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="权限模式">
      <span class="sheet-handle"></span>
      <div class="sheet-title">权限模式</div>
      ${PERMISSION_MODES.map((m) => html`
        <button type="button" key=${m} class="model-opt ${mode === m ? 'on' : ''}" onClick=${() => pick(m)}>
          <span class="model-opt-text">
            <span class="model-opt-main">${MODE_LABELS[m]}</span>
            <span class="model-opt-sub">${m === 'bypassPermissions' ? '全自动，危险' : m === 'acceptEdits' ? '自动同意文件编辑' : m === 'plan' ? '只读规划模式' : '逐项审批（默认）'}</span>
          </span>
          ${mode === m && html`<span class="model-check">✓</span>`}
        </button>`)}
      ${confirming && html`
        <div class="confirm-overlay" onClick=${() => setConfirming(false)}></div>
        <div class="confirm-card" role="alertdialog" aria-modal="true">
          <div class="confirm-title">启用 Bypass 模式？</div>
          <div class="confirm-text">Claude 将不再请求任何审批，直接执行所有操作（含文件修改与命令执行）。仅在完全信任当前任务时使用。</div>
          <div class="confirm-actions">
            <button type="button" class="btn" onClick=${() => setConfirming(false)}>取消</button>
            <button type="button" class="btn confirm-danger" onClick=${() => { onSelect('bypassPermissions'); onClose(); }}>启用</button>
          </div>
        </div>`}
    </div>`;
}
