import { View } from 'react-native';
import { useTheme } from '../../theme.js';

// 浮岛卡片壳：24px 圆角 + card 底 + line 边；disabled 时降透明度。
// 对应 web/style.css .composer-card（.disabled）。
export function ComposerCard({ disabled, children, style }) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={{
        borderRadius: radius.island,
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.line,
        paddingHorizontal: 12,
        paddingVertical: 8,
        opacity: disabled ? 0.6 : 1,
        ...(style || {}),
      }}
    >
      {children}
    </View>
  );
}
