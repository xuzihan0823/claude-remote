import { Alert } from 'react-native';
import { PERMISSION_MODES } from '../../../../web/core/modes.js';
import { GlassMenu } from '../GlassMenu.js';
import { useI18n, t as translate } from '../../lib/i18n.js';

// 从非 bypass 切到 bypass 时 Alert.alert 二次确认（destructive）。
export const MODE_LABELS = { default: '标准', acceptEdits: '自动编辑', plan: '规划', auto: '自动审核', bypassPermissions: 'Bypass' };
export const MODE_SUBS = {
  default: '逐项审批（默认）',
  acceptEdits: '自动同意文件编辑',
  plan: '只读规划模式',
  auto: '由模型审核操作，必要时仍需确认',
  bypassPermissions: '全自动，危险',
};
const BYPASS_CONFIRM_TEXT =
  'Claude 将不再请求任何审批，直接执行所有操作（含文件修改与命令执行）。仅在完全信任当前任务时使用。';

export function confirmAndSelectMode(nextMode, currentMode, onSelect, tr = translate) {
  if (nextMode === 'bypassPermissions' && currentMode !== 'bypassPermissions') {
    Alert.alert(tr('启用 Bypass 模式？'), tr(BYPASS_CONFIRM_TEXT), [
      { text: tr('取消'), style: 'cancel' },
      { text: tr('启用'), style: 'destructive', onPress: () => onSelect?.('bypassPermissions') },
    ], { cancelable: true });
    return;
  }
  onSelect?.(nextMode);
}

export function buildModeMenuItems(mode, onSelect, tr = translate) {
  return PERMISSION_MODES.map((m) => ({
    key: `mode-${m}`,
    label: tr(MODE_LABELS[m]),
    detailLines: m === 'auto' ? 2 : 1,
    detail: tr(MODE_SUBS[m]),
    detailTone: m === 'bypassPermissions' ? 'danger' : undefined,
    selected: mode === m,
    testID: `mode-option-${m}`,
    onPress: () => confirmAndSelectMode(m, mode, onSelect, tr),
  }));
}

export function ModeSheet({ open, anchor, mode, onSelect, onClose }) {
  const { t } = useI18n();
  const items = buildModeMenuItems(mode, onSelect, t);
  return (
    <GlassMenu
      visible={!!open}
      anchor={anchor}
      title={t('权限模式')}
      items={items}
      onClose={onClose}
    />
  );
}
