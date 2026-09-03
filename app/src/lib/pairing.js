import { normalizeBase } from '../../../web/core/api.js';

// 从 web/ui/app.js 复制的纯函数（迁移计划 §2：可搬进 core 或复制，web 端保持原样）
export function parseSetupLink(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'claude-remote:') return null;
  const where = (u.host || u.pathname.replace(/^\/+/, '')).replace(/\/+$/, '');
  if (where !== 'setup') return null;
  const params = {};
  for (const kv of (u.search.startsWith('?') ? u.search.slice(1) : u.search).split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1);
  }
  let tok = '';
  let bases = [];
  try {
    tok = decodeURIComponent(params.token || '');
    bases = (params.bases || '').split(',').filter(Boolean)
      .map((s) => normalizeBase(decodeURIComponent(s))).filter(Boolean);
  } catch { return null; }
  if (!tok || bases.length === 0) return null;
  return { token: tok, bases };
}
