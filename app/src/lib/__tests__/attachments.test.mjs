import assert from 'node:assert/strict';
import { test } from 'node:test';

const values = new Map();
globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)) };
const { MAX_UPLOAD_BYTES, normalizeAsset, uploadAttachments, withAttachmentNote, parseAttachmentNote, uploadImageSource, tooLargeMessage } = await import('../attachments.js');
const { saveConn } = await import('../../../../web/core/api.js');

test('normalizeAsset：HEIC 原名按实际 JPEG 改扩展名', () => {
  const f = normalizeAsset({ uri: 'file:///cache/ImagePicker/ABC.jpg', fileName: 'IMG_0001.HEIC', fileSize: 1234, type: 'image' });
  assert.equal(f.name, 'IMG_0001.jpg');
  assert.equal(f.size, 1234);
  assert.equal(f.isImage, true);
});

test('normalizeAsset：拍照无文件名、文档保留原名', () => {
  assert.equal(normalizeAsset({ uri: 'file:///c/X.jpg', type: 'image' }, { now: 42 }).name, 'photo-42.jpg');
  const doc = normalizeAsset({ uri: 'file:///c/%E6%8A%A5%E5%91%8A.pdf', name: '报告.pdf', size: 9, mimeType: 'application/pdf' });
  assert.equal(doc.name, '报告.pdf');
  assert.equal(doc.isImage, false);
  assert.equal(normalizeAsset({ uri: 'file:///c/%E6%8A%A5%E5%91%8A.pdf' }).name, '报告.pdf');
});

test('withAttachmentNote', () => {
  assert.equal(withAttachmentNote('hi', []), 'hi');
  assert.match(withAttachmentNote('', ['/u/a.png']), /^请查看我上传的附件。[\s\S]*- \/u\/a\.png$/);
});

test('parseAttachmentNote：还原原话与路径；默认占位文本视为空；普通文本原样返回', () => {
  const paths = ['/Users/m/.claude-remote/uploads/s1/1-a.jpg', '/Users/m/.claude-remote/uploads/s1/2-b.pdf'];
  assert.deepEqual(parseAttachmentNote(withAttachmentNote('看看\n\n这两张', paths)), { text: '看看\n\n这两张', paths });
  assert.deepEqual(parseAttachmentNote(withAttachmentNote('', paths.slice(0, 1))), { text: '', paths: paths.slice(0, 1) });
  assert.deepEqual(parseAttachmentNote('普通消息'), { text: '普通消息', paths: [] });
  const tampered = `${withAttachmentNote('x', paths)}\n后面又写了字`;
  assert.deepEqual(parseAttachmentNote(tampered), { text: tampered, paths: [] });
});

test('uploadImageSource：取最后两级拼回读地址并带鉴权', () => {
  saveConn('http://mac:8788', 'tk');
  assert.deepEqual(uploadImageSource('/Users/m/.claude-remote/uploads/new/17-IMG 1.jpg'), {
    uri: 'http://mac:8788/api/uploads/new/17-IMG%201.jpg',
    headers: { Authorization: 'Bearer tk' },
  });
});

test('uploadAttachments：进度、失败重试不重复上传', async () => {
  saveConn('http://mac:8788', 't');
  const uploads = [];
  let failSecond = true;
  globalThis.fetch = async (url) => {
    if (url.startsWith('file:')) return new Response('data');
    uploads.push(url);
    if (url.includes('b.txt') && failSecond) { failSecond = false; return Response.json({ error: 'boom' }, { status: 500 }); }
    return Response.json({ path: `/up/${new URL(url).searchParams.get('filename')}` });
  };
  const files = [{ uri: 'file:///a', name: 'a.txt', size: 4 }, { uri: 'file:///b', name: 'b.txt', size: 4 }];
  const progress = [];
  await assert.rejects(uploadAttachments(files, '/api/upload', { onProgress: (d, t) => progress.push(`${d}/${t}`) }));
  const paths = await uploadAttachments(files, '/api/upload');
  assert.deepEqual(paths, ['/up/a.txt', '/up/b.txt']);
  assert.equal(uploads.filter((u) => u.includes('a.txt')).length, 1);
  assert.deepEqual(progress, ['0/2', '1/2']);
});

test('uploadAttachments：超限文件在上传前拒绝', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('x'); };
  await assert.rejects(uploadAttachments([{ uri: 'file:///big', name: 'big.mov', size: MAX_UPLOAD_BYTES + 1 }], '/api/upload'),
    (e) => e.status === 413 && tooLargeMessage(e).includes('big.mov'));
  assert.equal(called, false);
});
