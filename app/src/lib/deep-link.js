// claude-remote:// 深链解析（推送点击、扫码配对共用）：
//   claude-remote://setup?token=…&bases=…            配对（见 pairing.js）
//   claude-remote://approval/<interactionId>?session=<sessionId>   daemon 推送：待审批
//   claude-remote://session/<sessionId>               daemon 推送：运行完成 / 出错
import { parseSetupLink } from './pairing.js';

function parts(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'claude-remote:') return null;
  // RN 的 URL 实现对自定义 scheme 的 host 处理不一，host 为空时从 pathname 取
  const path = `${u.host || ''}${u.pathname || ''}`.replace(/^\/+/, '').replace(/\/+$/, '');
  const segs = path.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const query = {};
  for (const kv of (u.search || '').replace(/^\?/, '').split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) {
      try { query[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch { /* skip */ }
    }
  }
  return { segs, query };
}

/** 返回 {type:'setup',…} | {type:'approval', interactionId, sessionId} | {type:'session', sessionId} | null */
export function parseDeepLink(url) {
  if (!url || !url.startsWith('claude-remote:')) return null;
  const p = parts(url);
  if (!p) return null;
  const [head, id] = p.segs;
  if (head === 'setup') {
    const req = parseSetupLink(url);
    return req ? { type: 'setup', ...req } : null;
  }
  if (head === 'approval' && id) {
    return { type: 'approval', interactionId: id, sessionId: p.query.session || null };
  }
  if (head === 'session' && id) return { type: 'session', sessionId: id };
  return null;
}
