import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.localStorage = { getItem: () => null, setItem() {} };
const { resolveImageSrc } = await import('./md-image.js');
const opt = { sessionId: 's 1', base: 'http://mac.local:8788', tok: 'T', host: 'mac.local:8788' };

test('远程图片直接用', () => {
  assert.deepEqual(resolveImageSrc('https://x.com/a.png', opt), { uri: 'https://x.com/a.png', local: false });
  assert.equal(resolveImageSrc('data:image/png;base64,AAA', opt).uri, 'data:image/png;base64,AAA');
});

test('localhost 改写为 Mac 主机', () => {
  assert.equal(resolveImageSrc('http://localhost:3000/shot.png', opt).uri, 'http://mac.local:3000/shot.png');
  assert.equal(resolveImageSrc('http://127.0.0.1/x.jpg', { ...opt, host: '127.0.0.1:8788' }).uri, 'http://127.0.0.1/x.jpg');
});

test('本机路径走 daemon，带鉴权', () => {
  const r = resolveImageSrc('/Users/me/out/chart.png', opt);
  assert.equal(r.uri, 'http://mac.local:8788/api/sessions/s%201/file?path=%2FUsers%2Fme%2Fout%2Fchart.png');
  assert.deepEqual(r.headers, { Authorization: 'Bearer T' });
  assert.equal(r.local, true);
  assert.match(resolveImageSrc('./图表%20一.png', opt).uri, /path=\.%2F%E5%9B%BE%E8%A1%A8%20%E4%B8%80\.png$/);
  assert.match(resolveImageSrc('file:///tmp/a.webp', opt).uri, /path=file%3A%2F%2F%2Ftmp%2Fa\.webp$/);
});

test('不是图片 / 无会话 / 危险协议 → null', () => {
  assert.equal(resolveImageSrc('/Users/me/a.txt', opt), null);
  assert.equal(resolveImageSrc('/a.png', { ...opt, sessionId: '' }), null);
  assert.equal(resolveImageSrc('javascript:alert(1)', opt), null);
  assert.equal(resolveImageSrc('', opt), null);
});
