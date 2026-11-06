// 纯函数移植自 web/ui/utils.js（STATUS_LABEL/relTime/fmtClock/fmtBytes/cwdTail/truncate/toolSummary/msgKey/cmpMsg，逻辑原样；用户可见文案改走 t()）。
// escapeHtml / STATUS_DOT 是浏览器 CSS 专用，RN 不需要；STATUS_DOT 的配色语义改由 statusColor 映射到 theme token。
// 配色依据 web/style.css：.dot-idle -> var(--ok)、.dot-term -> var(--warn)、.dot-run -> var(--info)。

import { t } from './i18n.js';

export const STATUS_LABEL = { idle: '可接管', 'terminal-driving': '终端使用中', 'daemon-driving': '运行中' };

export function relTime(ts, nowMs = Date.now()) {
  const d = nowMs - ts;
  if (d < 60_000) return t('刚刚');
  if (d < 3600_000) return t('{n} 分钟前', { n: Math.floor(d / 60_000) });
  if (d < 86400_000) return t('{n} 小时前', { n: Math.floor(d / 3600_000) });
  if (d < 7 * 86400_000) return t('{n} 天前', { n: Math.floor(d / 86400_000) });
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}
export function fmtClock(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}
export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
export function cwdTail(cwd, segs = 2) {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts.slice(-segs).join('/');
}
export function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }
export function toolSummary(m) {
  const i = m.toolInput || {};
  return truncate(i.command || i.file_path || i.pattern || i.url || i.description || i.prompt || JSON.stringify(i), 90);
}
export const msgKey = (m) => `${m.seq}:${m.blockIndex ?? 0}`;
export const cmpMsg = (a, b) => (a.seq - b.seq) || ((a.blockIndex ?? 0) - (b.blockIndex ?? 0));

// 会话状态 -> theme token 颜色（web/style.css .dot-* 配色语义）。
// 未知 status 返回 undefined，由调用方决定回退色。
export function statusColor(colors, status) {
  if (status === 'idle') return colors.ok;
  if (status === 'terminal-driving') return colors.warn;
  if (status === 'daemon-driving') return colors.info;
  return undefined;
}
