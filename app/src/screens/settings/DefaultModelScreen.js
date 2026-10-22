import { findModel, modelMainName, modelValue, resolveDefaultName } from '../../../../web/core/api.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { setPref, usePref } from '../../lib/prefs.js';
import { Group, Row, SettingsPage } from './ui.js';

export function DefaultModelScreen() {
  const catalog = useModelCatalog();
  const value = usePref('defaultModel');
  const models = catalog?.models || [];
  const sel = findModel(models, value);
  const defName = resolveDefaultName(catalog);
  return (
    <SettingsPage title="默认模型">
      <Group footer="新对话默认用这个模型，发消息时仍可以临时切换。">
        <Row label="跟随 Mac 默认" sub={defName ? `当前 ${defName}` : '使用 Mac settings.json 的默认模型'} checked={!value} onPress={() => setPref('defaultModel', '')} />
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
