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
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={{
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: active ? colors.accent : colors.line,
      }}
    >
      <Text style={{ color: active ? colors.accent : colors.ink, fontSize: 12 }}>
        {MODE_LABELS[mode] || '标准'}
      </Text>
    </TouchableOpacity>
  );
}
