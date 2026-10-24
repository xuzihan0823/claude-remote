// 轻量代码语法高亮：web 与 RN 共用。不追求完整语法，只把代码切成带类别的片段：
//   comment / string / number / keyword / literal / type / func / attr / tag / meta / add / del / plain
// web 渲染成 <span class="hl-xxx">，RN 渲染成带颜色的 <Text>。
// 设计要点：纯正则单遍扫描、片段拼回去必须与原文逐字相等（测试兜底）、未知语言返回整段 plain。

const KW = {
  js: 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as get set',
  ts: 'abstract declare enum implements interface keyof namespace private protected public readonly satisfies type infer is',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self',
  sh: 'if then else elif fi for while until do done case esac in function return local export source alias unset set echo cd exit sudo',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rust: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  swift: 'actor as associatedtype async await break case catch class continue default defer do else enum extension fallthrough for func guard if import in init inout internal is let mutating nonisolated open private protected public repeat return self Self some static struct subscript super switch throw throws try var where while any',
  java: 'abstract assert break case catch class const continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static super switch synchronized this throw throws transient try var void volatile while fun val override object companion data sealed when is in internal lateinit suspend',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override new delete using operator friend nullptr constexpr auto bool',
  sql: 'select from where and or not insert into values update set delete create table drop alter add primary key foreign references join left right inner outer on group by order having limit offset as distinct union all index view if exists null is like in between case when then else end returning with',
  css: '',
  ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor',
  php: 'abstract and array as break case catch class clone const continue declare default do echo else elseif empty endif endforeach endwhile extends final finally fn for foreach function global if implements include instanceof interface isset list match namespace new or print private protected public require return static switch throw trait try unset use var while yield',
};
const LITERALS = 'true false null undefined None True False nil NaN Infinity';

const ALIASES = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts', mts: 'ts',
  python: 'py', py3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh', fish: 'sh',
  golang: 'go', rs: 'rust',
  kotlin: 'java', kt: 'java', scala: 'java', groovy: 'java', dart: 'java', csharp: 'java', cs: 'java',
  cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', objc: 'c', 'objective-c': 'c', cc: 'c',
  rb: 'ruby', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', plsql: 'sql',
  scss: 'css', less: 'css', sass: 'css',
  html: 'xml', xhtml: 'xml', svg: 'xml', vue: 'xml', plist: 'xml',
  jsonc: 'json', json5: 'json',
  yml: 'yaml', toml: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', dotenv: 'ini',
  patch: 'diff',
  dockerfile: 'sh', docker: 'sh', makefile: 'sh', make: 'sh',
};

/** 归一化语言名；不认识返回 ''。 */
export function normalizeLang(lang) {
  const l = String(lang || '').trim().split(/[\s{]/)[0].toLowerCase();
  if (!l) return '';
  const a = ALIASES[l] || l;
  return a in KW || ['json', 'yaml', 'xml', 'ini', 'diff'].includes(a) ? a : '';
}

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
const KWSETS = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, words(v)]));
KWSETS.ts = new Set([...KWSETS.js, ...KWSETS.ts]);
const LITSET = words(LITERALS);

// 各语言的注释 / 字符串规则（顺序即优先级，前面的先匹配）
const LINE_COMMENT = { js: '//', ts: '//', go: '//', rust: '//', swift: '//', java: '//', c: '//', php: '//', py: '#', sh: '#', ruby: '#', yaml: '#', ini: '[#;]', sql: '--' };
const BLOCK_COMMENT = new Set(['js', 'ts', 'go', 'rust', 'swift', 'java', 'c', 'css', 'php', 'sql']);

