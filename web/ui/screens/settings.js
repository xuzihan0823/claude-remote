import { html, useEffect, useState } from '../../vendor/preact-htm-standalone.module.js';
import { api, baseUrl, connHost, token } from '../../core/api.js';
import { bus, toast } from '../../core/bus.js';
import { ConnForm } from './setup.js';

export function SettingsPage({ onReconnect, goList }) {
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/health').then(setHealth).catch(() => setHealth(null)); }, []);

  const submit = async (base, tok) => {
    setBusy(true);
    const ok = await onReconnect(base, tok);
    setBusy(false);
    if (ok) { toast('已保存并重新连接', 'info'); goList(); }
  };

  return html`
    <div class="page settings-page">
      <header class="topbar">
        <button class="icon-btn back" onClick=${goList} aria-label="返回">‹</button>
        <div class="topbar-title serif">设置</div>
      </header>
      <div class="scroll">
        <div class="settings-body">
          <section class="settings-card">
            <h2>连接</h2>
            <${ConnForm} initBase=${baseUrl} initToken=${token} busy=${busy} submitLabel="保存并重新连接" onSubmit=${submit} />
          </section>
          <section class="settings-card">
            <h2>状态</h2>
            <dl class="kv">
              <div><dt>服务器</dt><dd class="mono">${connHost()}</dd></div>
              <div><dt>daemon</dt><dd>${health ? `v${health.version}` : '未连接'}</dd></div>
              <div><dt>Claude CLI</dt><dd>${health?.claudeCliVersion || '—'}</dd></div>
            </dl>
          </section>
          <section class="settings-card">
            <h2>快速上手</h2>
            <ol class="howto">
              <li>在 Mac 上安装并启动 daemon：<code>pnpm dev</code>（首次先在 <code>.env</code> 里设置 <code>BRIDGE_TOKEN</code>）</li>
              <li>Mac 与手机安装 <b>Tailscale</b> 并登录同一账号</li>
              <li>把 <code>.env</code> 的 <code>BRIDGE_HOST</code> 改为 Mac 的 Tailscale IP 并重启 daemon</li>
              <li>在上方填入 <code>http://«Tailscale IP»:8787</code> 与 token，保存即可</li>
            </ol>
          </section>
          <button class="btn ghost wide danger" onClick=${() => bus.emit('logout')}>断开并清除本机凭据</button>
        </div>
      </div>
    </div>`;
}
