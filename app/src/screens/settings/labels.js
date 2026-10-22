export const MODE_LABELS = { default: '标准', acceptEdits: '自动编辑', plan: '规划', bypassPermissions: 'Bypass' };
export const MODE_SUBS = {
  default: '每个操作都要你审批（默认）',
  acceptEdits: '文件修改自动同意，命令仍需审批',
  plan: '只读，先出方案不动手',
  bypassPermissions: '全自动，不再请求任何审批，危险',
};
export const REPO_URL = 'https://github.com/xuzihan0823/claude-remote';

export function agoText(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
