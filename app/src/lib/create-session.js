import { api, ApiError, baseUrl, token } from '../../../web/core/api.js';

export async function createSession({ cwd, text, model, mode, files }) {
  const requestBase = baseUrl;
  const requestToken = token;
  const checkConnection = () => {
    if (requestBase !== baseUrl || requestToken !== token) throw new ApiError(0, 'connection_changed');
  };
  const uploaded = [];
  for (const f of files) {
    const blob = await (await fetch(f.uri)).blob();
    checkConnection();
    const r = await api(`/api/upload?filename=${encodeURIComponent(f.name)}`, {
      method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' },
    });
    checkConnection();
    uploaded.push(r.path);
  }
  if (uploaded.length) {
    text = `${text}\n\n[手机端上传的附件，已保存在本机，可直接读取]\n${uploaded.map((p) => `- ${p}`).join('\n')}`;
  }
  checkConnection();
  const body = { cwd, text, ...(model ? { model } : {}), ...(mode !== 'default' ? { permissionMode: mode } : {}) };
  const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
  checkConnection();
  return { result, body };
}
