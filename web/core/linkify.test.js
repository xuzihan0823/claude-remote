import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from '../vendor/marked.esm.min.js';
import { codeFilePath, collectFilePaths, installLinkify, isSafeHref, localFilePath, resolveHref, splitLinks, trimUrl, wholeUrl } from './linkify.js';

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

test('localFilePath：绝对路径、file:// 和相对路径', () => {
  assert.equal(localFilePath('/Users/me/a.html'), '/Users/me/a.html');
  assert.equal(localFilePath('/Users/me/Makefile'), '/Users/me/Makefile');
  assert.equal(localFilePath('</Users/me/含 空格.html>'), '/Users/me/含 空格.html');
  assert.equal(localFilePath('file:///Users/me/%E6%8A%A5%E5%91%8A%20a.html'), '/Users/me/报告 a.html');
  assert.equal(localFilePath('file://localhost/a/b.txt#top'), '/a/b.txt');
  assert.equal(localFilePath('/a/my%20file.html'), '/a/my file.html');
  assert.equal(localFilePath('/a/100%.txt'), '/a/100%.txt');
  assert.equal(localFilePath('src/app.js'), 'src/app.js');
  assert.equal(localFilePath('./report.pdf'), 'report.pdf');
  assert.equal(localFilePath('../other/x.md'), '../other/x.md');
});

test('localFilePath：去掉行号后缀', () => {
  assert.equal(localFilePath('src/app.js:42'), 'src/app.js');
  assert.equal(localFilePath('app.js:42:7'), 'app.js');
  assert.equal(localFilePath('/a/app.js#L10-L20'), '/a/app.js');
});

test('localFilePath：网址、其他协议和没有扩展名的相对路径不算文件', () => {
  for (const href of [
    'https://example.com/a.html', 'http://localhost:3000/a.js', 'www.example.com/a.html', 'mailto:a@example.com',
    'tel:10086', 'javascript:alert(1)', 'data:text/html,x', '//example.com/a.js', '#section', '?q=1',
    'docs/readme', 'localhost:3000', '~/a.txt', '', null, undefined, 'a\nb.txt', 'a\0.txt',
  ]) {
    assert.equal(localFilePath(href), null, String(href));
  }
});

test('codeFilePath：只认整段带扩展名的绝对路径', () => {
  assert.equal(codeFilePath('/Users/me/pelican-bike.html'), '/Users/me/pelican-bike.html');
  assert.equal(codeFilePath('/Users/me/含 空格.pdf'), '/Users/me/含 空格.pdf');
  assert.equal(codeFilePath('/api/sessions'), null);
  assert.equal(codeFilePath('src/app.js'), null);
  assert.equal(codeFilePath('/foo/bar.baz()'), null);
  assert.equal(codeFilePath('cat /etc/hosts.txt'), null);
});

test('collectFilePaths：Markdown 链接、尖括号、反引号和表格都能取到，代码块不算，结果去重', () => {
  installLinkify(marked);
  const md = [
    '[页面](</tmp/含 空格.html>) 和 [外链](https://example.com/a.html)',
    '生成了 `/tmp/a.pdf`，再看 `/api/sessions` 和 [同一个](/tmp/a.pdf)',
    '',
    '| 文件 |',
    '| --- |',
    '| [表格](src/table.md:3) |',
    '',
    '```',
    '/tmp/in-code-block.html',
    '```',
  ].join('\n');
  const tokens = marked.lexer(md, { ...marked.defaults, gfm: true, breaks: true });
  assert.deepEqual(collectFilePaths(marked, tokens), ['/tmp/含 空格.html', '/tmp/a.pdf', 'src/table.md']);
});
