import { defaultModelDescription, findModel, modelMainName, modelValue } from '../../../../web/core/api.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { setPref, usePref } from '../../lib/prefs.js';
import { Group, Row, SettingsPage } from './ui.js';

export function DefaultModelScreen() {
  const catalog = useModelCatalog();
  const value = usePref('defaultModel');
  const models = catalog?.models || [];
  const sel = findModel(models, value);
  return (
    <SettingsPage title="默认模型">
      <Group footer="新对话默认用这个模型，发消息时仍可以临时切换。选择“跟随项目默认”时，实际运行遵循当前项目配置。">
        <Row label="跟随项目默认" sub={defaultModelDescription(catalog)} checked={!value} onPress={() => setPref('defaultModel', '')} />
        {models.map((m) => {
          const v = modelValue(m);
          const on = !!(sel && sel.alias === m.alias && sel.id === m.id);
          return (
            <Row key={v} label={modelMainName(m)} sub={m.alias && m.alias !== m.id ? `别名 ${m.alias}` : undefined} checked={on} onPress={() => setPref('defaultModel', v)} />
          );
        })}
      </Group>
    </SettingsPage>
  );
}
