// 手机端本地偏好（MMKV 背后的 localStorage）。改动经 bus 'prefs' 广播，usePref 订阅后即时生效。
import { useEffect, useState } from 'react';
import { Appearance } from 'react-native';
import { bus } from '../../../web/core/bus.js';

const KEY = 'app_prefs';

export const DEFAULT_PREFS = {
  appearance: 'system', // system | light | dark
  fontScale: 1, // FONT_SCALES 之一
  haptics: true,
  codeWrap: false,
  showThinking: true,
  toolsExpanded: false,
  defaultModel: '', // 新对话默认模型；'' = 跟随 Mac
};

export const FONT_SCALES = [0.88, 0.94, 1, 1.08, 1.16];
export const FONT_SCALE_LABELS = ['较小', '小', '标准', '大', '较大'];
export const fontScaleLabel = (v) => FONT_SCALE_LABELS[FONT_SCALES.indexOf(v)] ?? '标准';
export const APPEARANCE_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { cache = { ...DEFAULT_PREFS }; }
  if (!FONT_SCALES.includes(cache.fontScale)) cache.fontScale = 1;
  return cache;
}

export function getPref(name) { return load()[name]; }

export function setPref(name, value) {
  const next = { ...load(), [name]: value };
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 仅放弃持久化 */ }
  if (name === 'appearance') applyAppearance(value);
  bus.emit('prefs', next);
}

/** 主题覆盖：RN 的 Appearance.setColorScheme 会让 useColorScheme 返回覆盖值，全局生效。 */
export function applyAppearance(v = getPref('appearance')) {
  try { Appearance.setColorScheme(v === 'light' || v === 'dark' ? v : 'unspecified'); }
  catch { /* 老版本 RN 无此 API */ }
}

export function usePref(name) {
  const [v, setV] = useState(() => getPref(name));
  useEffect(() => {
    const off = bus.on('prefs', (p) => setV(p[name]));
    setV(getPref(name));
    return off;
  }, [name]);
  return v;
}
