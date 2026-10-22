// 手机端本地偏好（MMKV 背后的 localStorage）。改动经 bus 'prefs' 广播，usePref 订阅后即时生效。
import { useEffect, useState } from 'react';
import { Appearance } from 'react-native';
import { bus } from '../../../web/core/bus.js';
import { createPrefsStore } from './prefs-store.js';

export {
  APPEARANCE_LABELS, DEFAULT_PREFS, FONT_SCALE_LABELS, FONT_SCALES, fontScaleLabel,
} from './prefs-store.js';

/** 主题覆盖：RN 的 Appearance.setColorScheme 会让 useColorScheme 返回覆盖值，全局生效。 */
export function applyAppearance(v = store.get('appearance')) {
  try { Appearance.setColorScheme(v === 'light' || v === 'dark' ? v : 'unspecified'); }
  catch { /* 老版本 RN 无此 API */ }
}

const store = createPrefsStore({
  onChange(next, name) {
    if (name === 'appearance') applyAppearance(next.appearance);
    bus.emit('prefs', next);
  },
});

export const getPref = (name) => store.get(name);
export const setPref = (name, value) => { store.set(name, value); };

export function usePref(name) {
  const [v, setV] = useState(() => store.get(name));
  useEffect(() => {
    const off = bus.on('prefs', (p) => setV(p[name]));
    setV(store.get(name));
    return () => { off(); };
  }, [name]);
  return v;
}
