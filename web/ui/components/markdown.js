import { html, useLayoutEffect, useRef } from '../../vendor/preact-htm-standalone.module.js';
import { marked } from '../../vendor/marked.esm.min.js';
import { escapeHtml } from '../utils.js';

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
    for (const a of el.querySelectorAll('a')) {
      if (/^\s*javascript:/i.test(a.getAttribute('href') || '')) a.setAttribute('href', '#');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }, [text]);
  return html`<div class="md" ref=${ref}></div>`;
}
