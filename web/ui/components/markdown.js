import { html, useLayoutEffect, useRef } from '../../vendor/preact-htm-standalone.module.js';
import { marked } from '../../vendor/marked.esm.min.js';
import { escapeHtml } from '../utils.js';
import { highlight, normalizeLang } from '../../core/highlight.js';
import { installMath } from '../../core/md-math.js';
import { resolveImageSrc } from '../../core/md-image.js';

// 公式先输出占位（原 TeX 文本），渲染后再按需加载 KaTeX 填进去：首屏不背 270KB，流式时也不阻塞。
installMath(marked, {
  renderer: (tok) => (tok.display
    ? `<div class="math math-display" data-tex="${escapeHtml(tok.text)}">${escapeHtml(tok.text)}</div>`
    : `<span class="math math-inline" data-tex="${escapeHtml(tok.text)}">${escapeHtml(tok.text)}</span>`),
});

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(tok) { return escapeHtml(typeof tok === 'string' ? tok : (tok?.text ?? tok?.raw ?? '')); },
    code(tok) {
      const lang = normalizeLang(tok.lang);
      const body = highlight(tok.text || '', lang)
        .map((p) => (p.k === 'plain' ? escapeHtml(p.t) : `<span class="hl-${p.k}">${escapeHtml(p.t)}</span>`))
        .join('');
      return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${body}</code></pre>\n`;
    },
    // 图片地址在 DOM 阶段解析（要会话 id 与鉴权），这里只留原始 src
    image(tok) {
      const alt = escapeHtml(tok.text || '');
      return `<img class="md-img" data-src="${escapeHtml(tok.href || '')}" alt="${alt}"${tok.title ? ` title="${escapeHtml(tok.title)}"` : ''}>`;
    },
  },
});

let katexP = null;
function loadKatex() {
  if (!katexP) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../vendor/katex/katex.min.css', import.meta.url).href;
    document.head.appendChild(link);
    katexP = import('../../vendor/katex/katex.min.mjs').then((m) => m.default || m).catch(() => { katexP = null; return null; });
  }
  return katexP;
}

async function renderMath(el) {
  const nodes = el.querySelectorAll('.math[data-tex]:not([data-done])');
  if (!nodes.length) return;
  const katex = await loadKatex();
  if (!katex) return;
  for (const n of nodes) {
    if (!n.isConnected) continue;
    try {
      katex.render(n.dataset.tex, n, { displayMode: n.classList.contains('math-display'), throwOnError: false, output: 'html', strict: 'ignore' });
      n.dataset.done = '1';
    } catch { /* 保留原 TeX 文本 */ }
  }
}

// 本机图片要带 Bearer：fetch 成 blob URL，按地址缓存，流式重绘时不重复下载
const blobCache = new Map();
function authedBlob(r) {
  if (!blobCache.has(r.uri)) {
    blobCache.set(r.uri, fetch(r.uri, { headers: r.headers })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((b) => URL.createObjectURL(b))
      .catch((e) => { blobCache.delete(r.uri); throw e; }));
  }
  return blobCache.get(r.uri);
}

function wireImages(el, sessionId) {
  for (const img of el.querySelectorAll('img.md-img[data-src]')) {
    const raw = img.getAttribute('data-src');
    img.removeAttribute('data-src');
    const r = resolveImageSrc(raw, { sessionId });
    if (!r) {
      // 解析不了：退化为链接文字
      const a = document.createElement('a');
      a.textContent = img.alt || raw;
      a.href = /^\s*javascript:/i.test(raw) ? '#' : raw;
      img.replaceWith(a);
      continue;
    }
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => { img.classList.add('md-img-err'); img.title = `图片加载失败：${raw}`; };
    const open = (href) => { img.onclick = () => window.open(href, '_blank', 'noopener'); };
    if (r.local) {
      authedBlob(r).then((u) => { img.src = u; open(u); }).catch(() => img.onerror());
    } else {
      img.referrerPolicy = 'no-referrer';
      img.src = r.uri;
      open(r.uri);
    }
  }
}

export function Markdown({ text, sessionId }) {
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
    wireImages(el, sessionId);
    renderMath(el);
  }, [text, sessionId]);
  return html`<div class="md" ref=${ref}></div>`;
}
