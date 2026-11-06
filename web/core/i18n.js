// 极简 i18n：以中文文案作为词条 key，t() 在调用时查当前语言的词典。
// 词典缺失的词条原样返回中文，保证漏翻时界面依然可读；新增语言只需加一份词典文件。
import { en as enComponents } from './locales/en/components.js';
import { en as enComposer } from './locales/en/composer.js';
import { en as enCore } from './locales/en/core.js';
import { en as enChat } from './locales/en/chat.js';
import { en as enHome } from './locales/en/home.js';
import { en as enMisc } from './locales/en/misc.js';
import { en as enSettings } from './locales/en/settings.js';

const DICTS = {
  en: { ...enComponents, ...enComposer, ...enCore, ...enChat, ...enHome, ...enMisc, ...enSettings },
};

export const SUPPORTED_LOCALES = ['zh', 'en'];
const DEFAULT_LOCALE = 'zh';

let locale = DEFAULT_LOCALE;

export const getLocale = () => locale;

export function setLocale(next) {
  locale = next === 'en' ? 'en' : DEFAULT_LOCALE;
}

/** 系统语言：zh* 视为中文，其余英文；Intl 不可用时回落默认语言。 */
export function detectSystemLocale() {
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale || '';
    return /^zh/i.test(tag) ? 'zh' : 'en';
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** 偏好值（system | zh | en）→ 实际语言。 */
export function resolveLocale(pref) {
  return pref === 'zh' || pref === 'en' ? pref : detectSystemLocale();
}

/** 参数占位符写法：t('{n} 分钟后重试', { n: 5 })。 */
export function t(text, params) {
  if (typeof text !== 'string') return text;
  const dict = DICTS[locale];
  let out = (dict && dict[text] != null) ? dict[text] : text;
  if (params) {
    out = out.replace(/\{(\w+)\}/g, (m, key) => (params[key] == null ? m : String(params[key])));
  }
  return out;
}
