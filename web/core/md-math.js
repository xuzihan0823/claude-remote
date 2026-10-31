// marked 扩展：识别 LaTeX 公式，产出 { type: 'math', display, text } token。web 与 RN 共用。
//   块级：$$…$$、\[…\]（可跨行）
//   行内：$…$、\(…\)
// 行内 $ 按 pandoc 规则防误伤金额："$5 和 $10" 不算公式——开头 $ 后不能是空白，
// 结尾 $ 前不能是空白、后面不能紧跟数字；$$ 不当行内。
// marked 的扩展是全局注册在实例上的，所以 installMath(marked) 只装一次。

const BLOCK_RE = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;
const INLINE_RE = /^(?:\$(?!\$)((?:\\.|[^\\$\n])+?)\$(?!\d)|\\\(((?:\\.|[^\n])+?)\\\))/;

export const mathBlock = {
  name: 'math',
  level: 'block',
  start(src) {
    const m = /\$\$|\\\[/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = BLOCK_RE.exec(src);
    if (!m) return undefined;
    const text = (m[1] ?? m[2]).trim();
    if (!text) return undefined;
    return { type: 'math', raw: m[0], text, display: true };
  },
};

export const mathInline = {
  name: 'mathInline',
  level: 'inline',
  start(src) {
    const m = /\$|\\\(/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = INLINE_RE.exec(src);
    if (!m) return undefined;
    if (m[1] != null && (/^\s/.test(m[1]) || /\s$/.test(m[1]))) return undefined;
    return { type: 'math', raw: m[0], text: (m[1] ?? m[2]).trim(), display: false };
  },
};

const installed = new WeakSet();
/** 给 marked 实例装上公式扩展（幂等）。renderer 可选：web 传 KaTeX 渲染函数。 */
export function installMath(marked, { renderer } = {}) {
  if (installed.has(marked)) return;
  installed.add(marked);
  const withRender = (ext) => (renderer ? { ...ext, renderer: (tok) => renderer(tok) } : ext);
  marked.use({ extensions: [withRender(mathBlock), withRender(mathInline)] });
}
