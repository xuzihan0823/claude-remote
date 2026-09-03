import { useState } from 'react';
import { Text, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBus } from '../../../web/core/bus.js';
import { useTheme } from '../theme.js';

// 移植 web/ui/components/toast.js：bus 'toast' 事件入栈，3200ms 自动移除；
// 绝对定位底部居中小胶囊堆叠（info 默认 / error 配色）；
// 外层 KeyboardStickyView 让胶囊随键盘升起骑在上方。
// 渲染在 App 根最后一个，天然置顶（zIndex 高于 ApprovalLayer/PairConfirm）。
export function ToastLayer() {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState([]);
  useBus('toast', (t) => {
    setItems((xs) => [...xs, t]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3200);
  }, []);
  if (items.length === 0) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 60,
        elevation: 60,
      }}
    >
      <KeyboardStickyView offset={{ opened: -12 }}>
        <View
          style={{
            alignItems: 'center',
            gap: 8,
            paddingBottom: insets.bottom + 12,
            paddingHorizontal: 16,
          }}
        >
          {items.map((t) => (
            <View
              key={t.id}
              style={{
                backgroundColor: t.kind === 'error' ? colors.danger : colors.inkStrong,
                borderRadius: 999,
                paddingVertical: 7,
                paddingHorizontal: 16,
                shadowColor: '#000',
                shadowOpacity: 0.18,
                shadowRadius: 7,
                shadowOffset: { width: 0, height: 4 },
                elevation: 4,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 13, fontFamily: fonts.serifCn }}>
                {t.text}
              </Text>
            </View>
          ))}
        </View>
      </KeyboardStickyView>
    </View>
  );
}
