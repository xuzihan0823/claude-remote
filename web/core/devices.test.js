import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const values = new Map();
globalThis.localStorage = {
  getItem: (k) => (values.has(k) ? values.get(k) : null),
  setItem: (k, v) => values.set(k, String(v)),
  removeItem: (k) => values.delete(k),
};
const D = await import('./devices.js');

beforeEach(() => values.clear());

test('旧版单连接数据迁移成一台设备并设为当前', () => {
  values.set('bridge_token', 'tok');
  values.set('bridge_base', 'http://100.1.1.1:8787');
  values.set('bridge_bases', JSON.stringify(['192.168.1.2:8787', 'http://100.1.1.1:8787']));
  const list = D.loadDevices();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].bases, ['http://100.1.1.1:8787', 'http://192.168.1.2:8787']);
  assert.equal(D.currentDeviceId(), list[0].id);
  assert.equal(D.loadDevices().length, 1, '只迁移一次');
});

test('没有旧数据时为空列表', () => {
  assert.deepEqual(D.loadDevices(), []);
  assert.equal(D.currentDeviceId(), '');
});

test('同 token 合并、地址交集合并、不同 Mac 新增', () => {
  const a = D.upsertDevice({ bases: ['http://a:1'], token: 't1', name: 'A' });
  const a2 = D.upsertDevice({ base: 'http://a2:1', token: 't1' });
  assert.equal(a2.id, a.id);
  assert.deepEqual(a2.bases, ['http://a2:1', 'http://a:1']);
  const a3 = D.upsertDevice({ base: 'http://a:1', token: 't-new' });
  assert.equal(a3.id, a.id, 'token 换了但地址相同仍是同一台');
  assert.equal(a3.token, 't-new');
  const b = D.upsertDevice({ base: 'http://b:1', token: 't2' });
  assert.notEqual(b.id, a.id);
  assert.equal(D.loadDevices().length, 2);
  assert.equal(D.currentDeviceId(), b.id);
  assert.deepEqual(D.sortedDevices().map((d) => d.id), [b.id, a.id]);
});

test('手动改名后不被 daemon 主机名覆盖', () => {
  const a = D.upsertDevice({ base: 'http://a:1', token: 't' });
  D.updateDevice(a.id, { autoName: 'Xu-MacBook' });
  assert.equal(D.getDevice(a.id).name, 'Xu-MacBook');
  D.updateDevice(a.id, { name: '家里' });
  D.updateDevice(a.id, { autoName: 'Other' });
  D.upsertDevice({ base: 'http://a:1', token: 't', name: 'X' });
  assert.equal(D.getDevice(a.id).name, '家里');
});

test('删除当前设备返回下一台，删光后为空', () => {
  const a = D.upsertDevice({ base: 'http://a:1', token: 't1' });
  const b = D.upsertDevice({ base: 'http://b:1', token: 't2' });
  assert.equal(D.removeDevice(a.id), null, '删的不是当前设备');
  assert.equal(D.removeDevice(b.id), null);
  assert.equal(D.currentDeviceId(), '');
  const c = D.upsertDevice({ base: 'http://c:1', token: 't3' });
  const d = D.upsertDevice({ base: 'http://d:1', token: 't4' });
  assert.equal(D.removeDevice(d.id).id, c.id);
  assert.equal(D.currentDeviceId(), c.id);
});

test('candidateBases 上次连通的地址优先；displayName 去掉 .local', () => {
  assert.deepEqual(D.candidateBases({ lastBase: 'http://b:1', bases: ['http://a:1', 'http://b:1'] }), ['http://b:1', 'http://a:1']);
  assert.equal(D.displayName('Xus-MacBook-Pro.local', 'http://a:1'), 'Xus-MacBook-Pro');
  assert.equal(D.displayName('', 'http://100.1.1.1:8787'), '100.1.1.1:8787');
});

test('removeDeviceAction：非当前 / 切到下一台 / 删光登出', () => {
  const a = D.upsertDevice({ base: 'http://a:1', token: 't1' });
  const b = D.upsertDevice({ base: 'http://b:1', token: 't2' });
  const c = D.upsertDevice({ base: 'http://c:1', token: 't3' });
  assert.deepEqual(D.removeDeviceAction(a.id), { type: 'none' });
  assert.equal(D.currentDeviceId(), c.id, '删别的设备不影响当前');
  assert.deepEqual(D.removeDeviceAction(c.id), { type: 'switch', id: b.id });
  assert.deepEqual(D.removeDeviceAction(b.id), { type: 'logout' });
  assert.deepEqual(D.loadDevices(), []);
});

test('updateDevice：地址去重规范化，未知 id 返回 null', () => {
  const a = D.upsertDevice({ base: 'http://a:1', token: 't' });
  D.updateDevice(a.id, { bases: ['a:1', 'http://a:1/', 'http://b:2'] });
  assert.deepEqual(D.getDevice(a.id).bases, ['http://a:1', 'http://b:2']);
  assert.equal(D.updateDevice('nope', { name: 'x' }), null);
});

test('存储损坏时不崩溃，按空列表处理', () => {
  values.set('bridge_devices', '{oops');
  assert.deepEqual(D.loadDevices(), []);
  values.set('bridge_devices', JSON.stringify([{ id: 'x', bases: ['http://a:1'], token: 't' }, { bad: 1 }, null]));
  assert.deepEqual(D.loadDevices().map((d) => d.id), ['x']);
});

