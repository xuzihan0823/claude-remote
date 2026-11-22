// 端到端加密协议（E2EE v1）。纯协议定义，不含任何加密运算：
// daemon 用 node:crypto 实现，iOS 闭源端按本文件规格用 Swift 独立实现。
//
// 设计参考 Orca mobile-e2ee/v2，协议标签与 transport 上下文改为 claude-remote。
// 密码学原语：X25519 密钥协商、HKDF-SHA256 密钥派生、ChaCha20-Poly1305 AEAD。
// nonce 长 12 字节（ChaCha20-Poly1305 要求），确定性构造，无需每帧 RNG。

export const E2EE_PROTOCOL = "claude-remote-e2ee";
export const E2EE_TRANSCRIPT_DOMAIN = "claude-remote-e2ee/v1/transcript";
export const E2EE_SALT_LABEL = "claude-remote-e2ee/v1/salt";
export const E2EE_INFO_LABEL = "claude-remote-e2ee/v1/session";

export type E2eeTransport = "direct" | "relay";
export type E2eePayloadKind = "text" | "binary";
export type E2eeDirection = "mobile-to-desktop" | "desktop-to-mobile";

export const KEY_LENGTH = 32;
export const NONCE_LENGTH = 12;
export const SESSION_ID_LENGTH = 32;
export const HEADER_LENGTH = SESSION_ID_LENGTH + 1 + 1 + 8;
export const FRAME_VERSION = 1;
export const TAG_LENGTH = 16;
/** 单条 E2EE 帧密文上限，留 AEAD 开销与 header。relay 单 WS 消息上限默认 25 MiB。 */
export const MAX_FRAME_PLAINTEXT = 24 * 1024 * 1024;

export interface E2eeKeyPair {
  /** base64（标准 base64，非 urlsafe），X25519 私钥 32 字节编码。 */
  privateKeyB64: string;
  publicKeyB64: string;
}

export interface E2eeKeySchedule {
  mobileToDesktopKey: Uint8Array;
  desktopToMobileKey: Uint8Array;
  sessionId: Uint8Array;
  transcriptHash: Uint8Array;
}

export interface E2eeContext {
  protocol: typeof E2EE_PROTOCOL;
  initiator: "mobile";
  responder: "desktop";
  transport: E2eeTransport;
  relayHostId?: string;
}

export interface E2eeHello {
  type: "cr_e2ee_hello";
  v: 1;
  clientPublicKeyB64: string;
  clientNonceB64: string;
  capabilities: { framing: [1]; payloadKinds: ["text", "binary"] };
  context: E2eeContext;
}

export interface E2eeReady {
  type: "cr_e2ee_ready";
  v: 1;
  desktopPublicKeyB64: string;
  clientNonceB64: string;
  desktopNonceB64: string;
  selection: { framing: 1; payloadKinds: ["text", "binary"] };
  context: E2eeContext;
}

export interface E2eeHandshake {
  hello: E2eeHello;
  ready: E2eeReady;
  clientPublicKey: Uint8Array;
  desktopPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  desktopNonce: Uint8Array;
}

/** Nonce 12 字节：version(1)|direction(1)|kind(1)|reserved(1)|counter_BE(8)。
 * 每个会话密钥配合确定性 nonce 保证唯一，counter 单调递增防重放。 */
export function encodeE2eeNonce(args: {
  direction: E2eeDirection;
  payloadKind: E2eePayloadKind;
  counter: bigint;
}): Uint8Array {
  const nonce = new Uint8Array(NONCE_LENGTH);
  nonce[0] = FRAME_VERSION;
  nonce[1] = args.direction === "mobile-to-desktop" ? 0 : 1;
  nonce[2] = args.payloadKind === "text" ? 0 : 1;
  nonce[3] = 0; // reserved
  const dv = new DataView(nonce.buffer, 4, 8);
  dv.setBigUint64(0, args.counter, false); // big-endian
  return nonce;
}

