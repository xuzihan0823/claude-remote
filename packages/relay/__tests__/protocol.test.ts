import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CreditReceiver,
  CreditSender,
  DataType,
  INITIAL_WINDOW,
  closeReason,
  deriveDeviceId,
  encodeControl,
  encodeData,
  filterHeaders,
  generateDeviceKey,
  isDeviceId,
  isDeviceKey,
  parseControl,
  parseData,
  sendableCloseCode,
  type ControlFrame,
} from "../src/protocol.js";
import { ID_A, KEY_A } from "./helpers.js";

test("控制帧编解码往返", () => {
  const frames: ControlFrame[] = [
    {
      t: "open",
      sid: 1,
      kind: "http",
      method: "POST",
      path: "/api/upload?filename=a%20b.png&token=x",
      headers: { "content-type": "image/png", "set-cookie": ["a=1", "b=2"] },
      remote: "203.0.113.9",
    },
    { t: "open", sid: 0xffffffff, kind: "ws", path: "/ws?token=abc", headers: {}, remote: "" },
    { t: "head", sid: 2, status: 404, headers: { "content-type": "application/json" } },
    { t: "accept", sid: 3 },
    { t: "end", sid: 4 },
    { t: "wsclose", sid: 5, code: 4000, reason: "bye" },
    { t: "reset", sid: 6, reason: "client_closed" },
    { t: "credit", sid: 7, bytes: 65536 },
  ];
  for (const frame of frames) {
    assert.deepEqual(parseControl(encodeControl(frame)), { ok: true, frame });
  }
});

test("非法控制帧返回错误而不是抛出", () => {
  const bad: unknown[] = [
    "not json",
    "[]",
    "null",
    "42",
    { t: "nope", sid: 1 },
    { t: "end" },
    { t: "end", sid: 0 },
    { t: "end", sid: -1 },
    { t: "end", sid: 1.5 },
    { t: "end", sid: 0x100000000 },
    { t: "end", sid: "1" },
    { t: "credit", sid: 1, bytes: 0 },
    { t: "credit", sid: 1, bytes: -5 },
    { t: "head", sid: 1, status: 99, headers: {} },
    { t: "head", sid: 1, status: 600, headers: {} },
    { t: "head", sid: 1, status: 200 },
    { t: "head", sid: 1, status: 200, headers: [] },
    { t: "head", sid: 1, status: 200, headers: { "x-a": "line\r\nInjected: 1" } },
    { t: "head", sid: 1, status: 200, headers: { "bad name": "v" } },
    { t: "head", sid: 1, status: 200, headers: { "x-a": 5 } },
    { t: "head", sid: 1, status: 200, headers: { "x-a": ["ok", 1] } },
    { t: "wsclose", sid: 1, code: 999, reason: "" },
    { t: "wsclose", sid: 1, code: 1000, reason: "x".repeat(124) },
    { t: "wsclose", sid: 1, code: 1000 },
    { t: "reset", sid: 1 },
    { t: "open", sid: 1, kind: "http", method: "GET", path: "no-slash", headers: {}, remote: "" },
    { t: "open", sid: 1, kind: "http", method: "GET", path: "/has space", headers: {}, remote: "" },
    { t: "open", sid: 1, kind: "http", method: "G E T", path: "/", headers: {}, remote: "" },
    { t: "open", sid: 1, kind: "tcp", path: "/", headers: {}, remote: "" },
    { t: "open", sid: 1, kind: "ws", path: "/", headers: {} },
  ];
  for (const value of bad) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const result = parseControl(text);
    assert.equal(result.ok, false, `应拒绝 ${text}`);
  }
  // __proto__ 头名不能污染原型
  const proto = parseControl('{"t":"head","sid":1,"status":200,"headers":{"__proto__":"x"}}');
  assert.equal(proto.ok, false);
});

test("数据帧编解码往返与非法帧", () => {
  for (const type of [DataType.HttpBody, DataType.WsText, DataType.WsBinary]) {
    const payload = Buffer.from([0, 1, 2, 250, 255]);
    const buf = encodeData(type, 0xfffffffe, payload);
    assert.equal(buf.length, 10);
    assert.equal(buf[0], type);
    assert.equal(buf.readUInt32BE(1), 0xfffffffe);
    const parsed = parseData(buf);
    assert.ok(parsed.ok);
    assert.equal(parsed.frame.type, type);
    assert.equal(parsed.frame.sid, 0xfffffffe);
    assert.deepEqual([...parsed.frame.payload], [...payload]);
  }
  const empty = parseData(encodeData(DataType.HttpBody, 1, Buffer.alloc(0)));
  assert.ok(empty.ok && empty.frame.payload.length === 0);
  assert.equal(parseData(Buffer.from([1, 0, 0, 0])).ok, false);
  assert.equal(parseData(Buffer.from([9, 0, 0, 0, 1])).ok, false);
  assert.equal(parseData(Buffer.from([1, 0, 0, 0, 0])).ok, false);
});

