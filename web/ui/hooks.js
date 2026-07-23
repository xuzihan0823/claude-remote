import { useCallback, useEffect, useState } from '../vendor/preact-htm-standalone.module.js';
import { bus, useBus } from '../core/bus.js';
import { fetchModels, modelCache } from '../core/api.js';

export function useVVH() {
  useEffect(() => {
    const doc = document.documentElement;
    const KB = window.Capacitor?.Plugins?.Keyboard;
    if (KB?.addListener) {
      // 壳内（Keyboard resize:none）：webview 不随键盘缩放，布局视口恒定。
      // keyboardWillShow 在系统动画开始前携带高度 → 提前写 --kb 驱动 CSS 过渡，与键盘滑动同步；
      // resize:native 的老路是动画结束后 webview 才一步缩高，composer 永远慢半拍。
      doc.style.setProperty('--vvh', '100vh');
      doc.classList.add('kb-native');
      const apply = (h) => {
        doc.style.setProperty('--kb', `${h}px`);
        doc.classList.toggle('kb-open', h > 0);
        bus.emit('kb-change', { height: h });
      };
      let subs;
      try {
        subs = [
          KB.addListener('keyboardWillShow', (info) => apply(Math.max(0, Math.round(info?.keyboardHeight ?? 0)))),
          KB.addListener('keyboardWillHide', () => apply(0)),
        ];
      } catch { subs = []; }
      return () => {
        subs.forEach((s) => Promise.resolve(s).then((h) => h?.remove?.()).catch(() => { /* noop */ }));
        doc.classList.remove('kb-native', 'kb-open');
        doc.style.setProperty('--kb', '0px');
      };
    }
    // 浏览器：沿用 visualViewport 高度跟踪
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => doc.style.setProperty('--vvh', `${vv.height}px`);
    set();
    vv.addEventListener('resize', set);
    return () => vv.removeEventListener('resize', set);
  }, []);
}

export function useModelCatalog() {
  const [catalog, setCatalog] = useState(modelCache);
  const load = useCallback(async () => {
    try { setCatalog(await fetchModels()); } catch { /* The composer remains usable with the Mac default. */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useBus('ws-open', load, [load]);
  useBus('models-cached', setCatalog, []);
  return catalog;
}
