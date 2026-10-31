import assert from 'node:assert/strict';
import { test } from 'node:test';

const values = new Map();
globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)) };
const { ASK_BEFORE_DOWNLOAD_BYTES, autoDownloads, fileContentRequest, fileErrorText, previewKindFor, previewNavigation, tempFileName, textChunks, utf8SafeLength } = await import('../file-preview.js');
const { saveConn } = await import('../../../../web/core/api.js');

const FILE = 'file:///var/mobile/Containers/Data/Library/Caches/file-preview/1/%E6%8A%A5%E5%91%8A.html';
const nav = (url, extra = {}, platform = 'ios') =>
  previewNavigation({ url, isTopFrame: true, navigationType: 'click', ...extra }, FILE, platform);

test('fileContentRequest：令牌只在请求头，路径编码后进查询参数，relay 前缀保留', () => {
  saveConn('https://relay.example.com/d/abc', 'secret-token');
  const { url, headers } = fileContentRequest('s1', '/tmp/含 空格&.html');
  assert.equal(url, 'https://relay.example.com/d/abc/api/sessions/s1/files/content?path=%2Ftmp%2F%E5%90%AB%20%E7%A9%BA%E6%A0%BC%26.html');
  assert.ok(!url.includes('secret-token'));
  assert.equal(headers.Authorization, 'Bearer secret-token');
});

test('错误码转成文案，未知错误有兜底', () => {
  assert.equal(fileErrorText('outside_workspace'), '文件不在项目目录内');
  assert.equal(fileErrorText('network_error'), '无法读取文件');
});

test('PDF 只有 iOS 能预览，其余类型不受平台影响', () => {
  assert.equal(previewKindFor({ previewKind: 'pdf' }, 'ios'), 'pdf');
  assert.equal(previewKindFor({ previewKind: 'pdf' }, 'android'), 'none');
  assert.equal(previewKindFor({ previewKind: 'html' }, 'android'), 'html');
});

test('无法预览和超过阈值的文件不自动下载', () => {
  assert.equal(autoDownloads('html', ASK_BEFORE_DOWNLOAD_BYTES), true);
  assert.equal(autoDownloads('html', ASK_BEFORE_DOWNLOAD_BYTES + 1), false);
  assert.equal(autoDownloads('none', 1), false);
});

test('临时文件名不含路径分隔符', () => {
  assert.equal(tempFileName('../../evil.html'), '.._.._evil.html');
  assert.equal(tempFileName(''), 'file');
});

test('utf8SafeLength：截在多字节字符中间时退回边界，完整时不动', () => {
  const bytes = new TextEncoder().encode('a中😀');
  assert.equal(utf8SafeLength(bytes), bytes.length);
  assert.equal(utf8SafeLength(bytes.subarray(0, 3)), 1);
  assert.equal(utf8SafeLength(bytes.subarray(0, 2)), 1);
  assert.equal(utf8SafeLength(bytes.subarray(0, 7)), 4);
  assert.equal(utf8SafeLength(bytes.subarray(0, 4)), 4);
  assert.equal(utf8SafeLength(new Uint8Array([0x61, 0x62])), 2);
});

test('textChunks：切块后拼回原文不丢内容', () => {
  const text = Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n');
  const chunks = textChunks(text);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join('\n'), text);
  assert.deepEqual(textChunks(''), ['']);
});

test('previewNavigation：文件自身和页内地址留在预览里', () => {
  assert.equal(nav(FILE, { navigationType: 'other' }), 'allow');
  assert.equal(nav(`${FILE}#section`, { navigationType: 'other' }), 'allow');
  assert.equal(nav('about:blank'), 'allow');
  assert.equal(nav('blob:null/1'), 'allow');
  assert.equal(nav(FILE.replace('file:///var/', 'file:///private/var/')), 'allow');
  assert.equal(nav('file:///var/mobile/Containers/Data/Library/Caches/file-preview/1/报告.html'), 'allow');
});

test('previewNavigation：其他本机文件和自定义协议一律拦截', () => {
  assert.equal(nav('file:///etc/passwd'), 'block');
  assert.equal(nav('file:///var/mobile/Containers/Data/Library/Preferences/app.plist'), 'block');
  assert.equal(nav('claude-remote://session/1'), 'block');
  assert.equal(nav('tel:10086'), 'block');
  assert.equal(nav('javascript:alert(1)'), 'block');
});

test('previewNavigation：外部链接交给系统浏览器，iOS 上自动跳转不放行', () => {
  assert.equal(nav('https://example.com/'), 'external');
  assert.equal(nav('https://example.com/', { navigationType: 'other' }), 'block');
  assert.equal(nav('https://example.com/', { navigationType: 'other' }, 'android'), 'external');
  assert.equal(nav('https://example.com/embed', { isTopFrame: false, navigationType: 'other' }), 'allow');
});
