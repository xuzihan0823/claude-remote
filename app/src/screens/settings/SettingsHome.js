import { useState } from 'react';
import { Linking, Text } from 'react-native';
import appJson from '../../../app.json';
import { findModel, modelMainName } from '../../../../web/core/api.js';
import { getNewSessionMode } from '../../../../web/core/modes.js';
import { useBus } from '../../../../web/core/bus.js';
import { useDevices } from '../../lib/useDevices.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { APPEARANCE_LABELS, fontScaleLabel, setPref, usePref } from '../../lib/prefs.js';
import { useTheme } from '../../theme.js';
import { Group, Row, SettingsPage } from './ui.js';
import { MODE_LABELS, REPO_URL } from './labels.js';

export function SettingsHome({ navigation }) {
  const { colors } = useTheme();
  const { list, current } = useDevices();
  const cur = list.find((d) => d.id === current);
  const appearance = usePref('appearance');
  const fontScale = usePref('fontScale');
  const haptics = usePref('haptics');
  const defaultModel = usePref('defaultModel');
  const catalog = useModelCatalog();
  const [mode, setMode] = useState(getNewSessionMode);
  useBus('new-session-mode', setMode, []);
  const m = findModel(catalog?.models || [], defaultModel);
  const version = appJson?.expo?.version || '';

  return (
    <SettingsPage title="设置" left="close" right={{ icon: 'info', label: '快速上手', onPress: () => navigation.navigate('QuickStart') }}>
      <Group title="连接">
        <Row
          icon="laptop"
          label="设备"
          value={cur ? cur.name : '未连接'}
          dot={cur ? colors.ok : colors.ink3}
          onPress={() => navigation.navigate('Devices')}
        />
        <Row icon="qr" label="添加设备" onPress={() => navigation.navigate('AddDevice')} />
      </Group>

      <Group title="应用">
        <Row icon="appearance" label="外观" value={APPEARANCE_LABELS[appearance]} onPress={() => navigation.navigate('Appearance')} />
        <Row icon="textSize" label="字体大小" value={fontScaleLabel(fontScale)} onPress={() => navigation.navigate('FontSize')} />
        <Row icon="spark" label="默认模型" value={defaultModel ? (m ? modelMainName(m) : defaultModel) : '跟随 Mac'} onPress={() => navigation.navigate('DefaultModel')} />
        <Row icon="shieldCheck" label="默认权限模式" value={MODE_LABELS[mode]} onPress={() => navigation.navigate('PermissionMode')} />
        <Row icon="haptic" label="触感反馈" toggle={haptics !== false} onToggle={(v) => setPref('haptics', v)} />
      </Group>

      <Group title="关于">
        <Row icon="help" label="快速上手" onPress={() => navigation.navigate('QuickStart')} />
        <Row icon="github" label="GitHub" onPress={() => Linking.openURL(REPO_URL).catch(() => {})} />
      </Group>

      {version ? <Text style={{ textAlign: 'center', color: colors.ink3, fontSize: 12.5 }}>Claude Remote {version}</Text> : null}
    </SettingsPage>
  );
}