const RELAY = 'https://relay.example.com/d/abc123';

test('baseChannel：relay / Tailscale(100.64/10) / mDNS / 局域网', () => {
  assert.equal(D.baseChannel(RELAY), 'relay');
  assert.equal(D.baseChannel('http://100.64.0.1:8787'), 'tailscale');
  assert.equal(D.baseChannel('http://100.127.255.1:8787'), 'tailscale');
  assert.equal(D.baseChannel('http://100.63.0.1:8787'), 'lan', '100.63 不在 CGNAT 段');
  assert.equal(D.baseChannel('http://100.128.0.1:8787'), 'lan');
  assert.equal(D.baseChannel('http://Xu-Mac.local:8787'), 'mdns');
  assert.equal(D.baseChannel('http://192.168.1.2:8787'), 'lan');
  assert.equal(D.baseChannel('https://relay.example.com/other'), 'lan', '无 /d/<id> 前缀不算 relay');
});

test('candidateBases 按通道偏好过滤；旧记录无偏好按 auto；auto 保持 lastBase 优先', () => {
  const bases = ['http://100.64.1.1:8787', RELAY, 'http://192.168.1.2:8787'];
  const legacy = { lastBase: RELAY, bases };
  assert.deepEqual(D.candidateBases(legacy), [RELAY, 'http://100.64.1.1:8787', 'http://192.168.1.2:8787']);
  assert.deepEqual(D.candidateBases({ ...legacy, channelPref: 'direct' }), ['http://100.64.1.1:8787', 'http://192.168.1.2:8787']);
  assert.deepEqual(D.candidateBases({ ...legacy, channelPref: 'relay' }), [RELAY]);
  assert.deepEqual(D.candidateBases({ ...legacy, channelPref: 'bogus' }), D.candidateBases(legacy));
  assert.equal(D.channelPrefOf({}), 'auto');
});

test('updateDevice 设置通道偏好，非法值忽略', () => {
  const a = D.upsertDevice({ base: 'http://a:1', token: 't' });
  D.updateDevice(a.id, { channelPref: 'relay' });
  assert.equal(D.getDevice(a.id).channelPref, 'relay');
  D.updateDevice(a.id, { channelPref: 'nope' });
  assert.equal(D.getDevice(a.id).channelPref, 'relay');
});

test('syncBases：daemon 列表为准淘汰旧地址，手填地址保留，lastBase 不在新列表时清空', () => {
  const a = D.upsertDevice({ bases: ['http://192.168.1.2:8787', 'http://100.64.1.1:8787'], base: 'http://192.168.1.2:8787', token: 't' });
  D.upsertDevice({ base: 'http://my-mac.example:9000', token: 't', manual: true });
  D.syncBases(a.id, ['http://100.64.1.1:8787', 'http://192.168.1.9:8787', RELAY]);
  const d = D.getDevice(a.id);
  assert.deepEqual(d.bases, ['http://100.64.1.1:8787', 'http://192.168.1.9:8787', RELAY, 'http://my-mac.example:9000']);
  assert.equal(d.lastBase, 'http://my-mac.example:9000', '手填地址仍在列表里，lastBase 保留');

  D.updateDevice(a.id, { bases: d.bases.filter((b) => b !== 'http://my-mac.example:9000') });
  assert.deepEqual(D.getDevice(a.id).manualBases, [], '删掉的地址也从手填里去掉');
  D.syncBases(a.id, ['http://100.64.1.1:8787']);
  assert.deepEqual(D.getDevice(a.id).bases, ['http://100.64.1.1:8787']);
  assert.equal(D.getDevice(a.id).lastBase, '', 'lastBase 被淘汰');
});

test('syncBases：本次连通的地址即使 daemon 未报告也保留；daemon 报告为空时不动', () => {
  const a = D.upsertDevice({ bases: ['http://localhost:8788', 'http://192.168.1.2:8787'], base: 'http://localhost:8788', token: 't' });
  D.syncBases(a.id, [], 'http://localhost:8788');
  assert.deepEqual(D.getDevice(a.id).bases, ['http://localhost:8788', 'http://192.168.1.2:8787']);
  D.syncBases(a.id, ['http://100.64.1.1:8787'], 'http://localhost:8788');
  assert.deepEqual(D.getDevice(a.id).bases, ['http://100.64.1.1:8787', 'http://localhost:8788']);
  assert.equal(D.getDevice(a.id).lastBase, 'http://localhost:8788');
  assert.equal(D.syncBases('nope', ['http://x:1']), null);
});

test('设置页手动新增的地址记为手填，syncBases 不会淘汰', () => {
  const a = D.upsertDevice({ base: 'http://100.64.1.1:8787', token: 't' });
  D.updateDevice(a.id, { bases: ['http://100.64.1.1:8787', 'http://mac.tailnet.ts.net:8787'] });
  D.syncBases(a.id, ['http://100.64.1.1:8787']);
  assert.deepEqual(D.getDevice(a.id).bases, ['http://100.64.1.1:8787', 'http://mac.tailnet.ts.net:8787']);
});