/** AEAD 附加数据 = sessionId(32) | direction(1) | kind(1) | counter_BE(8) = 42 bytes。
 * header 明文包含在 AAD 而非密文，relay 只转不看，iOS/daemon 双方解密时验证。 */
export function encodeE2eeHeader(args: {
  sessionId: Uint8Array;
  direction: E2eeDirection;
  payloadKind: E2eePayloadKind;
  counter: bigint;
}): Uint8Array {
  if (args.sessionId.length !== SESSION_ID_LENGTH) {
    throw new Error(`Invalid sessionId length: ${args.sessionId.length}`);
  }
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(args.sessionId, 0);
  header[SESSION_ID_LENGTH] = args.direction === "mobile-to-desktop" ? 0 : 1;
  header[SESSION_ID_LENGTH + 1] = args.payloadKind === "text" ? 0 : 1;
  const dv = new DataView(header.buffer, SESSION_ID_LENGTH + 2, 8);
  dv.setBigUint64(0, args.counter, false);
  return header;
}

/** 转录 = TLV 列表，每字段 [uint32 name_len][utf8 name][uint32 value_len][value]。
 * domain 字段绑定协议标签，防止跨协议复用密钥。 */
export function encodeE2eeTranscript(hs: E2eeHandshake): Uint8Array {
  const enc = new TextEncoder();
  const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
  const utf8 = (s: string) => enc.encode(s);
  const field = (name: string, value: Uint8Array): Uint8Array => {
    const n = utf8(name);
    return concat([u32(n.length), n, u32(value.length), value]);
  };
  const { hello: h, ready: r } = hs;
  const fields: Uint8Array[] = [
    field("domain", utf8(E2EE_TRANSCRIPT_DOMAIN)),
    field("hello.type", utf8(h.type)),
    field("hello.version", u32(h.v)),
    field("hello.client-public-key", hs.clientPublicKey),
    field("hello.client-nonce", hs.clientNonce),
    field("hello.context.protocol", utf8(h.context.protocol)),
    field("hello.context.transport", utf8(h.context.transport)),
    field("hello.context.relay-host-id", utf8(h.context.relayHostId ?? "")),
    field("ready.type", utf8(r.type)),
    field("ready.version", u32(r.v)),
    field("ready.desktop-public-key", hs.desktopPublicKey),
    field("ready.client-nonce-echo", hs.clientNonce),
    field("ready.desktop-nonce", hs.desktopNonce),
    field("ready.context.protocol", utf8(r.context.protocol)),
    field("ready.context.transport", utf8(r.context.transport)),
    field("ready.context.relay-host-id", utf8(r.context.relayHostId ?? "")),
  ];
  return concat(fields);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** 解析并校验 cr_e2ee_hello 消息。 */
export function parseE2eeHello(raw: unknown): E2eeHello | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m["type"] !== "cr_e2ee_hello" || m["v"] !== 1) return null;
  if (typeof m["clientPublicKeyB64"] !== "string") return null;
  if (typeof m["clientNonceB64"] !== "string") return null;
  const ctx = m["context"];
  if (!isValidContext(ctx)) return null;
  const cap = m["capabilities"];
  if (typeof cap !== "object" || cap === null) return null;
  const c = cap as Record<string, unknown>;
  if (!Array.isArray(c["framing"]) || c["framing"].length !== 1 || c["framing"][0] !== 1) return null;
  if (!Array.isArray(c["payloadKinds"]) || c["payloadKinds"].join(",") !== "text,binary") return null;
  return raw as E2eeHello;
}

function isValidContext(ctx: unknown): ctx is E2eeContext {
  if (typeof ctx !== "object" || ctx === null) return false;
  const c = ctx as Record<string, unknown>;
  return (
    c["protocol"] === E2EE_PROTOCOL &&
    c["initiator"] === "mobile" &&
    c["responder"] === "desktop" &&
    (c["transport"] === "direct" || c["transport"] === "relay") &&
    (c["relayHostId"] === undefined || typeof c["relayHostId"] === "string")
  );
}
