import { Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { findModel, modelMainName, modelValue, resolveDefaultName } from '../../../../web/core/api.js';
import { useTheme } from '../../theme.js';

// 模型列表 sheet 内容：首项「跟随 Mac 默认（当前 x）」+ models 列表
// （主行 modelMainName、副行 别名 alias、选中 ✓）。渲染于 ModelPicker 的 BottomSheetModal 内。
// 对应 web/ui/components/model-picker.js 的 sheet-panel.model-menu。
export function ModelSheetContent({ value, catalog, onPick }) {
  const { colors } = useTheme();
  const { models = [] } = catalog || {};
  const sel = findModel(models, value);
  const defName = resolveDefaultName(catalog);

  const row = { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16 };
  const main = { color: colors.inkStrong, fontSize: 15 };
  const sub = { color: colors.ink2, fontSize: 12, marginTop: 2 };
  const check = { color: colors.accent, fontSize: 16, marginLeft: 8 };

  return (
    <BottomSheetScrollView contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ alignItems: 'center', paddingVertical: 6 }}>
        <Text style={{ color: colors.ink2, fontSize: 13 }}>选择模型</Text>
      </View>
      <TouchableOpacity onPress={() => onPick('')} style={row}>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={main}>跟随 Mac 默认</Text>
          <Text style={sub}>{defName ? `当前 ${defName}` : '使用 Mac settings.json 的默认模型'}</Text>
        </View>
        {!value ? <Text style={check}>✓</Text> : null}
      </TouchableOpacity>
      {models.map((m) => {
        const v = modelValue(m);
        const on = !!(sel && sel.alias === m.alias && sel.id === m.id);
        return (
          <TouchableOpacity key={v} onPress={() => onPick(v)} style={row}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={main}>{modelMainName(m)}</Text>
              {m.alias && m.alias !== m.id ? <Text style={sub}>别名 {m.alias}</Text> : null}
            </View>
            {on ? <Text style={check}>✓</Text> : null}
          </TouchableOpacity>
        );
      })}
    </BottomSheetScrollView>
  );
}
