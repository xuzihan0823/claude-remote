import { Text, View } from 'react-native';
import { useTheme } from '../theme.js';
import { STATUS_LABEL, statusColor } from '../lib/format.js';

// 会话状态胶囊：小圆点 + STATUS_LABEL 文案，12px，bubble 底。无 status 渲染 null。
// 对应 web/ui/components/conn-bar.js 的 StatusBadge（CSS .badge.dot-*）。
export function StatusBadge({ status }) {
  const { colors } = useTheme();
  if (!status) return null;
  const dot = statusColor(colors, status) || colors.ink3;
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center',
      backgroundColor: colors.bubble, borderRadius: 10,
      paddingHorizontal: 8, paddingVertical: 3,
    }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, marginRight: 6, backgroundColor: dot }} />
      <Text style={{ color: colors.ink, fontSize: 12 }}>{STATUS_LABEL[status] || status}</Text>
    </View>
  );
}
