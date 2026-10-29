// 旧 dev client 可能没有编入原生模块，加载失败时保持可用。
import { AppState, Platform } from 'react-native';
import { getPref } from './prefs.js';

let H = null;
try {
  // eslint-disable-next-line global-require
  H = require('expo-haptics');
} catch {
  H = null;
}

let lastAttention = -Infinity;

function safe(fn) {
  if (!H || getPref('haptics') === false || AppState.currentState !== 'active') return;
  try {
    const p = fn(H);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* 设备不支持时静默降级 */ }
}

function play(androidEffect, fallback) {
  safe((h) => {
    if (Platform.OS === 'android' && h.performAndroidHapticsAsync && h.AndroidHaptics?.[androidEffect]) {
      return h.performAndroidHapticsAsync(h.AndroidHaptics[androidEffect]);
    }
    return fallback(h);
  });
}

export const haptics = {
  attention: () => safe((h) => {
    const now = Date.now();
    if (now - lastAttention < 1000) return;
    lastAttention = now;
    if (Platform.OS === 'android' && h.performAndroidHapticsAsync && h.AndroidHaptics?.Long_Press) {
      return h.performAndroidHapticsAsync(h.AndroidHaptics.Long_Press);
    }
    return h.notificationAsync(h.NotificationFeedbackType.Warning);
  }),
  success: () => play('Confirm', (h) => h.notificationAsync(h.NotificationFeedbackType.Success)),
  confirm: () => play('Confirm', (h) => h.impactAsync(h.ImpactFeedbackStyle.Light)),
  stop: () => play('Gesture_End', (h) => h.impactAsync(h.ImpactFeedbackStyle.Medium)),
  tap: () => play('Virtual_Key', (h) => h.impactAsync(h.ImpactFeedbackStyle.Light)),
  selection: () => play('Segment_Tick', (h) => h.selectionAsync()),
  error: () => play('Reject', (h) => h.notificationAsync(h.NotificationFeedbackType.Error)),
};
