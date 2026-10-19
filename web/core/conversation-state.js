const MAX_STREAM_TEXT = 32768;
export const ATTACHMENT_NOTE_PREFIX = '\n\n[手机端上传的附件';

const cmpOfficial = (a, b) => (a.seq - b.seq) || ((a.blockIndex ?? 0) - (b.blockIndex ?? 0));

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

export function displayKey(m) {
  if (m.role === 'user' && m.kind === 'text') {
    const uuid = m.uuid ?? m.clientMessageId;
    if (uuid != null) return `u:${uuid}`;
  }
  return `s:${m.seq}:${m.blockIndex ?? 0}`;
}

export function createConversationState() {
  const official = [];
  const locals = [];
  const streams = new Map();
  let gap = false;
  let hasMore = false;

  const localIndex = (clientMessageId) => locals.findIndex((l) => l.clientMessageId === clientMessageId);
  const officialIndex = (key) => official.findIndex((m) => displayKey(m) === key);
  const streamKey = (runId, messageId, blockIndex) => `${runId}:${messageId}:${blockIndex}`;

  function removeLocal(clientMessageId) {
    const i = localIndex(clientMessageId);
    if (i >= 0) locals.splice(i, 1);
  }

  function confirmLocal(official) {
    if (official.role !== 'user' || official.kind !== 'text') return;
    const uuid = official.uuid ?? official.clientMessageId;
    if (uuid != null) {
      const i = localIndex(uuid);
      if (i >= 0) { locals.splice(i, 1); return; }
    }
    const text = String(official.text ?? '').trim();
    const i = locals.findIndex((l) => {
      if (l.status === 'confirmed') return false;
      const localText = String(l.text ?? '').trim();
      if (localText === text) return true;
      if (localText === '') return false;
      const annotated = `${localText}${ATTACHMENT_NOTE_PREFIX}`;
      return text.startsWith(annotated);
    });
    if (i >= 0) locals.splice(i, 1);
  }

  function reset() {
    official.length = 0;
    locals.length = 0;
    streams.clear();
    gap = false;
    hasMore = false;
  }

  function items() {
    return [...official].sort(cmpOfficial).concat(locals, [...streams.values()]);
  }

  function applySnapshot({ messages = [], firstSeq = null, hasMore: more = false } = {}) {
    const window = firstSeq == null ? messages : messages.filter((m) => m.seq >= firstSeq);
    const previousMax = official.reduce((max, m) => (m.seq > max ? m.seq : max), -Infinity);
    const older = firstSeq == null ? [] : official.filter((m) => m.seq < firstSeq);
    const touches = older.length === 0 || previousMax + 1 >= firstSeq;

    const merged = older.slice();
    for (const m of window) {
      const i = merged.findIndex((x) => displayKey(x) === displayKey(m));
      if (i >= 0) merged[i] = m;
      else merged.push(m);
    }
    merged.sort(cmpOfficial);
    official.length = 0;
    official.push(...merged);

    const officialApiIds = new Set(
      merged.filter((m) => m.apiMessageId != null).map((m) => m.apiMessageId),
    );
    for (const [key, item] of streams) {
      if (officialApiIds.has(item.messageId)) streams.delete(key);
    }

    gap = !touches;
    hasMore = more;
    for (const m of window) confirmLocal(m);
    for (let i = locals.length - 1; i >= 0; i--) {
      if (locals[i].status === 'confirmed') locals.splice(i, 1);
    }
  }

  function upsertOfficial(m) {
    const key = displayKey(m);
    const i = officialIndex(key);
    if (i >= 0) official[i] = m;
    else official.push(m);
    official.sort(cmpOfficial);

    confirmLocal(m);
    if (m.apiMessageId != null) {
      for (const [key2, item] of streams) {
        if (item.messageId === m.apiMessageId) streams.delete(key2);
      }
    }
  }

  function addLocal(text, clientMessageId) {
    const id = typeof clientMessageId === 'string' && clientMessageId !== '' ? clientMessageId : newClientMessageId();
    const item = {
      clientMessageId: id,
      uuid: id,
      role: 'user',
      kind: 'text',
      text,
      status: 'sending',
    };
    locals.push(item);
    return item;
  }

  function markAccepted(clientMessageId, runId) {
    const item = locals[localIndex(clientMessageId)];
    if (!item) return null;
    item.status = 'accepted';
    if (runId != null) item.runId = runId;
    return item;
  }

  function markFailed(clientMessageId, { definite = false } = {}) {
    const item = locals[localIndex(clientMessageId)];
    if (!item) return null;
    item.status = definite ? 'failed' : 'unconfirmed';
    return item;
  }

  function markUnconfirmed(clientMessageId) {
    const item = locals[localIndex(clientMessageId)];
    if (!item) return null;
    item.status = 'unconfirmed';
    return item;
  }

  function applyStream({ runId, messageId, blockIndex, text }) {
    const key = streamKey(runId, messageId, blockIndex);
    let item = streams.get(key);
    if (!item) {
      item = { key: `stream:${key}`, runId, messageId, blockIndex, role: 'assistant', kind: 'text', text: '' };
      streams.set(key, item);
    }
    item.text = (item.text + (text ?? '')).slice(0, MAX_STREAM_TEXT);
    return item;
  }

  function applyStreamSnapshot({ runId, blocks = [] }) {
    clearStream(runId);
    for (const b of blocks) {
      const key = streamKey(runId, b.messageId, b.blockIndex);
      streams.set(key, {
        key: `stream:${key}`,
        runId,
        messageId: b.messageId,
        blockIndex: b.blockIndex,
        role: 'assistant',
        kind: 'text',
        text: String(b.text ?? '').slice(0, MAX_STREAM_TEXT),
      });
    }
  }

  function clearStream(runId) {
    for (const [key, item] of streams) {
      if (item.runId === runId) streams.delete(key);
    }
  }

  function pendingLocals() {
    return locals.filter((l) => l.status !== 'confirmed');
  }

  return {
    reset,
    items,
    applySnapshot,
    upsertOfficial,
    addLocal,
    markAccepted,
    markFailed,
    markUnconfirmed,
    applyStream,
    applyStreamSnapshot,
    clearStream,
    pendingLocals,
    hasGap: () => gap,
    hasMore: () => hasMore,
  };
}