test("设备 ID 派生：固定向量与格式", () => {
  assert.equal(deriveDeviceId(KEY_A), ID_A);
  assert.equal(deriveDeviceId("test-key"), "fj66lblcs5fnemqwta2r");
  const key = generateDeviceKey();
  assert.ok(isDeviceKey(key));
  assert.equal(Buffer.from(key, "base64url").length, 32);
  assert.notEqual(generateDeviceKey(), key);
  assert.ok(isDeviceId(deriveDeviceId(key)));
  assert.equal(isDeviceId("BZBPTGNFVEDW5F5BHWOW"), false);
  assert.equal(isDeviceId("bzbptgnfvedw5f5bhwo1"), false);
  assert.equal(isDeviceKey(`${key}=`), false);
});

test("filterHeaders 去掉 hop-by-hop 头", () => {
  const out = filterHeaders({
    Host: "relay.example.com",
    Connection: "keep-alive, X-Secret-Hop",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    upgrade: "websocket",
    te: "trailers",
    trailer: "x",
    "proxy-authorization": "Basic x",
    "proxy-connection": "keep-alive",
    "x-secret-hop": "drop me",
    authorization: "Bearer t",
    "content-length": 12,
    "set-cookie": ["a=1", "b=2"],
    "x-undefined": undefined,
  });
  assert.deepEqual(out, {
    host: "relay.example.com",
    authorization: "Bearer t",
    "content-length": "12",
    "set-cookie": ["a=1", "b=2"],
  });
});

test("关闭码与 reason 映射为可发送的值", () => {
  assert.equal(sendableCloseCode(1000), 1000);
  assert.equal(sendableCloseCode(4001), 4001);
  assert.equal(sendableCloseCode(1005), 1000);
  assert.equal(sendableCloseCode(1006), 1000);
  assert.equal(sendableCloseCode(1015), 1000);
  assert.equal(sendableCloseCode(2000), 1000);
  assert.equal(Buffer.byteLength(closeReason("长".repeat(100))) <= 123, true);
});

function recordingSender(initial = 10) {
  const sent: { type: DataType; bytes: string }[] = [];
  let resumed = 0;
  const sender = new CreditSender(
    {
      send: (type, payload) => sent.push({ type, bytes: payload.toString() }),
      resume: () => resumed++,
    },
    initial,
  );
  return { sender, sent, resumed: () => resumed };
}

test("CreditSender：HTTP 体按窗口切分，耗尽后暂停，credit 后续发并恢复", () => {
  const { sender, sent, resumed } = recordingSender(10);
  assert.equal(sender.push(DataType.HttpBody, Buffer.from("abcdef")), true);
  assert.equal(sender.push(DataType.HttpBody, Buffer.from("ghijklmn")), false);
  assert.deepEqual(sent.map((s) => s.bytes), ["abcdef", "ghij"]);
  assert.equal(sender.queuedBytes, 4);
  let ended = false;
  sender.afterFlush(() => (ended = true));
  assert.equal(ended, false, "队列未清空前不能发 end");
  sender.credit(3);
  assert.deepEqual(sent.map((s) => s.bytes), ["abcdef", "ghij", "klm"]);
  assert.equal(resumed(), 0);
  sender.credit(5);
  assert.deepEqual(sent.map((s) => s.bytes), ["abcdef", "ghij", "klm", "n"]);
  assert.equal(ended, true);
  assert.equal(resumed(), 1);
  assert.equal(sender.window, 4);
});

test("CreditSender：WS 消息整条发送，超窗消息只在无未确认数据时放行", () => {
  const { sender, sent, resumed } = recordingSender(10);
  assert.equal(sender.push(DataType.WsText, Buffer.from("123456")), true);
  assert.equal(sender.push(DataType.WsText, Buffer.from("abcdef")), false);
  assert.deepEqual(sent.map((s) => s.bytes), ["123456"], "不能切开 WS 消息");
  sender.credit(6);
  assert.deepEqual(sent.map((s) => s.bytes), ["123456", "abcdef"]);
  assert.equal(resumed(), 1);
  sender.credit(6);
  assert.equal(sender.push(DataType.WsBinary, Buffer.from("x".repeat(25))), false);
  assert.equal(sent.length, 3, "窗口满时大消息直接放行");
  assert.equal(sender.push(DataType.WsText, Buffer.from("y")), false);
  assert.equal(sent.length, 3);
  sender.credit(25);
  assert.equal(sent.length, 4);
});

test("CreditReceiver：越过窗口判为违规，release 后可继续", () => {
  const receiver = new CreditReceiver(10);
  assert.equal(receiver.admit(6), true);
  assert.equal(receiver.admit(5), false);
  assert.equal(receiver.admit(4), true);
  receiver.release(10);
  assert.equal(receiver.admit(50), true, "无未确认数据时放行整条大消息");
  assert.equal(receiver.admit(1), false);
  assert.equal(INITIAL_WINDOW, 256 * 1024);
});
