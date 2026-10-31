// 手机端附件：选择结果归一 + 上传（新建会话与已有会话共用）。不依赖 RN，可在 node 下测试。
import { api, ApiError, baseUrl, token } from '../../../web/core/api.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 与 daemon UPLOAD_LIMIT_BYTES 一致

const extOf = (s) => {
  const m = /\.([A-Za-z0-9]{1,8})(?:[?#].*)?$/.exec(String(s || ''));
  return m ? m[1].toLowerCase() : '';
};
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif']);
const KEEP_ORIGINAL_EXT = new Set(['png', 'gif', 'webp']);
/**
 * picker 结果 → { uri, name, size, mimeType, isImage }。
 * 相册原名常是 IMG_0001.HEIC，但 Compatible 模式下实际文件已转成 JPEG：扩展名以 uri 为准，
 * 否则 Claude 会按 .HEIC 去读而失败。拍照没有 fileName，用时间戳命名。
 */
export function normalizeAsset(a, { now = Date.now() } = {}) {
  const uriName = a.uri ? decodeURIComponent(String(a.uri).split('/').pop().split('?')[0]) : '';
  const realExt = extOf(a.uri);
  let name = a.name || a.fileName || '';
  if (!name) name = a.type === 'image' || IMAGE_EXT.has(realExt) ? `photo-${now}.${realExt || 'jpg'}` : uriName || 'file';
  if (realExt && extOf(name) && extOf(name) !== realExt && IMAGE_EXT.has(extOf(name))) {
    name = name.replace(/\.[^.]+$/, `.${realExt}`);
  }
  const mimeType = a.mimeType || '';
  return {
    uri: a.uri,
    name,
    size: a.size ?? a.fileSize ?? 0,
    mimeType,
    isImage: a.type === 'image' || mimeType.startsWith('image/') || IMAGE_EXT.has(extOf(name)),
  };
}

/**
 * 将相册网格选中的资源转为可上传的附件项：
 * PNG / GIF / WebP 优先保留原文件；HEIC / HEIF / 其他格式统一转成兼容 JPEG，避免 Claude Read 报错。
 */
export async function resolveMediaLibraryAsset(item, { getFileUri, convertToJpeg, now = Date.now() } = {}) {
  const filename = item?.filename || '';
  const ext = extOf(filename);
  let sourceUri = item?.uri || item?.id || '';
  if (getFileUri) {
    try {
      const localUri = await getFileUri(item.id);
      if (localUri) sourceUri = localUri;
    } catch {}
  }
  const actualExt = extOf(sourceUri) || ext;
  if (KEEP_ORIGINAL_EXT.has(actualExt) && sourceUri.startsWith('file:')) {
    return normalizeAsset({
      uri: sourceUri,
      fileName: filename || `photo-${now}.${actualExt}`,
      type: 'image',
      mimeType: `image/${actualExt}`,
    }, { now });
  }
  if (convertToJpeg) {
    let jpegUri;
    try {
      jpegUri = await convertToJpeg(sourceUri);
    } catch (err) {
      if (sourceUri !== item?.id && item?.id) {
        jpegUri = await convertToJpeg(item.id);
      } else {
        throw err;
      }
    }
    if (jpegUri) {
      return normalizeAsset({
        uri: jpegUri,
        fileName: filename || `photo-${now}.jpg`,
        type: 'image',
        mimeType: 'image/jpeg',
      }, { now });
    }
  }
  return normalizeAsset({
    uri: sourceUri,
    fileName: filename || `photo-${now}.${actualExt || 'jpg'}`,
    type: 'image',
  }, { now });
}

/** 照片网格多选切换：保持点选顺序，超出上限时返回 overLimit。 */
export function toggleSelectedId(selectedIds, id, limit = 10) {
  const list = Array.isArray(selectedIds) ? selectedIds : [];
  if (list.includes(id)) {
    return { next: list.filter((x) => x !== id), overLimit: false };
  }
  if (list.length >= limit) {
    return { next: list, overLimit: true };
  }
  return { next: [...list, id], overLimit: false };
}

const DEFAULT_NOTE_TEXT = '请查看我上传的附件。';
const NOTE_HEADER = '[手机端上传的附件，已保存在本机，可直接读取]';

/** 把已上传的路径附到消息正文。 */
export function withAttachmentNote(text, paths) {
  if (!paths.length) return text;
  const list = paths.map((p) => `- ${p}`).join('\n');
  return `${text || DEFAULT_NOTE_TEXT}\n\n${NOTE_HEADER}\n${list}`;
}

/** withAttachmentNote 的逆过程：消息气泡里只显示用户原话，附件单独渲染。 */
export function parseAttachmentNote(text) {
  const s = String(text || '');
  const at = s.lastIndexOf(`\n\n${NOTE_HEADER}\n`);
  if (at < 0) return { text: s, paths: [] };
  const lines = s.slice(at + NOTE_HEADER.length + 3).split('\n');
  if (!lines.every((l) => l.startsWith('- '))) return { text: s, paths: [] };
  const body = s.slice(0, at);
  return { text: body === DEFAULT_NOTE_TEXT ? '' : body, paths: lines.map((l) => l.slice(2)) };
}

export const isImagePath = (p) => IMAGE_EXT.has(extOf(p));

/** 已上传图片在 daemon 上的回读地址（GET /api/uploads/<subdir>/<name>）。 */
export function uploadImageSource(path) {
  const [subdir, name] = String(path).split('/').slice(-2);
  if (!subdir || !name) return null;
  return {
    uri: `${baseUrl}/api/uploads/${encodeURIComponent(subdir)}/${encodeURIComponent(name)}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/**
 * 依次上传；已成功的写回 file.uploadedPath，发送失败后重试不会重复上传。
 * endpoint：'/api/upload'（新建会话）或 '/api/sessions/<id>/upload'。
 * 上传途中切换了连接则抛 connection_changed，不把文件传到另一台 daemon。
 */
export async function uploadAttachments(files, endpoint, { onProgress } = {}) {
  const requestBase = baseUrl;
  const requestToken = token;
  const check = () => {
    if (requestBase !== baseUrl || requestToken !== token) throw new ApiError(0, 'connection_changed');
  };
  const tooBig = files.find((f) => f.size > MAX_UPLOAD_BYTES);
  if (tooBig) throw Object.assign(new ApiError(413, 'payload_too_large'), { file: tooBig.name });
  const paths = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.(i, files.length);
    if (f.uploadedPath && f.uploadedBase === requestBase) { paths.push(f.uploadedPath); continue; }
    const blob = await (await fetch(f.uri)).blob();
    check();
    if (blob.size > MAX_UPLOAD_BYTES) throw Object.assign(new ApiError(413, 'payload_too_large'), { file: f.name });
    const r = await api(`${endpoint}?filename=${encodeURIComponent(f.name)}`, {
      method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' },
    });
    check();
    f.uploadedPath = r.path;
    f.uploadedBase = requestBase;
    paths.push(r.path);
  }
  onProgress?.(files.length, files.length);
  return paths;
}

/** 413 的提示文案：带上是哪个文件。 */
export function tooLargeMessage(e) {
  return e?.file ? `「${e.file}」超过 25MB，无法上传` : '附件过大（上限 25MB）';
}
