import { useState } from 'react';
import { Linking, Text } from 'react-native';
import appJson from '../../../app.json';
import { findModel, modelMainName } from '../../../../web/core/api.js';
import { getNewSessionMode } from '../../../../web/core/modes.js';
import { useBus } from '../../../../web/core/bus.js';
import { useDevices } from '../../lib/useDevices.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { useI18n } from '../../lib/i18n.js';
import { APPEARANCE_LABELS, fontScaleLabel, setPref, usePref } from '../../lib/prefs.js';
import { useTheme } from '../../theme.js';
import { Group, Row, SettingsPage } from './ui.js';
import { MODE_LABELS, REPO_URL } from './labels.js';

export function SettingsHome({ navigation }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { list, current } = useDevices();
  const cur = list.find((d) => d.id === current);
  const appearance = usePref('appearance');
  const fontScale = usePref('fontScale');
  const haptics = usePref('haptics');
  const defaultModel = usePref('defaultModel');
  const locale = usePref('locale');
  const catalog = useModelCatalog();
  const [mode, setMode] = useState(getNewSessionMode);
  useBus('new-session-mode', setMode, []);
  const m = findModel(catalog?.models || [], defaultModel);
  const version = appJson?.expo?.version || '';
  // 语言名用各自语言写法，不随界面语言翻译。
  const localeName = locale === 'zh' ? '中文' : locale === 'en' ? 'English' : t('跟随系统');

  return (
    <SettingsPage title={t('设置')} left="close">
      <Group title={t('连接方式')}>
        <Row
          icon="laptop"
          label={t('设备')}
          value={cur ? cur.name : t('未连接')}
          dot={cur ? colors.ok : colors.ink3}
          onPress={() => navigation.navigate('Devices')}
        />
      </Group>

      <Group title={t('应用')}>
        <Row icon="appearance" label={t('外观')} value={t(APPEARANCE_LABELS[appearance])} onPress={() => navigation.navigate('Appearance')} />
        <Row icon="textSize" label={t('字体大小')} value={t(fontScaleLabel(fontScale))} onPress={() => navigation.navigate('FontSize')} />
        <Row icon="globe" label={t('语言')} value={localeName} onPress={() => navigation.navigate('Language')} />
        <Row icon="spark" label={t('默认模型')} value={defaultModel ? (m ? modelMainName(m) : defaultModel) : t('跟随 Mac')} onPress={() => navigation.navigate('DefaultModel')} />
        <Row icon="shieldCheck" label={t('默认权限模式')} value={t(MODE_LABELS[mode])} onPress={() => navigation.navigate('PermissionMode')} />
        <Row icon="haptic" label={t('触感反馈')} toggle={haptics !== false} onToggle={(v) => setPref('haptics', v)} />
      </Group>

      <Group title={t('关于')}>
        <Row icon="help" label={t('快速上手')} onPress={() => navigation.navigate('QuickStart')} />
        <Row icon="github" label="GitHub" onPress={() => Linking.openURL(REPO_URL).catch(() => {})} />
      </Group>

      {version ? <Text style={{ textAlign: 'center', color: colors.ink3, fontSize: 12.5 }}>Claude Remote {version}</Text> : null}
    </SettingsPage>
  );
}
