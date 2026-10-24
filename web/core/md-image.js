// Markdown 图片地址解析：web 与 RN 共用。
//  - http(s)/data: 直接用；指向 localhost / 127.0.0.1 的改写成当前 Mac 的主机名（手机上 localhost 是手机自己）
//  - 本机路径（/abs、~/、./rel、file://）走 daemon 的 /api/sessions/:id/file，带 Bearer 鉴权
//  - 其他（相对 URL 但不是图片、javascript: 等）返回 null，调用方退化成链接
import { baseUrl, connHost, token } from './api.js';

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;

/**
 * @returns {{ uri: string, headers?: Record<string,string>, local: boolean } | null}
 */
export function resolveImageSrc(src, { sessionId, base = baseUrl, tok = token, host = connHost() } = {}) {
  const s = String(src || '').trim();
  if (!s || /^\s*javascript:/i.test(s)) return null;
  if (/^data:image\//i.test(s)) return { uri: s, local: false };
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const macHost = String(host || '').replace(/:\d+$/, '');
      if (LOOPBACK.test(u.hostname) && macHost && !LOOPBACK.test(macHost)) {
        u.hostname = macHost.replace(/^\[|\]$/g, '');
        return { uri: u.toString(), local: false };
      }
    } catch { return null; }
    return { uri: s, local: false };
  }
  // 本机路径
  const path = s.startsWith('file://') ? s : s.replace(/[?#].*$/, '');
  let decoded = path;
  try { decoded = decodeURI(path); } catch { /* 保持原样 */ }
  if (!IMG_EXT.test(decoded.replace(/^file:\/\//, '')) || !sessionId) return null;
  const prefix = base ? base.replace(/\/+$/, '') : '';
  return {
    uri: `${prefix}/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(decoded)}`,
    headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
    local: true,
  };
}
