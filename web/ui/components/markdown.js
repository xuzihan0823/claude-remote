import { html, useLayoutEffect, useRef } from '../../vendor/preact-htm-standalone.module.js';
import { marked } from '../../vendor/marked.esm.min.js';
import { escapeHtml } from '../utils.js';
import { baseUrl } from '../../core/api.js';
import { installLinkify, isSafeHref, resolveHref, splitLinks, wholeUrl } from '../../core/linkify.js';

installLinkify(marked);
const daemonBase = () => baseUrl || location.origin;

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(tok) { return escapeHtml(typeof tok === 'string' ? tok : (tok?.text ?? tok?.raw ?? '')); },
  },
});

export function Markdown({ text }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    try { el.innerHTML = marked.parse(text || ''); } catch { el.textContent = text || ''; }
    // 反引号里整段是链接（`http://localhost:3000`）也包成可点链接
    for (const c of el.querySelectorAll('code')) {
      if (c.closest('pre, a')) continue;
      const href = wholeUrl(c.textContent);
      if (!href) continue;
      const a = document.createElement('a');
      a.setAttribute('href', href);
      c.replaceWith(a);
      a.appendChild(c);
    }
    for (const a of el.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      if (!isSafeHref(href)) { a.removeAttribute('href'); continue; }
      a.setAttribute('href', resolveHref(href, daemonBase()));
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }, [text]);
  return html`<div class="md" ref=${ref}></div>`;
}

/** 纯文本里的链接可点（用户气泡、工具结果、思考过程）。 */
export function Linkified({ text }) {
  const segs = splitLinks(text);
  if (segs.length === 1 && !segs[0].href) return text;
  return segs.map((s, i) => (s.href
    ? html`<a key=${i} class="auto-link" href=${resolveHref(s.href, daemonBase())} target="_blank" rel="noopener noreferrer">${s.text}</a>`
    : s.text));
}
