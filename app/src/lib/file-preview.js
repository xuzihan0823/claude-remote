// 文件预览的纯逻辑：请求地址、类型判断、WebView 导航规则。不依赖 RN，可在 node 下测试。
import { api, baseUrl, token } from '../../../web/core/api.js';

export const TEXT_PREVIEW_BYTES = 1024 * 1024;
export const ASK_BEFORE_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const ERROR_TEXT = {
  outside_workspace: '文件不在项目目录内',
  sensitive_file: '敏感文件不能在手机上查看',
  file_not_found: '文件不存在',
  session_not_found: '会话不存在',
  invalid_path: '文件路径无效',
};

export const fileErrorText = (code) => ERROR_TEXT[code] || '无法读取文件';

const filePath = (sessionId, kind, path) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/files/${kind}?path=${encodeURIComponent(path)}`;

export function fetchFileMeta(sessionId, path) {
  return api(filePath(sessionId, 'meta', path));
}

/** 令牌只放请求头：URL 可能进日志，也可能被系统组件转发。 */
export function fileContentRequest(sessionId, path) {
  return {
    url: `${baseUrl}${filePath(sessionId, 'content', path)}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/** Android WebView 不能渲染 PDF，按无法预览处理。 */
export function previewKindFor(meta, platform) {
  return meta.previewKind === 'pdf' && platform !== 'ios' ? 'none' : meta.previewKind;
}

/** 无法预览的文件和大文件都等用户点按钮后才传内容。 */
export const autoDownloads = (kind, sizeBytes) => kind !== 'none' && sizeBytes <= ASK_BEFORE_DOWNLOAD_BYTES;

/** 路径分隔符不能进临时文件名，否则文件会写到预览目录之外。 */
export const tempFileName = (name) => String(name || 'file').replace(/[/\\\0]/g, '_');

/** 截断处落在多字节字符中间时退回到字符边界，避免末尾出现乱码。 */
export function utf8SafeLength(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end === 0) return bytes.length;
  const lead = bytes[end - 1];
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - end + 1 === expected ? bytes.length : end - 1;
}

/** 超长文本放进单个 Text 在 iOS 上会显示空白，按行切块交给列表渲染。 */
export function textChunks(text, linesPerChunk = 200) {
  const lines = text.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    chunks.push(lines.slice(i, i + linesPerChunk).join('\n'));
  }
  return chunks;
}

const fileUrlKey = (url) => {
  const path = url.replace(/^file:\/\//i, '').replace(/[?#].*$/, '').replace(/^\/private\/var\//, '/var/');
  try { return decodeURIComponent(path); } catch { return path; }
};

/**
 * 预览页的导航规则，返回 allow / external / block。HTML 是 Agent 生成的不可信内容：
 * 留在预览里的只有文件自身和页内地址，外部链接交给系统浏览器。
 * iOS 只放行真实点击，防止页面一打开就跳到浏览器；Android 拿不到导航类型。
 */
export function previewNavigation(req, fileUri, platform) {
  const url = req.url || '';
  if (/^(?:about|blob|data):/i.test(url)) return 'allow';
  if (/^file:/i.test(url)) return fileUrlKey(url) === fileUrlKey(fileUri) ? 'allow' : 'block';
  if (!/^https?:/i.test(url)) return 'block';
  if (req.isTopFrame === false) return 'allow';
  if (platform === 'ios' && req.navigationType !== 'click') return 'block';
  return 'external';
}
