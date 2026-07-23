import { html, useState } from '../../vendor/preact-htm-standalone.module.js';
import { baseUrl } from '../../core/api.js';
import { Spark } from '../components/spark.js';

export function ConnForm({ initBase, initToken, busy, submitLabel, onSubmit }) {
  const [base, setBase] = useState(initBase);
  const [tok, setTok] = useState(initToken);
  return html`
    <form class="conn-form" onSubmit=${(e) => { e.preventDefault(); if (tok.trim()) onSubmit(base.trim(), tok.trim()); }}>
      <label class="field">
        <span class="field-label">Mac 服务器地址</span>
        <input type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false"
          placeholder="如 http://100.64.0.5:8787（留空 = 当前地址）"
          value=${base} onInput=${(e) => setBase(e.target.value)} />
        <span class="field-hint">填 Mac 的 Tailscale IP 或局域网 IP + daemon 端口</span>
      </label>
      <label class="field">
        <span class="field-label">访问令牌（BRIDGE_TOKEN）</span>
        <input type="password" autocomplete="off" placeholder="daemon .env 里的 BRIDGE_TOKEN"
          value=${tok} onInput=${(e) => setTok(e.target.value)} />
        <span class="field-hint">与 Mac 上 daemon 配置的 token 一致</span>
      </label>
      <button class="btn primary wide" type="submit" disabled=${busy || !tok.trim()}>
        ${busy ? '连接中…' : submitLabel}
      </button>
    </form>`;
}

export function SetupGate({ error, busy, onSubmit }) {
  return html`
    <div class="gate">
      <div class="gate-card">
        <${Spark} cls="gate-logo" />
        <h1 class="serif">Claude Remote</h1>
        <p class="gate-sub">连接你 Mac 上的 Claude Code</p>
        <${ConnForm} initBase=${baseUrl} initToken="" busy=${busy} submitLabel="连接" onSubmit=${onSubmit} />
        ${error && html`<p class="err">${error}</p>`}
        <p class="gate-help">Mac 端打开配对页，用相机扫码即可</p>
        <p class="gate-help">Mac 端：<code>cd claude-remote && pnpm dev</code> 启动 daemon，手机与 Mac 同一 Tailscale 网络</p>
      </div>
    </div>`;
}

export function PairConfirm({ req, busy, onConfirm, onCancel, hasExisting }) {
  return html`
    <div class="pair-overlay">
      <div class="gate-card pair-confirm">
        <h1 class="serif">扫码配对</h1>
        <p class="gate-sub">将连接以下 Mac 地址（按顺序探测）：</p>
        <ul class="pair-bases">${req.bases.map((b) => html`<li key=${b} class="mono">${b}</li>`)}</ul>
        ${hasExisting && html`<p class="err">注意：确认后将覆盖当前已保存的连接配置。</p>`}
        <div class="ap-actions">
          <button class="btn deny" disabled=${busy} onClick=${onCancel}>取消</button>
          <button class="btn allow" disabled=${busy} onClick=${onConfirm}>${busy ? '连接中…' : '确认连接'}</button>
        </div>
      </div>
    </div>`;
}
