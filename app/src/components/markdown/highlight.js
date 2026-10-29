// 代码块语法高亮：highlight.js core + 常用语言，只在代码块标了已知语言时生效。
// hljs 输出 HTML 字符串，这里拆成 [{ text, kind }] 片段，kind 对应 theme 里 colors.syntax 的键。
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash, c, cpp, css, diff, go, java, javascript, json, kotlin,
  markdown, python, rust, sql, swift, typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

// hljs scope -> 配色键；值为 null 表示回到默认字色（如模板字符串里的 ${}）
const SCOPE_KIND = {
  keyword: 'keyword', 'selector-tag': 'keyword', name: 'keyword', bullet: 'keyword', deletion: 'keyword',
  string: 'string', regexp: 'string', symbol: 'string', char: 'string', addition: 'string',
  number: 'number', literal: 'number',
  comment: 'comment', quote: 'comment', doctag: 'comment',
  title: 'title', 'title.function': 'title', section: 'title',
  type: 'type', built_in: 'type', 'title.class': 'type', 'title.class.inherited': 'type',
  attr: 'attr', attribute: 'attr', property: 'attr', 'selector-class': 'attr', 'selector-id': 'attr', 'template-variable': 'attr',
  meta: 'meta',
  subst: null,
};

// 超长代码不高亮，避免流式输出时每次增量都重算拖慢渲染
const MAX_CHARS = 20000;
const CACHE_SIZE = 64;
const cache = new Map();

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#x27);/g, (_, e) => ENTITIES[e]);

function scopeOf(className) {
  const parts = className.split(' ').map((p) => p.replace(/^hljs-/, '').replace(/_+$/, ''));
  return parts.join('.');
}

function kindOf(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const scope = stack[i];
    if (scope in SCOPE_KIND) return SCOPE_KIND[scope];
    const base = scope.split('.')[0];
    if (base in SCOPE_KIND) return SCOPE_KIND[base];
  }
  return null;
}

// 返回 [{ text, kind }]；语言未标注 / 不支持 / 代码过长时返回 null，调用方按纯文本渲染
export function highlightCode(code, lang) {
  const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (!language || !hljs.getLanguage(language) || code.length > MAX_CHARS) return null;

  const cacheKey = `${language}\n${code}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let html;
  try {
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }

  const segments = [];
  const stack = [];
  for (const m of html.matchAll(/<span class="([^"]+)">|<\/span>|[^<]+/g)) {
    if (m[1] !== undefined) stack.push(scopeOf(m[1]));
    else if (m[0] === '</span>') stack.pop();
    else {
      const text = decode(m[0]);
      const kind = kindOf(stack);
      const last = segments[segments.length - 1];
      if (last && last.kind === kind) last.text += text;
      else segments.push({ text, kind });
    }
  }

  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, segments);
  return segments;
}
