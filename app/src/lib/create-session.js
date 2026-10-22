import { api, ApiError, baseUrl, token } from '../../../web/core/api.js';
import { uploadAttachments, withAttachmentNote } from './attachments.js';

export async function createSession({ cwd, text, model, mode, files, onProgress }) {
  const requestBase = baseUrl;
  const requestToken = token;
  const checkConnection = () => {
    if (requestBase !== baseUrl || requestToken !== token) throw new ApiError(0, 'connection_changed');
  };
  const uploaded = await uploadAttachments(files, '/api/upload', { onProgress });
  text = withAttachmentNote(text, uploaded);
  checkConnection();
  const body = { cwd, text, ...(model ? { model } : {}), ...(mode !== 'default' ? { permissionMode: mode } : {}) };
  const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
  checkConnection();
  return { result, body };
}
