// App 侧 i18n：系统语言解析 + React 订阅。web/core 的 t() 只负责查表，
// 组件用 useI18n() 才能在切换语言后重绘（偏好变化经 bus 'prefs' 广播）。
import { useEffect, useState } from 'react';
import { bus } from '../../../web/core/bus.js';
import { detectSystemLocale, getLocale, resolveLocale, setLocale, t } from '../../../web/core/i18n.js';

export { detectSystemLocale, getLocale, resolveLocale, t };

export function applyLocale(pref) {
  setLocale(resolveLocale(pref));
}

/** 返回 { t, locale }；t 是稳定函数，可直接放进依赖数组。 */
export function useI18n() {
  const [, tick] = useState(0);
  useEffect(() => bus.on('prefs', () => tick((n) => n + 1)), []);
  return { t, locale: getLocale() };
}
