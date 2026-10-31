// TeX → SVG 字符串（MathJax 3，纯 JS，无原生依赖），交给 react-native-svg 的 SvgXml 显示。
// 只装常用 TeX 包：不带 require/autoload（要动态加载）和 bussproofs 等少见包，控制包体与初始化耗时。
// 首次渲染公式时才 require MathJax，避免启动时阻塞 JS 线程；结果按 (tex, display) 缓存。

const PACKAGES = ['base', 'ams', 'newcommand', 'boldsymbol', 'mathtools', 'cancel', 'color', 'braket', 'physics', 'noundefined'];

let doc = null;
let adaptor = null;
function init() {
  if (doc) return;
  const { mathjax } = require('mathjax-full/js/mathjax.js');
  const { TeX } = require('mathjax-full/js/input/tex.js');
  const { SVG } = require('mathjax-full/js/output/svg.js');
  const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
  const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
  require('mathjax-full/js/input/tex/base/BaseConfiguration.js');
  require('mathjax-full/js/input/tex/ams/AmsConfiguration.js');
  require('mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js');
  require('mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js');
  require('mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js');
  require('mathjax-full/js/input/tex/cancel/CancelConfiguration.js');
  require('mathjax-full/js/input/tex/color/ColorConfiguration.js');
  require('mathjax-full/js/input/tex/braket/BraketConfiguration.js');
  require('mathjax-full/js/input/tex/physics/PhysicsConfiguration.js');
  require('mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js');

  adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  doc = mathjax.document('', {
    InputJax: new TeX({ packages: PACKAGES, formatError: (_jax, err) => { throw err; } }),
    // fontCache:none → 每个公式自带路径，不依赖全局 <defs>，SvgXml 单独渲染才正确
    OutputJax: new SVG({ fontCache: 'none' }),
  });
}

const cache = new Map();
const CACHE_MAX = 300;

/**
 * @returns {{ xml: string, widthEx: number, heightEx: number, valignEx: number } | { error: string }}
 */
export function texToSvg(tex, display = false) {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let out;
  try {
    init();
    const node = doc.convert(String(tex), { display });
    const svg = adaptor.firstChild(node);
    const num = (v) => parseFloat(String(v || '0')) || 0;
    const style = adaptor.getAttribute(svg, 'style') || '';
    const va = /vertical-align:\s*(-?[\d.]+)ex/.exec(style);
    out = {
      xml: adaptor.outerHTML(svg),
      widthEx: num(adaptor.getAttribute(svg, 'width')),
      heightEx: num(adaptor.getAttribute(svg, 'height')),
      valignEx: va ? parseFloat(va[1]) : 0,
    };
  } catch (e) {
    out = { error: String(e?.message || e) };
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}

/** 1ex 对应的 px（MathJax 字体 x-height ≈ 0.442em）。 */
export const exToPx = (ex, fontSize) => ex * fontSize * 0.442;
