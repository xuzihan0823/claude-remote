import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "node:crypto";

import {
  E2EE_PROTOCOL,
  E2EE_TRANSCRIPT_DOMAIN,
  HEADER_LENGTH,
  KEY_LENGTH,
  NONCE_LENGTH,
  SESSION_ID_LENGTH,
  encodeE2eeHeader,
  encodeE2eeNonce,
  encodeE2eeTranscript,
  parseE2eeHello,
} from "@claude-remote/relay/e2ee";
import { E2eeServerSession, generateE2eeKeyPair } from "../src/e2ee-session.js";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** 客户端（模拟 iOS）端会话：与 E2eeServerSession 对偶，用于验证往返。 */
interface ClientSchedule {
  mobileToDesktopKey: Uint8Array;
  desktopToMobileKey: Uint8Array;
  sessionId: Uint8Array;
}

class ClientSession {
  readonly #schedule: ClientSchedule;
  #inboundCounter = 0n;
  #outboundCounter = 0n;

  private constructor(schedule: ClientSchedule) {
    this.#schedule = schedule;
  }

  static fromHelloAndReady(hello: Record<string, unknown>, ready: Record<string, unknown>, clientKeyPair: { privateKeyRaw: Buffer; publicKeyRaw: Buffer }): ClientSession | null {
    const desktopPublicKeyB64 = (ready as { desktopPublicKeyB64?: string }).desktopPublicKeyB64;
    const clientNonceB64 = (hello as { clientNonceB64?: string }).clientNonceB64;
    const desktopNonceB64 = (ready as { desktopNonceB64?: string }).desktopNonceB64;
    if (!desktopPublicKeyB64 || !clientNonceB64 || !desktopNonceB64) return null;
    const clientNonce = Buffer.from(clientNonceB64, "base64");
    const desktopNonce = Buffer.from(desktopNonceB64, "base64");
    const desktopPublicKeyRaw = Buffer.from(desktopPublicKeyB64, "base64");
    if (clientNonce.length !== KEY_LENGTH || desktopNonce.length !== KEY_LENGTH || desktopPublicKeyRaw.length !== KEY_LENGTH) return null;

    const clientPriv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, clientKeyPair.privateKeyRaw]), format: "der", type: "pkcs8" });
    const desktopPub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, desktopPublicKeyRaw]), format: "der", type: "spki" });
    const sharedSecret = diffieHellman({ privateKey: clientPriv, publicKey: desktopPub });

    // 复刻 transcript（与协议侧 encodeE2eeTranscript 一致）
    const handshake = {
      hello: hello as never,
      ready: ready as never,
      clientPublicKey: clientKeyPair.publicKeyRaw,
      desktopPublicKey: desktopPublicKeyRaw,
      clientNonce,
      desktopNonce,
    };
    const transcript = encodeE2eeTranscript(handshake);
    const saltInput = Buffer.concat([
      Buffer.from("claude-remote-e2ee/v1/salt", "utf8"),
      Buffer.from([0]),
      clientNonce,
      desktopNonce,
    ]);
    const salt = createHash("sha256").update(saltInput).digest();
    const info = Buffer.concat([Buffer.from("claude-remote-e2ee/v1/session", "utf8"), Buffer.from([0]), salt.subarray(0, 0)]);
    // 实际派生需要 transcriptHash 在 info 里
    const transcriptHash = createHash("sha256").update(transcript).digest();
    const info2 = Buffer.concat([Buffer.from("claude-remote-e2ee/v1/session", "utf8"), Buffer.from([0]), transcriptHash]);
    const expanded = Buffer.from(hkdfSync("sha256", sharedSecret, salt, info2, 96));
    return new ClientSession({
      mobileToDesktopKey: expanded.subarray(0, KEY_LENGTH),
      desktopToMobileKey: expanded.subarray(KEY_LENGTH, KEY_LENGTH * 2),
      sessionId: expanded.subarray(KEY_LENGTH * 2, KEY_LENGTH * 2 + SESSION_ID_LENGTH),
    });
  }

  sealFrame(plaintext: Uint8Array, payloadKind: "text" | "binary"): Uint8Array {
    const counter = this.#outboundCounter;
    const nonce = encodeE2eeNonce({ direction: "mobile-to-desktop", payloadKind, counter });
    const header = encodeE2eeHeader({ sessionId: this.#schedule.sessionId, direction: "mobile-to-desktop", payloadKind, counter });
    const cipher = createCipheriv("chacha20-poly1305", this.#schedule.mobileToDesktopKey, nonce, { authTagLength: 16 }) as CipherGCM;
    cipher.setAAD(Buffer.from(header));
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.#outboundCounter++;
    return Buffer.concat([nonce, tag, ct]);
  }

  openFrame(frame: Uint8Array, payloadKind: "text" | "binary"): Uint8Array | null {
    if (frame.length < NONCE_LENGTH + 16) return null;
    const expectedCounter = this.#inboundCounter;
    const nonce = encodeE2eeNonce({ direction: "desktop-to-mobile", payloadKind, counter: expectedCounter });
    if (!bufferEqual(frame.subarray(0, NONCE_LENGTH), nonce)) return null;
    const tag = Buffer.from(frame.subarray(NONCE_LENGTH, NONCE_LENGTH + 16));
    const ciphertext = Buffer.from(frame.subarray(NONCE_LENGTH + 16));
    const header = encodeE2eeHeader({ sessionId: this.#schedule.sessionId, direction: "desktop-to-mobile", payloadKind, counter: expectedCounter });
    try {
      const dec = createDecipheriv("chacha20-poly1305", this.#schedule.desktopToMobileKey, nonce, { authTagLength: 16 }) as DecipherGCM;
      dec.setAuthTag(tag);
      dec.setAAD(Buffer.from(header));
      const pt = Buffer.concat([dec.update(ciphertext), dec.final()]);
      this.#inboundCounter++;
      return pt;
    } catch {
      return null;
    }
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

function makeClientKeyPair(): { privateKeyRaw: Buffer; publicKeyRaw: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return { privateKeyRaw: privDer.subarray(-KEY_LENGTH), publicKeyRaw: pubDer.subarray(-KEY_LENGTH) };
}

test("E2EE 握手往返：客户端 seal → 服务端 open；服务端 seal → 客户端 open", () => {
  const serverKeys = generateE2eeKeyPair();
  const clientKeys = makeClientKeyPair();
  const clientNonce = randomBytes(KEY_LENGTH);

  const hello = {
    type: "cr_e2ee_hello" as const,
    v: 1,
    clientPublicKeyB64: clientKeys.publicKeyRaw.toString("base64"),
    clientNonceB64: clientNonce.toString("base64"),
    capabilities: { framing: [1] as [1], payloadKinds: ["text", "binary"] as ["text", "binary"] },
    context: { protocol: E2EE_PROTOCOL, initiator: "mobile" as const, responder: "desktop" as const, transport: "relay" as const, relayHostId: "relay.example.com" },
  };

  const accepted = E2eeServerSession.acceptHello(hello, { privateKeyB64: serverKeys.privateKeyB64, transport: "relay", relayHostId: "relay.example.com" });
  assert.ok(accepted, "服务端应接受合法 hello");
  const { ready, session } = accepted;

  const client = ClientSession.fromHelloAndReady(hello as Record<string, unknown>, ready as unknown as Record<string, unknown>, clientKeys);
  assert.ok(client, "客户端应能从 hello+ready 派生相同密钥");

  // 客户端 → 服务端：文本帧
  const sealedText = client.sealFrame(Buffer.from("hello over E2EE", "utf8"), "text");
  const openedText = session.openFrame(sealedText, "text");
  assert.ok(openedText, "服务端应能解密文本帧");
  assert.equal(Buffer.from(openedText).toString("utf8"), "hello over E2EE");

  // 服务端 → 客户端：二进制帧
  const binPayload = randomBytes(1000);
  const sealedBin = session.sealFrame(binPayload, "binary");
  const openedBin = client.openFrame(sealedBin, "binary");
  assert.ok(openedBin, "客户端应能解密二进制帧");
  assert.deepEqual(Buffer.from(openedBin), binPayload);
});

test("E2EE replay 攻击：重复帧被拒（counter 不递增）", () => {
  const serverKeys = generateE2eeKeyPair();
  const clientKeys = makeClientKeyPair();
  const clientNonce = randomBytes(KEY_LENGTH);
  const hello = {
    type: "cr_e2ee_hello" as const,
    v: 1,
    clientPublicKeyB64: clientKeys.publicKeyRaw.toString("base64"),
    clientNonceB64: clientNonce.toString("base64"),
    capabilities: { framing: [1] as [1], payloadKinds: ["text", "binary"] as ["text", "binary"] },
    context: { protocol: E2EE_PROTOCOL, initiator: "mobile" as const, responder: "desktop" as const, transport: "direct" as const },
  };
  const accepted = E2eeServerSession.acceptHello(hello, { privateKeyB64: serverKeys.privateKeyB64, transport: "direct" })!;
  const { session } = accepted;
  const client = ClientSession.fromHelloAndReady(hello as Record<string, unknown>, accepted.ready as unknown as Record<string, unknown>, clientKeys)!;

  const sealed = client.sealFrame(Buffer.from("first", "utf8"), "text");
  assert.ok(session.openFrame(sealed, "text"), "首帧应通过");
  // 客户端 counter 已自增，但若攻击者重放同一帧，counter 不匹配 → null
  assert.equal(session.openFrame(sealed, "text"), null, "重放帧应被拒");
});

test("E2EE parseE2eeHello 拒绝格式错误的消息", () => {
  assert.equal(parseE2eeHello(null), null);
  assert.equal(parseE2eeHello({}), null);
  assert.equal(parseE2eeHello({ type: "cr_e2ee_hello", v: 2 }), null); // 版本错
  assert.equal(parseE2eeHello({ type: "wrong", v: 1 }), null);
  const valid = {
    type: "cr_e2ee_hello",
    v: 1,
    clientPublicKeyB64: "x".repeat(32),
    clientNonceB64: "y".repeat(32),
    capabilities: { framing: [1], payloadKinds: ["text", "binary"] },
    context: { protocol: E2EE_PROTOCOL, initiator: "mobile", responder: "desktop", transport: "relay" },
  };
  assert.ok(parseE2eeHello(valid), "合法消息应通过");
});

test("generateE2eeKeyPair 返回 32 字节 base64 密钥", () => {
  const kp = generateE2eeKeyPair();
  assert.equal(Buffer.from(kp.privateKeyB64, "base64").length, KEY_LENGTH);
  assert.equal(Buffer.from(kp.publicKeyB64, "base64").length, KEY_LENGTH);
});
