// 偏好存储的纯逻辑（不依赖 RN，便于 node 单测）。prefs.js 在此之上接 Appearance 与 React hook。
export const PREFS_KEY = 'app_prefs';

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

const VALID = {
  appearance: (v) => ['system', 'light', 'dark'].includes(v),
  fontScale: (v) => FONT_SCALES.includes(v),
  haptics: (v) => typeof v === 'boolean',
  codeWrap: (v) => typeof v === 'boolean',
  showThinking: (v) => typeof v === 'boolean',
  toolsExpanded: (v) => typeof v === 'boolean',
  defaultModel: (v) => typeof v === 'string',
};

/** 读出的值逐项校验，坏值 / 未知项回落默认，避免旧版本或手改的数据把界面弄坏。 */
export function sanitizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_PREFS)) if (VALID[k](raw[k])) out[k] = raw[k];
  }
  return out;
}

/** onChange(next, name) 在每次 set 后调用（prefs.js 借此广播和应用主题）。 */
export function createPrefsStore({ storage = globalThis.localStorage, onChange } = {}) {
  let cache = null;
  const load = () => {
    if (cache) return cache;
    try { cache = sanitizePrefs(JSON.parse(storage.getItem(PREFS_KEY) || '{}')); }
    catch { cache = { ...DEFAULT_PREFS }; }
    return cache;
  };
  return {
    get: (name) => load()[name],
    all: () => load(),
    set(name, value) {
      if (!(name in DEFAULT_PREFS)) throw new Error(`unknown pref: ${name}`);
      if (!VALID[name](value)) return load();
      cache = { ...load(), [name]: value };
      try { storage.setItem(PREFS_KEY, JSON.stringify(cache)); } catch { /* 仅放弃持久化 */ }
      onChange?.(cache, name);
      return cache;
    },
  };
}
