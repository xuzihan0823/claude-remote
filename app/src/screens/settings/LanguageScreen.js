import { haptics } from '../../lib/haptics.js';
import { useI18n } from '../../lib/i18n.js';
import { setPref, usePref } from '../../lib/prefs.js';
import { Group, Row, SettingsPage } from './ui.js';

// 语言名用各自语言的写法（中文 / English），不随当前语言翻译；只有「跟随系统」需要翻译。
const OPTIONS = [
  ['system', '跟随系统'],
  ['zh', '中文'],
  ['en', 'English'],
];

export function LanguageScreen() {
  const { t } = useI18n();
  const locale = usePref('locale');
  const pick = (k) => {
    if (locale === k) return;
    haptics.selection();
    setPref('locale', k);
  };
  return (
    <SettingsPage title={t('语言')}>
      <Group title={t('语言')}>
        {OPTIONS.map(([k, label]) => (
          <Row key={k} label={k === 'system' ? t(label) : label} checked={locale === k} onPress={() => pick(k)} />
        ))}
      </Group>
    </SettingsPage>
  );
}
