// RelayManager：按地址增删 connector，保留未变连接（热加载不重启 daemon 的核心逻辑）。

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RelaySettings } from "../src/config.js";
import { RelayManager, type RelayConnectorLike } from "../src/relay/manager.js";

const SECRET = "s".repeat(40);

function settings(url: string, secret = SECRET): RelaySettings {
  return { url, secret, deviceId: `device-${url}`, deviceKey: "k".repeat(40) };
}

interface FakeConnector extends RelayConnectorLike {
  readonly startedAt: Array<{ host: string; port: number }>;
  stopped: number;
  state: "connecting" | "connected" | "disabled";
}

function fakeFactory(): { connectors: FakeConnector[]; create: (settings: RelaySettings) => FakeConnector } {
  const connectors: FakeConnector[] = [];
  return {
    connectors,
    create: (relaySettings) => {
      const connector: FakeConnector = {
        startedAt: [],
        stopped: 0,
        state: "connecting",
        start(address) {
          connector.startedAt.push(address);
        },
        async stop() {
          connector.stopped += 1;
          connector.state = "disabled";
        },
        status() {
          return { state: connector.state, base: `${relaySettings.url}/d/${relaySettings.deviceId}` };
        },
      };
      connectors.push(connector);
      return connector;
    },
  };
}

test("reload：未变的连接原样保留，不重复启动也不断开", async () => {
  const fake = fakeFactory();
  const manager = new RelayManager({ create: fake.create });
  const first = settings("https://relay.example.com");
  await manager.reload([first]);
  manager.start({ host: "127.0.0.1", port: 8787 });
  assert.equal(fake.connectors.length, 1);
  assert.equal(fake.connectors[0]?.startedAt.length, 1);

  const statuses = await manager.reload([{ ...first }]);
  assert.equal(fake.connectors.length, 1);
  assert.equal(fake.connectors[0]?.stopped, 0);
  assert.equal(fake.connectors[0]?.startedAt.length, 1);
  assert.equal(statuses[0]?.base, `${first.url}/d/${first.deviceId}`);
});

test("reload：新增的立即连上，删除的断开", async () => {
  const fake = fakeFactory();
  const manager = new RelayManager({ create: fake.create });
  const a = settings("https://a.example.com");
  const b = settings("https://b.example.com");
  await manager.reload([a]);
  manager.start({ host: "127.0.0.1", port: 8787 });

  await manager.reload([a, b]);
  assert.equal(fake.connectors.length, 2);
  assert.equal(fake.connectors[1]?.startedAt[0]?.port, 8787);
  assert.equal(fake.connectors[0]?.stopped, 0);

  const statuses = await manager.reload([b]);
  assert.equal(fake.connectors[0]?.stopped, 1);
  assert.equal(fake.connectors[1]?.stopped, 0);
  assert.deepEqual(statuses.map((status) => status.base), [`${b.url}/d/${b.deviceId}`]);
});

test("reload：同地址换密钥视为一条新连接", async () => {
  const fake = fakeFactory();
  const manager = new RelayManager({ create: fake.create });
  const url = "https://relay.example.com";
  await manager.reload([settings(url)]);
  manager.start({ host: "127.0.0.1", port: 8787 });
  await manager.reload([settings(url, "t".repeat(40))]);
  assert.equal(fake.connectors.length, 2);
  assert.equal(fake.connectors[0]?.stopped, 1);
  assert.equal(fake.connectors[1]?.startedAt.length, 1);
});

test("reload：listen 之前建立连接不会提前 start，start() 统一拉起", async () => {
  const fake = fakeFactory();
  const manager = new RelayManager({ create: fake.create });
  await manager.reload([settings("https://relay.example.com")]);
  assert.equal(fake.connectors[0]?.startedAt.length, 0);
  manager.start({ host: "127.0.0.1", port: 9000 });
  assert.equal(fake.connectors[0]?.startedAt[0]?.port, 9000);
});

test("stop：断开全部并清空状态", async () => {
  const fake = fakeFactory();
  const manager = new RelayManager({ create: fake.create });
  await manager.reload([settings("https://a.example.com"), settings("https://b.example.com")]);
  manager.start({ host: "127.0.0.1", port: 8787 });
  await manager.stop();
  assert.equal(manager.size, 0);
  assert.deepEqual(manager.statuses(), []);
  assert.deepEqual(fake.connectors.map((connector) => connector.stopped), [1, 1]);
});
