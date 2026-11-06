import { haptics } from '../../lib/haptics.js';
import { useI18n } from '../../lib/i18n.js';
import { APPEARANCE_LABELS, setPref, usePref } from '../../lib/prefs.js';
import { Group, Row, SettingsPage } from './ui.js';

export function AppearanceScreen() {
  const { t } = useI18n();
  const appearance = usePref('appearance');
  const codeWrap = usePref('codeWrap');
  const showThinking = usePref('showThinking');
  const toolsExpanded = usePref('toolsExpanded');
  const pickAppearance = (k) => {
    if (appearance === k) return;
    haptics.selection();
    setPref('appearance', k);
  };
  return (
    <SettingsPage title={t('外观')}>
      <Group title={t('主题')}>
        {['system', 'light', 'dark'].map((k) => (
          <Row key={k} label={t(APPEARANCE_LABELS[k])} checked={appearance === k} onPress={() => pickAppearance(k)} />
        ))}
      </Group>
      <Group title={t('消息')}>
        <Row icon="wrap" label={t('代码自动换行')} toggle={!!codeWrap} onToggle={(v) => setPref('codeWrap', v)} />
        <Row icon="brain" label={t('显示思考过程')} toggle={showThinking !== false} onToggle={(v) => setPref('showThinking', v)} />
        <Row icon="tool" label={t('默认展开工具调用')} toggle={!!toolsExpanded} onToggle={(v) => setPref('toolsExpanded', v)} />
      </Group>
    </SettingsPage>
  );
}
