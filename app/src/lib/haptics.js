// 触感反馈。expo-haptics 是原生模块：旧的 dev client 没编进来时 require 会抛，这里吞掉降级为 no-op，
// 避免 JS 先更新、原生还没重编时整个 App 起不来。
import { getPref } from './prefs.js';

let H = null;
try {
  // eslint-disable-next-line global-require
  H = require('expo-haptics');
} catch {
  H = null;
}

function safe(fn) {
  if (!H || getPref('haptics') === false) return;
  try {
    const p = fn(H);
    if (p && typeof p.catch === 'function') p.catch(() => { /* 设备不支持 */ });
  } catch { /* noop */ }
}

export const haptics = {
  /** 新审批到达：提醒你看一眼 */
  attention: () => safe((h) => h.notificationAsync(h.NotificationFeedbackType.Warning)),
  /** 允许 / 作答 / 发送成功 */
  success: () => safe((h) => h.notificationAsync(h.NotificationFeedbackType.Success)),
  /** 拒绝、停止运行 */
  reject: () => safe((h) => h.impactAsync(h.ImpactFeedbackStyle.Medium)),
  /** 轻触：发送消息 */
  tap: () => safe((h) => h.impactAsync(h.ImpactFeedbackStyle.Light)),
  /** 失败 */
  error: () => safe((h) => h.notificationAsync(h.NotificationFeedbackType.Error)),
};
