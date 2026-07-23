export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const MODE_KEY = 'session_mode';

function validMode(mode) {
  return PERMISSION_MODES.includes(mode) ? mode : 'default';
}

export function getSessionMode(sessionId) {
  try { return validMode(localStorage.getItem(`${MODE_KEY}:${sessionId}`)); }
  catch { return 'default'; }
}

export function setSessionMode(sessionId, mode) {
  try { localStorage.setItem(`${MODE_KEY}:${sessionId}`, validMode(mode)); }
  catch { /* localStorage 不可用时仅放弃持久化 */ }
}

export function getNewSessionMode() {
  try { return validMode(localStorage.getItem(MODE_KEY)); }
  catch { return 'default'; }
}

export function setNewSessionMode(mode) {
  try { localStorage.setItem(MODE_KEY, validMode(mode)); }
  catch { /* localStorage 不可用时仅放弃持久化 */ }
}
