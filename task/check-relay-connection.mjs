import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const original = await readFile(new URL('../web/core/api.js', import.meta.url), 'utf8');
const source = original.replace(/^import .*?;\n/, 'const bus = { emit() {} };\n');
globalThis.localStorage = { getItem() { return ''; }, setItem() {} };
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
for (const [base, token, expected] of [
  ['https://relay.example.com/claude/', 'test-token', 'wss://relay.example.com/claude/ws?token=test-token'],
  ['http://100.64.0.2:8788', 'x+y', 'ws://100.64.0.2:8788/ws?token=x%2By'],
  ['https://direct.example.com', 't', 'wss://direct.example.com/ws?token=t'],
]) {
  api.saveConn(base, token);
  assert.equal(api.wsEndpoint(), expected);
}
console.log('Relay path, Tailscale and direct WebSocket URLs passed');
