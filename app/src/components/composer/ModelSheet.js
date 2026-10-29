import { Text, TouchableOpacity, View } from 'react-native';
import { defaultModelDescription, findModel, modelMainName, modelValue } from '../../../../web/core/api.js';
import { useTheme } from '../../theme.js';

export function buildModelMenuItems({ value, catalog, onPick }) {
  const { models = [] } = catalog || {};
  const sel = findModel(models, value);
  return [
    {
      key: 'default',
      label: '跟随项目默认',
      detail: defaultModelDescription(catalog),
      selected: !value,
      testID: 'model-option-default',
      accessibilityRole: 'button',
      onPress: () => onPick?.(''),
    },
    ...models.map((m) => {
      const v = modelValue(m);
      const on = !!(sel && sel.alias === m.alias && sel.id === m.id);
      return {
        key: v,
        label: modelMainName(m),
        detail: m.alias && m.alias !== m.id ? `别名 ${m.alias}` : undefined,
        selected: on,
        testID: `model-option-${v}`,
        accessibilityRole: 'button',
        onPress: () => onPick?.(v),
      };
    }),
  ];
}

// 模型列表内容；思考程度在 + 菜单里单独选择（EffortPicker）。
export function ModelSheetContent({ value, catalog, onPick }) {
  const { colors } = useTheme();
  const items = buildModelMenuItems({ value, catalog, onPick });
  const row = { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingVertical: 10, paddingHorizontal: 16 };
  const main = { color: colors.inkStrong, fontSize: 15 };
  const sub = { color: colors.ink2, fontSize: 12, marginTop: 2 };
  const check = { color: colors.accent, fontSize: 16, marginLeft: 8 };

  return (
    <View style={{ paddingBottom: 8 }}>
      <View style={{ alignItems: 'center', paddingVertical: 6 }}>
        <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13 }}>选择模型</Text>
      </View>
      {items.map((item) => (
        <TouchableOpacity
          key={item.key}
          testID={item.testID}
          onPress={item.onPress}
          accessibilityRole="button"
          accessibilityState={{ selected: item.selected }}
          style={row}
        >
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={main}>{item.label}</Text>
            {item.detail ? <Text style={sub}>{item.detail}</Text> : null}
          </View>
          {item.selected ? <Text style={check}>✓</Text> : null}
        </TouchableOpacity>
      ))}
    </View>
  );
}
