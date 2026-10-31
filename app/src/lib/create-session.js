import { api, ApiError, baseUrl, token } from '../../../web/core/api.js';
import { newClientMessageId } from '../../../web/core/message-delivery.js';
import { uploadAttachments, withAttachmentNote } from './attachments.js';

export async function createSession({ cwd, text, model, effort, mode, files, onProgress, request = {} }) {
  const requestBase = baseUrl;
  const requestToken = token;
  const checkConnection = () => {
    if (requestBase !== baseUrl || requestToken !== token) throw new ApiError(0, 'connection_changed');
  };
  request.clientMessageId ??= newClientMessageId();
  if (!request.body) {
    const uploaded = await uploadAttachments(files, '/api/upload', { onProgress });
    checkConnection();
    request.body = {
      cwd, text: withAttachmentNote(text, uploaded), clientMessageId: request.clientMessageId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(mode !== 'default' ? { permissionMode: mode } : {}),
    };
  }
  const body = request.body;
  const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
  checkConnection();
  return { result, body };
}
