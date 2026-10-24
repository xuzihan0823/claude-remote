import { useState } from 'react';
import { Alert } from 'react-native';
import { bus } from '../../../../web/core/bus.js';
import { getNewSessionMode, PERMISSION_MODES, setNewSessionMode } from '../../../../web/core/modes.js';
import { Group, Row, SettingsPage } from './ui.js';
import { MODE_LABELS, MODE_SUBS } from './labels.js';

export function PermissionModeScreen() {
  const [mode, setMode] = useState(getNewSessionMode);
  const apply = (m) => {
    setNewSessionMode(m);
    setMode(m);
    bus.emit('new-session-mode', m);
  };
  const pick = (m) => {
    if (m === mode) return;
    if (m !== 'bypassPermissions') { apply(m); return; }
    Alert.alert('默认使用 Bypass？', '新对话里 Claude 将不再请求任何审批，直接执行所有操作（含文件修改与命令执行）。', [
      { text: '取消', style: 'cancel' },
      { text: '确定', style: 'destructive', onPress: () => apply(m) },
    ]);
  };
  return (
    <SettingsPage title="默认权限模式">
      <Group footer="只影响新建的对话；已有对话保持各自的模式。">
        {PERMISSION_MODES.map((m) => (
          <Row key={m} label={MODE_LABELS[m]} sub={MODE_SUBS[m]} checked={mode === m} tone={m === 'bypassPermissions' ? 'danger' : undefined} onPress={() => pick(m)} />
        ))}
      </Group>
    </SettingsPage>
  );
}
