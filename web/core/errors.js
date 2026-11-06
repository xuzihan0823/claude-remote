import { t } from './i18n.js';

export function apiErrReason(e, fallback = '请求失败') {
  const code = typeof e === 'string' ? e : e?.code;
  const status = typeof e === 'object' && e ? e.status : 0;
  if (code === 'session_not_found') return t('会话不存在');
  if (code === 'not_found' || status === 404) return t('目标不存在');
  if (code === 'attachment_read_failed') return t('无法读取文件');
  if (code === 'network_timeout' || code === 'upstream_timeout' || code === 'idle_timeout' || status === 504) return t('连接超时');
  if (code === 'network_error') return t('网络不可达');
  if (code === 'device_offline' || code === 'device_disconnected') return t('设备离线');
  if (code === 'too_many_streams') return t('连接繁忙');
  if (code === 'upstream_reset' || code === 'upstream_protocol_error' || code === 'relay_closing' || status === 502 || status === 503) return t('中继不可用');
  if (code === 'payload_too_large' || status === 413) return t('内容超过大小限制');
  if (code === 'invalid_session_id' || code === 'invalid_before_seq' || code === 'invalid_query' || code === 'invalid_json' || code === 'bad_request' || status === 400) return t('参数无效');
  if (code === 'internal' || status >= 500) return t('服务异常');
  return t(fallback);
}

export function scopeErrMsg(scope, e, fallback = '请求失败') {
  return t('{scope}：{reason}', { scope: t(scope), reason: apiErrReason(e, fallback) });
}

export function runErrMsg(raw) {
  const text = String(raw || '').trim();
  if (!text) return t('模型运行：运行中断');
  if (/(?:^|\b)(?:401|403)\b|unauthorized|authentication|invalid[\s_-]*api[\s_-]*key|permission_error/i.test(text)) {
    return t('模型运行：鉴权失败');
  }
  if (/(?:^|\b)404\b|model[\s_-]*not[\s_-]*found|not_found_error/i.test(text)) {
    return t('模型运行：模型不可用');
  }
  if (/(?:^|\b)429\b|rate[\s_-]*limit|too many requests|quota/i.test(text)) {
    return t('模型运行：请求过于频繁');
  }
  if (/(?:^|\b)(?:500|502|503|504|529)\b|overloaded|internal server error|bad gateway|service unavailable/i.test(text)) {
    return t('模型运行：服务繁忙');
  }
  if (/timed?\s*out|etimedout|econnreset|econnrefused|fetch failed|network_error|network_timeout/i.test(text)) {
    return t('模型运行：连接中断');
  }
  const firstLine = text.replace(/^(?:API\s+Error|Error)\s*:\s*/i, '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return t('模型运行：运行中断');
  const short = firstLine.length > 44 ? `${firstLine.slice(0, 44)}…` : firstLine;
  return t('模型运行：{detail}', { detail: short });
}

export function approvalErrMsg(e) {
  if (e?.code === 'invalid') {
    const msg = String(e?.data?.message || '');
    if (/missing answer|answers must be/i.test(msg)) return t('审批提交：请先完成作答');
    return t('审批提交：参数无效');
  }
  return scopeErrMsg('审批提交', e, '提交失败');
}

export function connErrMsg(e) {
  const code = e?.code;
  const status = e?.status || 0;
  if (code === 'unauthorized' || status === 401) return t('设备连接：令牌不正确');
  if (code === 'device_offline' || code === 'device_disconnected') return t('设备连接：Mac 端离线');
  if (code === 'too_many_streams') return t('设备连接：连接繁忙');
  if (code === 'network_timeout' || code === 'upstream_timeout' || code === 'idle_timeout' || status === 504) return t('设备连接：连接超时');
  if (code === 'upstream_reset' || code === 'upstream_protocol_error' || code === 'relay_closing' || status === 502 || status === 503) return t('设备连接：中继不可用');
  return t('设备连接：无法连接（请检查地址或网络）');
}
