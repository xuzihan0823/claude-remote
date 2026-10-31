// 链接识别与「一键直达」：web 与 iOS 共用。
// - 纯文本（用户气泡、工具结果、思考过程）切成 文本/链接 片段
// - 替换 marked 的 GFM url 分词：原版遇到中文会把「，然后…」「。」「）」一并吞进链接
// - 本机地址（localhost / 127.0.0.1 …）在手机上打不开，改写成当前连接的 Mac 主机

// 链接主体：遇空白、尖括号、引号、反引号、全角标点/中日韩文字即止
const STOP = "\\s<>\"'`\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
const URL_SRC = `(?:https?:\\/\\/|www\\.)[^${STOP}]+`;
const URL_RE = new RegExp(URL_SRC, 'gi');
const URL_HEAD_RE = new RegExp(`^${URL_SRC}`, 'i');

const TRAIL_PUNCT = /[.,;:!?'"*_~]$/;
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/** 去掉句末标点；右括号仅在不配对时去掉（保留 wiki/Foo_(bar) 这类）。 */
export function trimUrl(url) {
  let u = url;
  for (;;) {
    const last = u.slice(-1);
    if (TRAIL_PUNCT.test(last)) { u = u.slice(0, -1); continue; }
    const open = CLOSERS[last];
    if (open) {
      const opens = u.split(open).length - 1;
      const closes = u.split(last).length - 1;
      if (closes > opens) { u = u.slice(0, -1); continue; }
    }
    return u;
  }
}

const hrefOf = (raw) => (/^www\./i.test(raw) ? `http://${raw}` : raw);

/** 纯文本切片：[{ text }, { text, href }, …]。无链接时返回单个文本片段。 */
export function splitLinks(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  for (let m; (m = URL_RE.exec(s));) {
    const raw = trimUrl(m[0]);
    if (raw.replace(/^(?:https?:\/\/|www\.)/i, '').length < 3) continue;
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ text: raw, href: hrefOf(raw) });
    last = m.index + raw.length;
    URL_RE.lastIndex = last;
  }
  if (last < s.length || out.length === 0) out.push({ text: s.slice(last) });
  return out;
}

/** 整段就是一个链接（如 `http://localhost:3000` 写在反引号里）时返回 href。 */
export function wholeUrl(text) {
  const s = String(text ?? '').trim();
  if (!/^(?:https?:\/\/|www\.)\S+$/i.test(s)) return null;
  const segs = splitLinks(s);
  return segs.length === 1 && segs[0].href ? segs[0].href : null;
}

const LINE_SUFFIX = /(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

function decodePath(path) {
  try { return decodeURIComponent(path); } catch { return path; }
}

/**
 * 把链接地址识别成本机文件路径，不是文件时返回 null。
 * 相对路径必须带扩展名，交给 daemon 按会话工作目录解析；末尾的 :行号 和 #L行号 会去掉。
 */
export function localFilePath(href) {
  const s = String(href ?? '').trim().replace(/^<(.*)>$/, '$1');
  if (!s || /[\0\r\n]/.test(s)) return null;
  const fileUrl = /^file:\/\/(?:localhost)?(\/[^?#]*)/i.exec(s);
  if (fileUrl) return decodePath(fileUrl[1]);
  const path = decodePath(s.replace(LINE_SUFFIX, ''));
  if (path.startsWith('//')) return null;
  if (path.startsWith('/')) return path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || /^(?:www\.|~|#|\?)/i.test(path)) return null;
  return HAS_EXTENSION.test(path) ? path.replace(/^(?:\.\/)+/, '') : null;
}

/** 反引号里只有整段是带扩展名的绝对路径才算文件，避免 `/api/sessions` 这类内容被当成链接。 */
export function codeFilePath(text) {
  const path = localFilePath(text);
  return path?.startsWith('/') && HAS_EXTENSION.test(path) ? path : null;
}

/** 从 marked 的 token 树里取出文件路径，按出现顺序去重。代码块里的路径不算。 */
export function collectFilePaths(marked, tokens) {
  const paths = new Set();
  marked.walkTokens(tokens, (tok) => {
    const path = tok.type === 'link' || tok.type === 'image' ? localFilePath(tok.href)
      : tok.type === 'codespan' ? codeFilePath(tok.text) : null;
    if (path) paths.add(path);
  });
  return [...paths];
}

/** 给 marked 换上中文友好的 url 分词器（全局一次，两端各自调用）。 */
let installed = false;
export function installLinkify(marked) {
  if (installed) return;
  installed = true;
  marked.use({
    tokenizer: {
      url(src) {
        const m = URL_HEAD_RE.exec(src);
        if (!m) return false; // 交回原版（含邮箱识别）
        const raw = trimUrl(m[0]);
        if (raw.length < 8) return false;
        return { type: 'link', raw, text: raw, href: hrefOf(raw), tokens: [{ type: 'text', raw, text: raw }] };
      },
    },
  });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * 把本机地址改写到 daemon 所在主机：Claude 说的 localhost:3000 指的是 Mac，
 * 在手机上直接打开会落到手机自己。daemonBase 是当前连接地址（如 http://192.168.1.8:7860）。
 */
export function resolveHref(href, daemonBase) {
  let u;
  try { u = new URL(href); } catch { return href; }
  if (!/^https?:$/.test(u.protocol)) return href;
  const host = u.hostname.toLowerCase();
  if (!LOOPBACK.has(host) && !host.endsWith('.localhost')) return href;
  let d;
  try { d = new URL(daemonBase); } catch { return href; }
  if (LOOPBACK.has(d.hostname.toLowerCase())) return href; // 本身就在 Mac 上访问，无需改写
  u.hostname = d.hostname;
  return u.toString();
}

/** 只放行 http(s)/mailto/tel，其余（javascript: 等）一律拒绝。 */
export function isSafeHref(href) {
  return /^(?:https?:|mailto:|tel:)/i.test(String(href ?? '').trim());
}
