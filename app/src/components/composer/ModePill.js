import { Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../../theme.js';

const MODE_LABELS = { default: '标准', acceptEdits: '自动编辑', plan: '规划', bypassPermissions: 'Bypass' };

// 模式 pill：非 default 时 accent 边高亮。点击 onOpen 打开 sheet。
// 对应 web/ui/components/mode-sheet.js 的 ModePill。
export function ModePill({ mode, onOpen }) {
  const { colors } = useTheme();
  const active = mode !== 'default';
  return (
    <TouchableOpacity
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`权限模式：${MODE_LABELS[mode] || '标准'}`}
      style={{
        borderRadius: 22,
        borderCurve: 'continuous',
        paddingHorizontal: 12,
        paddingVertical: 10,
        minHeight: 44,
        justifyContent: 'center',
        backgroundColor: active ? colors.glassTintAccent : colors.controlFill,
        borderWidth: 1,
        borderColor: active ? colors.glassBorderAccent : colors.controlBorder,
      }}
    >
      <Text style={{ color: active ? colors.accent : colors.ink, fontSize: 12.5, fontWeight: active ? '600' : '500' }}>
        {MODE_LABELS[mode] || '标准'}
      </Text>
    </TouchableOpacity>
  );
}
