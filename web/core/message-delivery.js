export function newClientMessageId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isMessageEcho(message, pending) {
  if (message.role !== 'user' || message.kind !== 'text') return false;
  if (pending.clientMessageId && message.uuid === pending.clientMessageId) return true;
  if (pending.clientMessageId && pending.precise !== false) return false;
  return message.text?.trim() === (pending.match ?? pending.text).trim();
}

export function reconcilePending(pending, messages) {
  const used = new Set();
  return pending.filter((item) => {
    const candidates = messages.filter((m) => !used.has(m) && (m.seq > (item.floorSeq ?? 0)));
    const echo = candidates.find((m) => m.uuid === item.clientMessageId && isMessageEcho(m, item))
      ?? candidates.find((m) => isMessageEcho(m, item));
    if (echo) used.add(echo);
    return !echo;
  });
}

export function sendFailureState(error, posted) {
  return posted && (!error.status || error.status >= 500) ? 'unconfirmed' : 'failed';
}
