import { useState } from 'react';
import { Alert } from 'react-native';
import { bus } from '../../../../web/core/bus.js';
import { getNewSessionMode, PERMISSION_MODES, setNewSessionMode } from '../../../../web/core/modes.js';
import { useI18n } from '../../lib/i18n.js';
import { Group, Row, SettingsPage } from './ui.js';
import { MODE_LABELS, MODE_SUBS } from './labels.js';

export function PermissionModeScreen() {
  const { t } = useI18n();
  const [mode, setMode] = useState(getNewSessionMode);
  const apply = (m) => {
    setNewSessionMode(m);
    setMode(m);
    bus.emit('new-session-mode', m);
  };
  const pick = (m) => {
    if (m === mode) return;
    if (m !== 'bypassPermissions') { apply(m); return; }
    Alert.alert(t('默认使用 Bypass？'), t('新对话里 Claude 将不再请求任何审批，直接执行所有操作（含文件修改与命令执行）。'), [
      { text: t('取消'), style: 'cancel' },
      { text: t('确定'), style: 'destructive', onPress: () => apply(m) },
    ]);
  };
  return (
    <SettingsPage title={t('默认权限模式')}>
      <Group footer={t('只影响新建的对话；已有对话保持各自的模式。')}>
        {PERMISSION_MODES.map((m) => (
          <Row key={m} label={t(MODE_LABELS[m])} sub={t(MODE_SUBS[m])} checked={mode === m} tone={m === 'bypassPermissions' ? 'danger' : undefined} onPress={() => pick(m)} />
        ))}
      </Group>
    </SettingsPage>
  );
}