function lexerFor(lang) {
  const parts = [];
  if (BLOCK_COMMENT.has(lang)) parts.push(['comment', '/\\*[\\s\\S]*?(?:\\*/|$)']);
  if (lang === 'xml') parts.push(['comment', '<!--[\\s\\S]*?(?:-->|$)']);
  if (lang === 'py') parts.push(['string', '[rbfuRBFU]{0,2}(?:"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$))']);
  if (LINE_COMMENT[lang]) {
    const lc = LINE_COMMENT[lang];
    // sh / yaml 里 # 只在行首或空白后才是注释（避免 $# 、url#hash）
    const pre = ['sh', 'yaml', 'ini'].includes(lang) ? '(?:^|(?<=\\s))' : '';
    parts.push(['comment', `${pre}${lc.length > 1 && lc[0] !== '[' ? lc.replace(/[/]/g, '\\/') : lc}.*`]);
  }
  if (['js', 'ts'].includes(lang)) parts.push(['string', '`(?:\\\\[\\s\\S]|[^`\\\\])*(?:`|$)']);
  if (lang === 'go') parts.push(['string', '`[^`]*(?:`|$)']);
  if (lang === 'rust') parts.push(['string', 'r#*"[\\s\\S]*?"#*']);
  // 普通字符串（单行）。rust/swift/java/c/go 的单引号是字符，也当字符串着色
  if (lang !== 'xml') parts.push(['string', '"(?:\\\\.|[^"\\\\\\n])*"?']);
  if (!['rust'].includes(lang) && lang !== 'xml') parts.push(['string', "'(?:\\\\.|[^'\\\\\\n])*'?"]);
  if (lang === 'rust') parts.push(['string', "'(?:\\\\.|[^'\\\\\\n])'"]);
  if (lang === 'xml') {
    parts.push(['meta', '<[?!][^>]*>?']);
    parts.push(['tag', '</?[A-Za-z][\\w:.-]*']);
    parts.push(['tag', '/?>']);
    parts.push(['string', '"[^"]*"?|\'[^\']*\'?']);
    parts.push(['attr', '[A-Za-z_:][\\w:.-]*(?==)']);
  }
  if (lang === 'css') {
    parts.push(['attr', '[a-zA-Z-]+(?=\\s*:)']);
    parts.push(['meta', '@[a-zA-Z-]+']);
    parts.push(['number', '#[0-9a-fA-F]{3,8}\\b']);
    parts.push(['number', '-?\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\\b']);
    parts.push(['type', '[.#][A-Za-z_-][\\w-]*']);
  }
  if (lang === 'sh') {
    parts.push(['attr', '\\$\\{[^}\\n]*\\}|\\$[A-Za-z_@#?*!$0-9][\\w]*']);
    parts.push(['meta', '(?:^|(?<=\\s))--?[A-Za-z][\\w-]*']);
  }
  if (lang === 'py' || lang === 'java' || lang === 'swift' || lang === 'ts' || lang === 'js') parts.push(['meta', '@[A-Za-z_][\\w.]*']);
  if (lang === 'rust') parts.push(['meta', '#!?\\[[^\\]\\n]*\\]']);
  if (lang === 'c') parts.push(['meta', '^\\s*#\\s*\\w+']);
  if (lang !== 'xml' && lang !== 'css') parts.push(['number', '\\b(?:0x[0-9a-fA-F_]+|0b[01_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)[a-zA-Z]{0,3}\\b']);
  if (lang !== 'xml') parts.push(['word', '[A-Za-z_$][\\w$]*']);
  const re = new RegExp(parts.map(([, p]) => `(${p})`).join('|'), 'gm');
  return { re, kinds: parts.map(([k]) => k) };
}

const LEXERS = new Map();

