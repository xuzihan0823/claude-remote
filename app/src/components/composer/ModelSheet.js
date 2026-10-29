import { Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { defaultModelDescription, findModel, modelMainName, modelValue } from '../../../../web/core/api.js';
import { useTheme } from '../../theme.js';

// 模型 sheet 内容；思考程度在 + 菜单里单独选择（EffortPicker）。
export function ModelSheetContent({ value, catalog, onPick }) {
  const { colors } = useTheme();
  const { models = [] } = catalog || {};
  const sel = findModel(models, value);

  const row = { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingVertical: 10, paddingHorizontal: 16 };
  const main = { color: colors.inkStrong, fontSize: 15 };
  const sub = { color: colors.ink2, fontSize: 12, marginTop: 2 };
  const check = { color: colors.accent, fontSize: 16, marginLeft: 8 };

  return (
    <BottomSheetScrollView contentContainerStyle={{ paddingBottom: 28 }}>
      <View style={{ alignItems: 'center', paddingVertical: 6 }}>
        <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13 }}>选择模型</Text>
      </View>

      <TouchableOpacity
        testID="model-option-default"
        onPress={() => onPick('')}
        accessibilityRole="button"
        accessibilityState={{ selected: !value }}
        style={row}
      >
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={main}>跟随项目默认</Text>
          <Text style={sub}>{defaultModelDescription(catalog)}</Text>
        </View>
        {!value ? <Text style={check}>✓</Text> : null}
      </TouchableOpacity>

      {models.map((m) => {
        const v = modelValue(m);
        const on = !!(sel && sel.alias === m.alias && sel.id === m.id);
        return (
          <TouchableOpacity
            key={v}
            testID={`model-option-${v}`}
            onPress={() => onPick(v)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={row}
          >
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
