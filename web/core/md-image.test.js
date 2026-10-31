import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { resolveImageSrc } = await import('./md-image.js');
const opt = { sessionId: 's 1', base: 'http://mac.local:8788', tok: 'T' };

test('远程图片与 raster data: 返回非 local 地址', () => {
  assert.deepEqual(resolveImageSrc('https://x.com/a.png', opt), { uri: 'https://x.com/a.png', local: false });
  assert.deepEqual(resolveImageSrc('data:image/png;base64,AAA', opt), { uri: 'data:image/png;base64,AAA', local: false });
  assert.deepEqual(resolveImageSrc('data:image/jpeg;base64,BBB', opt), { uri: 'data:image/jpeg;base64,BBB', local: false });
});

test('loopback http(s) 地址不改写，返回 null 退化为链接', () => {
  assert.equal(resolveImageSrc('http://localhost:3000/shot.png', opt), null);
  assert.equal(resolveImageSrc('http://127.0.0.1/x.jpg', opt), null);
  assert.equal(resolveImageSrc('http://[::1]:8080/x.png', opt), null);
  assert.equal(resolveImageSrc('http://0.0.0.0:5173/x.png', opt), null);
  assert.equal(resolveImageSrc('http://app.localhost:3000/x.png', opt), null);
});

test('本机路径走 daemon /api/sessions/:id/file，带鉴权并兼容 relay base', () => {
  const r = resolveImageSrc('/Users/me/out/chart.png', opt);
  assert.equal(r.uri, 'http://mac.local:8788/api/sessions/s%201/file?path=%2FUsers%2Fme%2Fout%2Fchart.png');
  assert.deepEqual(r.headers, { Authorization: 'Bearer T' });
  assert.equal(r.local, true);
  assert.match(resolveImageSrc('./图表%20一.png', opt).uri, /path=\.%2F%E5%9B%BE%E8%A1%A8%20%E4%B8%80\.png$/);
  assert.match(resolveImageSrc('~/Desktop/shot.heic', opt).uri, /path=~%2FDesktop%2Fshot\.heic$/);
  assert.match(resolveImageSrc('file:///tmp/a.webp', opt).uri, /path=file%3A%2F%2F%2Ftmp%2Fa\.webp$/);

  const relay = resolveImageSrc('/Users/me/out/chart.png', {
    sessionId: 's 1',
    base: 'https://relay.example.com/d/dev_42/',
    tok: 'T',
  });
  assert.equal(
    relay.uri,
    'https://relay.example.com/d/dev_42/api/sessions/s%201/file?path=%2FUsers%2Fme%2Fout%2Fchart.png',
  );
  assert.deepEqual(relay.headers, { Authorization: 'Bearer T' });
  assert.equal(relay.local, true);
});

test('SVG、非图片、无会话、危险协议 → null', () => {
  assert.equal(resolveImageSrc('/Users/me/a.svg', opt), null);
  assert.equal(resolveImageSrc('file:///tmp/a.svg', opt), null);
  assert.equal(resolveImageSrc('https://x.com/a.svg', opt), null);
  assert.equal(resolveImageSrc('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', opt), null);
  assert.equal(resolveImageSrc('data:image/svg+xml;utf8,<svg></svg>', opt), null);
  assert.equal(resolveImageSrc('/Users/me/a.txt', opt), null);
  assert.equal(resolveImageSrc('/a.png', { ...opt, sessionId: '' }), null);
  assert.equal(resolveImageSrc('javascript:alert(1)', opt), null);
  assert.equal(resolveImageSrc('ftp://example.com/a.png', opt), null);
  assert.equal(resolveImageSrc('', opt), null);
});

const mdImageSource = readFileSync(new URL('../../app/src/components/markdown/MdImage.js', import.meta.url), 'utf8');
function mountMdImage(initialProps, getSize) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let props = initialProps;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (update) => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const prev = effects[index];
      if (!prev || deps.some((v, i) => v !== prev.deps[i])) {
        effects[index] = { fn, deps, cleanup: prev?.cleanup, pending: true };
      }
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    resolveImageSrc: (href, o) => resolveImageSrc(href, { ...opt, ...o }),
    shouldAutoLoad: (src) => Boolean(src && (src.local || /^data:image\//i.test(src.uri))),
    sizeCache: new Map(),
    getSize,
  };
  const start = 'export const MdImage = memo(function MdImage({ href, alt, sessionId, ctx, inline }) {';
  const end = '  if (failed || !src) {';
  const body = mdImageSource.slice(mdImageSource.indexOf(start) + start.length, mdImageSource.indexOf(end));
  const run = new Function('props', ...Object.keys(hooks), `const { href, alt, sessionId, ctx, inline } = props;\n${body}\nreturn { src, allowed, setAllowed, size, failed, open, setOpen };`);
  return {
    render(nextProps = props) {
      props = nextProps;
      cursor = 0;
      const out = run(props, ...Object.values(hooks));
      for (const eff of effects) {
        if (!eff?.pending) continue;
        eff.cleanup?.();
        eff.cleanup = eff.fn();
        eff.pending = false;
      }
      return out;
    },
  };
}

test('MdImage：远程图片默认不联网调用 getSize，点击后才请求；本机与 raster data: 自动请求', async () => {
  const requested = [];
  const getSize = (src) => {
    requested.push(src.uri);
    return Promise.resolve({ w: 200, h: 100 });
  };

  const remote = mountMdImage({ href: 'https://attacker.example/leak.png', sessionId: 's 1' }, getSize);
  let state = remote.render();
  assert.equal(state.allowed, false);
  assert.deepEqual(requested, [], '远程图片未点击前不得调用 getSize');

  state.setAllowed(true);
  state = remote.render();
  assert.equal(state.allowed, true);
  assert.deepEqual(requested, ['https://attacker.example/leak.png']);
  state = remote.render({ href: 'https://attacker.example/another.png', sessionId: 's 1' });
  assert.equal(state.allowed, false, '地址变化后必须重新点击');
  assert.deepEqual(requested, ['https://attacker.example/leak.png']);

  requested.length = 0;
  const local = mountMdImage({ href: '/Users/me/out/chart.png', sessionId: 's 1' }, getSize);
  state = local.render();
  assert.equal(state.allowed, true);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/api\/sessions\/s%201\/file\?path=/);

  requested.length = 0;
  const dataImg = mountMdImage({ href: 'data:image/png;base64,AAA', sessionId: 's 1' }, getSize);
  state = dataImg.render();
  assert.equal(state.allowed, true);
  assert.deepEqual(requested, ['data:image/png;base64,AAA']);
});
