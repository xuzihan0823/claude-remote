import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from '../vendor/marked.esm.min.js';
import { installLinkify, isSafeHref, resolveHref, splitLinks, trimUrl, wholeUrl } from './linkify.js';

const hrefs = (s) => splitLinks(s).filter((x) => x.href).map((x) => x.href);

test('splitLinks：中文标点与文字不进链接', () => {
  assert.deepEqual(hrefs('打开 https://example.com/a?b=1，然后看看'), ['https://example.com/a?b=1']);
  assert.deepEqual(hrefs('地址：https://github.com/x/y。'), ['https://github.com/x/y']);
  assert.deepEqual(hrefs('（见 https://a.com/b）'), ['https://a.com/b']);
  assert.deepEqual(hrefs('see https://a.com/b). ok'), ['https://a.com/b']);
  assert.deepEqual(hrefs('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(hrefs('访问 www.baidu.com 即可'), ['http://www.baidu.com']);
  assert.deepEqual(hrefs('两个 http://localhost:3000 和 https://b.io/x'), ['http://localhost:3000', 'https://b.io/x']);
});

test('splitLinks：拼回原文不丢字', () => {
  const s = '前面 https://a.com/x，后面 www.b.com。结束';
  assert.equal(splitLinks(s).map((x) => x.text).join(''), s);
  assert.deepEqual(splitLinks('没有链接'), [{ text: '没有链接' }]);
  assert.deepEqual(splitLinks(''), [{ text: '' }]);
});

test('trimUrl / wholeUrl', () => {
  assert.equal(trimUrl('https://a.com/x.'), 'https://a.com/x');
  assert.equal(wholeUrl(' http://localhost:5173/ '), 'http://localhost:5173/');
  assert.equal(wholeUrl('npm run dev'), null);
  assert.equal(wholeUrl('http://a.com 和别的'), null);
});

test('installLinkify：marked 自动链接不再吞中文', () => {
  installLinkify(marked);
  const out = [];
  marked.walkTokens(marked.lexer('打开 https://example.com/a，然后 [文档](https://d.com) 再说', { ...marked.defaults, gfm: true, breaks: true }), (t) => { if (t.type === 'link') out.push(t.href); });
  assert.deepEqual(out, ['https://example.com/a', 'https://d.com']);
  assert.match(marked.parse('邮箱 a@b.com'), /mailto:a@b\.com/);
});

test('resolveHref：本机地址改写到 Mac 主机', () => {
  assert.equal(resolveHref('http://localhost:3000/a?b=1', 'http://192.168.1.8:7860'), 'http://192.168.1.8:3000/a?b=1');
  assert.equal(resolveHref('http://127.0.0.1:8080', 'https://mac.tail1234.ts.net'), 'http://mac.tail1234.ts.net:8080/');
  assert.equal(resolveHref('https://github.com/x', 'http://192.168.1.8:7860'), 'https://github.com/x');
  assert.equal(resolveHref('http://localhost:3000', 'http://localhost:7860'), 'http://localhost:3000');
  assert.equal(resolveHref('http://localhost:3000', ''), 'http://localhost:3000');
});

test('isSafeHref', () => {
  assert.ok(isSafeHref('https://a.com'));
  assert.ok(isSafeHref('mailto:a@b.com'));
  assert.ok(!isSafeHref('javascript:alert(1)'));
  assert.ok(!isSafeHref('file:///etc/passwd'));
});