function classifyWord(w, lang, src, end) {
  const kws = KWSETS[lang];
  const lower = lang === 'sql' ? w.toLowerCase() : w;
  if (kws && kws.has(lower)) return 'keyword';
  if (LITSET.has(w) || (lang === 'sql' && (lower === 'true' || lower === 'false' || lower === 'null'))) return 'literal';
  // 后面紧跟 ( 视为函数调用 / 定义
  if (/^\s*\(/.test(src.slice(end, end + 8))) return 'func';
  // 首字母大写：类型（sh/sql 不算）
  if (!['sh', 'sql'].includes(lang) && /^[A-Z][a-z0-9]/.test(w)) return 'type';
  return 'plain';
}

function lineBased(code, lang) {
  // json / yaml / ini / diff：按行处理
  const out = [];
  const lines = code.split(/(\n)/);
  for (const ln of lines) {
    if (ln === '\n' || ln === '') { if (ln) out.push(['plain', ln]); continue; }
    if (lang === 'diff') {
      const k = /^(\+\+\+|---)/.test(ln) ? 'meta' : ln[0] === '+' ? 'add' : ln[0] === '-' ? 'del' : ln.startsWith('@@') ? 'meta' : 'plain';
      out.push([k, ln]);
      continue;
    }
    if (lang === 'json') {
      const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|(\/\/.*)/g;
      let last = 0;
      let m;
      while ((m = re.exec(ln))) {
        if (m.index > last) out.push(['plain', ln.slice(last, m.index)]);
        if (m[1]) { out.push([m[2] ? 'attr' : 'string', m[1]]); if (m[2]) out.push(['plain', m[2]]); }
        else if (m[3]) out.push(['number', m[3]]);
        else if (m[4]) out.push(['literal', m[4]]);
        else out.push(['comment', m[5]]);
        last = re.lastIndex;
      }
      if (last < ln.length) out.push(['plain', ln.slice(last)]);
      continue;
    }
    // yaml / ini
    const cm = /^(\s*)([#;].*)$/.exec(ln);
    if (cm) { if (cm[1]) out.push(['plain', cm[1]]); out.push(['comment', cm[2]]); continue; }
    const sec = lang === 'ini' && /^(\s*)(\[[^\]]*\])(.*)$/.exec(ln);
    if (sec) { if (sec[1]) out.push(['plain', sec[1]]); out.push(['type', sec[2]]); if (sec[3]) out.push(['plain', sec[3]]); continue; }
    const kv = /^(\s*(?:-\s+)?)([^:=#\s][^:=#]*?)(\s*[:=])(\s*)(.*)$/.exec(ln);
    if (kv && !(lang === 'yaml' && /^\s*-\s*$/.test(ln))) {
      if (kv[1]) out.push(['plain', kv[1]]);
      out.push(['attr', kv[2]]);
      out.push(['plain', kv[3] + kv[4]]);
      if (kv[5]) out.push(...valueParts(kv[5]));
      continue;
    }
    const li = /^(\s*-\s+)(.*)$/.exec(ln);
    if (li) { out.push(['plain', li[1]]); out.push(...valueParts(li[2])); continue; }
    out.push(['plain', ln]);
  }
  return out;
}

function valueParts(v) {
  const cm = /^(.*?)(\s+#.*)$/.exec(v);
  const body = cm ? cm[1] : v;
  const parts = [];
  if (/^(["']).*\1$/.test(body)) parts.push(['string', body]);
  else if (/^-?\d+(\.\d+)?$/.test(body)) parts.push(['number', body]);
  else if (/^(true|false|null|yes|no|on|off|~)$/i.test(body)) parts.push(['literal', body]);
  else parts.push(['string', body]);
  if (cm) parts.push(['comment', cm[2]]);
  return parts;
}

/**
 * 把代码切成 [{ k: kind, t: text }]；相邻同类合并。拼回 t 必与原文完全一致。
 * 超长代码（> 60k 字符）直接返回整段 plain，避免流式时卡顿。
 */
export function highlight(code, lang) {
  const src = String(code ?? '');
  const l = normalizeLang(lang);
  if (!l || src.length > 60000) return src ? [{ k: 'plain', t: src }] : [];
  let raw;
  if (['json', 'yaml', 'ini', 'diff'].includes(l)) raw = lineBased(src, l);
  else {
    if (!LEXERS.has(l)) LEXERS.set(l, lexerFor(l));
    const { re, kinds } = LEXERS.get(l);
    re.lastIndex = 0;
    raw = [];
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      if (m[0] === '') { re.lastIndex += 1; continue; }
      if (m.index > last) raw.push(['plain', src.slice(last, m.index)]);
      let gi = 1;
      while (gi < m.length && m[gi] === undefined) gi += 1;
      let k = kinds[gi - 1];
      if (k === 'word') k = classifyWord(m[0], l, src, m.index + m[0].length);
      raw.push([k, m[0]]);
      last = m.index + m[0].length;
    }
    if (last < src.length) raw.push(['plain', src.slice(last)]);
  }
  const out = [];
  for (const [k, t] of raw) {
    if (!t) continue;
    const prev = out[out.length - 1];
    if (prev && prev.k === k) prev.t += t;
    else out.push({ k, t });
  }
  return out;
}

/** 配色：浅色参考 GitHub Light，深色参考 GitHub Dark Dimmed。plain 不着色（用正文代码色）。 */
export const HL_COLORS = {
  light: {
    comment: '#6e7781', string: '#0a3069', number: '#0550ae', keyword: '#cf222e', literal: '#0550ae',
    type: '#953800', func: '#8250df', attr: '#0550ae', tag: '#116329', meta: '#8250df', add: '#116329', del: '#82071e',
  },
  dark: {
    comment: '#768390', string: '#96d0ff', number: '#6cb6ff', keyword: '#f47067', literal: '#6cb6ff',
    type: '#f69d50', func: '#dcbdfb', attr: '#6cb6ff', tag: '#8ddb8c', meta: '#dcbdfb', add: '#8ddb8c', del: '#ff938a',
  },
};
