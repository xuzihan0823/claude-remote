// E2EE 服务端会话：daemon 收到 cr_e2ee_hello 后构建，派生密钥，收发加密 WS 帧。
// 仅依赖 node:crypto，无额外依赖。iOS 端按 packages/relay/src/e2ee.ts 规格独立实现。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
  type KeyObject,
} from "node:crypto";

import {
  E2EE_INFO_LABEL,
  E2EE_SALT_LABEL,
  E2EE_PROTOCOL,
  HEADER_LENGTH,
  KEY_LENGTH,
  MAX_FRAME_PLAINTEXT,
  NONCE_LENGTH,
  SESSION_ID_LENGTH,
  TAG_LENGTH,
  encodeE2eeHeader,
  encodeE2eeNonce,
  encodeE2eeTranscript,
  parseE2eeHello,
  type E2eeDirection,
  type E2eeHandshake,
  type E2eeHello,
  type E2eeKeySchedule,
  type E2eePayloadKind,
  type E2eeReady,
} from "@claude-remote/relay/e2ee";

export interface E2eeServerSessionOptions {
  /** 守护进程 X25519 私钥（cr init 生成写入 .env DAEMON_E2EE_PRIVATE_KEY，base64 标准 32 字节）。 */
  privateKeyB64: string;
  /** relay 还是 direct；写入握手 context。 */
  transport: "direct" | "relay";
  /** relay host id（经 relay 时传入）；写入握手 context。 */
  relayHostId?: string;
}

// X25519 原始 32 字节密钥的 DER 包装前缀（固定，RFC 8410）。
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // 12 字节 + 32
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex"); // 16 字节 + 32

/** 生成 X25519 密钥对，返回 base64 字符串。 */
export function generateE2eeKeyPair(): { privateKeyB64: string; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    privateKeyB64: privDer.subarray(-KEY_LENGTH).toString("base64"),
    publicKeyB64: pubDer.subarray(-KEY_LENGTH).toString("base64"),
  };
}

