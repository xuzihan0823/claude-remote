// Markdown 图片地址解析：web 与 RN 共用。
//  - 远程 http(s): 直接返回（local: false），RN 默认展示占位、用户点击后才请求；loopback 地址退化为链接（返回 null）
//  - raster data:image/* 直接返回（不含 svg）
//  - 本机路径（/abs、~/、./rel、file://）走 daemon 的 GET /api/sessions/:id/file，带 Bearer 鉴权（兼容直连与 relay base）
//  - 其他（svg、非图片扩展名、无会话、危险协议等）返回 null，调用方退化成链接
import { baseUrl, normalizeBase, token } from './api.js';

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;
const DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp|heic|heif|avif)[;,]/i;
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i;

/**
 * @returns {{ uri: string, headers?: Record<string,string>, local: boolean } | null}
 */
export function resolveImageSrc(src, { sessionId, base = baseUrl, tok = token } = {}) {
  const s = String(src || '').trim();
  if (!s || /^\s*javascript:/i.test(s)) return null;
  if (DATA_IMG.test(s)) return { uri: s, local: false };
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase();
      if (LOOPBACK.test(host) || host.endsWith('.localhost')) return null;
      if (/\.svg$/i.test(u.pathname)) return null;
    } catch { return null; }
    return { uri: s, local: false };
  }
  if (/^(?!file:\/\/)[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  // 本机路径
  const path = s.startsWith('file://') ? s : s.replace(/[?#].*$/, '');
  let decoded = path;
  try { decoded = decodeURI(path); } catch { /* 保持原样 */ }
  if (!IMG_EXT.test(decoded.replace(/^file:\/\//i, '')) || !sessionId) return null;
  const prefix = base ? normalizeBase(base) : '';
  return {
    uri: `${prefix}/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(decoded)}`,
    headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
    local: true,
  };
}
