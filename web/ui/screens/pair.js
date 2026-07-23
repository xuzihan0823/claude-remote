import { html, useEffect, useState } from '../../vendor/preact-htm-standalone.module.js';
import { baseUrl } from '../../core/api.js';

export function PairPage({ goList }) {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [showTok, setShowTok] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    fetch(`${baseUrl}/api/pair-info`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`http_${res.status}`))))
      .then((d) => setInfo({ bases: Array.isArray(d.bases) ? d.bases : [], token: d.token || '' }))
      .catch(() => setFailed(true))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, []);

  return html`
    <div class="page pair-page">
      <header class="topbar">
        <button class="icon-btn back" onClick=${goList} aria-label="返回">‹</button>
        <div class="topbar-title serif">扫码配对</div>
      </header>
      <div class="scroll">
        <div class="pair-body">
          ${failed && html`
            <section class="settings-card">
              <p class="err">配对信息不可用：此页仅限 Mac 本机打开（<code>http://127.0.0.1:8788/#/pair</code>）。</p>
            </section>`}
          ${!failed && html`
            <section class="settings-card pair-qr-card">
              <img class="pair-qr" src="${baseUrl}/api/pair-qr.svg" alt="配对二维码" />
              <p class="pair-hint">用 iPhone 相机扫码，点「在 Claude Remote 中打开」即可自动配对</p>
            </section>
            <section class="settings-card">
              <h2>候选地址</h2>
              ${info
                ? html`<ul class="pair-bases">${info.bases.map((b) => html`<li key=${b} class="mono">${b}</li>`)}</ul>`
                : html`<div class="empty">加载中…</div>`}
            </section>
            <section class="settings-card">
              <h2>访问令牌</h2>
              <div class="pair-token-row">
                <span class="mono ellip">${info ? (showTok ? info.token : '••••••••••••') : '…'}</span>
                <button class="btn" type="button" disabled=${!info} onClick=${() => setShowTok((x) => !x)}>${showTok ? '隐藏' : '显示'}</button>
              </div>
              <p class="pair-hint">二维码即凭据，请勿截图外传；此页仅限 Mac 本机打开。</p>
            </section>`}
        </div>
      </div>
    </div>`;
}