function importRawPublicKey(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function importRawPrivateKey(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function deriveKeySchedule(args: {
  sharedSecret: Buffer;
  transcript: Uint8Array;
  clientNonce: Uint8Array;
  desktopNonce: Uint8Array;
}): E2eeKeySchedule {
  const transcriptHash = createHash("sha256").update(args.transcript).digest();
  const saltInput = Buffer.concat([
    Buffer.from(E2EE_SALT_LABEL, "utf8"),
    Buffer.from([0]),
    Buffer.from(args.clientNonce),
    Buffer.from(args.desktopNonce),
  ]);
  const salt = createHash("sha256").update(saltInput).digest();
  const info = Buffer.concat([Buffer.from(E2EE_INFO_LABEL, "utf8"), Buffer.from([0]), transcriptHash]);
  const expanded = Buffer.from(hkdfSync("sha256", args.sharedSecret, salt, info, 96));
  return {
    mobileToDesktopKey: expanded.subarray(0, KEY_LENGTH),
    desktopToMobileKey: expanded.subarray(KEY_LENGTH, KEY_LENGTH * 2),
    sessionId: expanded.subarray(KEY_LENGTH * 2, KEY_LENGTH * 2 + SESSION_ID_LENGTH),
    transcriptHash,
  };
}

export class E2eeServerSession {
  readonly #schedule: E2eeKeySchedule;
  #inboundCounter = 0n;
  #outboundCounter = 0n;

  private constructor(schedule: E2eeKeySchedule) {
    this.#schedule = schedule;
  }

  /**
   * 处理手机端发来的 cr_e2ee_hello，返回 ready 消息与已就绪会话。
   * 校验失败（格式错、公钥/nonce 长度不对、context 不匹配）返回 null。
   */
  static acceptHello(rawHello: unknown, options: E2eeServerSessionOptions): { ready: E2eeReady; session: E2eeServerSession } | null {
    const hello = parseE2eeHello(rawHello);
    if (hello === null) return null;

    const clientPublicKey = Buffer.from(hello.clientPublicKeyB64, "base64");
    const clientNonce = Buffer.from(hello.clientNonceB64, "base64");
    const desktopPrivateKeyRaw = Buffer.from(options.privateKeyB64, "base64");
    if (clientPublicKey.length !== KEY_LENGTH || clientNonce.length !== KEY_LENGTH || desktopPrivateKeyRaw.length !== KEY_LENGTH) {
      return null;
    }

    // 用持久化私钥做 ECDH 并派生对应公钥，保证 desktop 身份固定、可被手机 pin 住。
    const desktopPriv = importRawPrivateKey(desktopPrivateKeyRaw);
    const desktopPub = createPublicKey(desktopPriv);
    const desktopPubDer = desktopPub.export({ type: "spki", format: "der" }) as Buffer;
    const desktopPublicKeyRaw = desktopPubDer.subarray(-KEY_LENGTH);
    const desktopPublicKeyB64 = desktopPublicKeyRaw.toString("base64");

    const clientPub = importRawPublicKey(clientPublicKey);
    const sharedSecret = diffieHellman({ privateKey: desktopPriv, publicKey: clientPub });
    const desktopNonce = randomBytes(KEY_LENGTH);

    const context: import("@claude-remote/relay/e2ee").E2eeContext = {
      protocol: E2EE_PROTOCOL,
      initiator: "mobile",
      responder: "desktop",
      transport: options.transport,
      ...(options.relayHostId === undefined ? {} : { relayHostId: options.relayHostId }),
    };

    const ready: E2eeReady = {
      type: "cr_e2ee_ready",
      v: 1,
      desktopPublicKeyB64: desktopPublicKeyB64,
      clientNonceB64: hello.clientNonceB64,
      desktopNonceB64: desktopNonce.toString("base64"),
      selection: { framing: 1, payloadKinds: ["text", "binary"] },
      context,
    };

    const handshake: E2eeHandshake = {
      hello,
      ready,
      clientPublicKey,
      desktopPublicKey: desktopPublicKeyRaw,
      clientNonce,
      desktopNonce,
    };

    const transcript = encodeE2eeTranscript(handshake);
    const schedule = deriveKeySchedule({ sharedSecret, transcript, clientNonce, desktopNonce });
    return { ready, session: new E2eeServerSession(schedule) };
  }

  get isReady(): boolean {
    return true;
  }

  /** 解密手机→desktop 帧；counter 不匹配或 MAC 失败返回 null。 */
  openFrame(frame: Uint8Array, payloadKind: E2eePayloadKind): Uint8Array | null {
    if (frame.length < NONCE_LENGTH + TAG_LENGTH) return null;
    const expectedCounter = this.#inboundCounter;
    const nonce = encodeE2eeNonce({ direction: "mobile-to-desktop", payloadKind, counter: expectedCounter });
    if (!bufferEqual(frame.subarray(0, NONCE_LENGTH), nonce)) return null;

    const tag = Buffer.from(frame.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH));
    const ciphertext = Buffer.from(frame.subarray(NONCE_LENGTH + TAG_LENGTH));
    const header = encodeE2eeHeader({
      sessionId: this.#schedule.sessionId,
      direction: "mobile-to-desktop",
      payloadKind,
      counter: expectedCounter,
    });

    let plaintext: Buffer | null = null;
    try {
      const dec = createDecipheriv("chacha20-poly1305", this.#schedule.mobileToDesktopKey, nonce, { authTagLength: TAG_LENGTH }) as DecipherGCM;
      dec.setAuthTag(tag);
      dec.setAAD(Buffer.from(header));
      plaintext = Buffer.concat([dec.update(ciphertext), dec.final()]);
    } catch {
      return null;
    }
    this.#inboundCounter++;
    return plaintext;
  }

  /** 加密 desktop→手机 帧。 */
  sealFrame(plaintext: Uint8Array, payloadKind: E2eePayloadKind): Uint8Array {
    if (plaintext.length > MAX_FRAME_PLAINTEXT) {
      throw new Error(`E2EE frame too large: ${plaintext.length} > ${MAX_FRAME_PLAINTEXT}`);
    }
    const counter = this.#outboundCounter;
    const nonce = encodeE2eeNonce({ direction: "desktop-to-mobile", payloadKind, counter });
    const header = encodeE2eeHeader({
      sessionId: this.#schedule.sessionId,
      direction: "desktop-to-mobile",
      payloadKind,
      counter,
    });
    const cipher = createCipheriv("chacha20-poly1305", this.#schedule.desktopToMobileKey, nonce, { authTagLength: TAG_LENGTH }) as CipherGCM;
    cipher.setAAD(Buffer.from(header));
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.#outboundCounter++;
    return Buffer.concat([nonce, tag, ct]);
  }

  get sessionId(): Uint8Array {
    return this.#schedule.sessionId;
  }
}

function bufferEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    diff |= x ^ y;
  }
  return diff === 0;
}
