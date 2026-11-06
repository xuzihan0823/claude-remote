import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBus } from '../../../web/core/bus.js';
import { useTheme } from '../theme.js';
import { useI18n } from '../lib/i18n.js';
import { Icon } from './Icon.js';

const INFO_DURATION_MS = 3200;
const ERROR_DURATION_MS = 4800;

function ToastCapsule({ item, colors, fonts, onDismiss }) {
  const { t } = useI18n();
  const isError = item.kind === 'error';
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (!reduceMotion) {
      p.value = withSpring(1, { damping: 18, stiffness: 220, mass: 0.7 });
    }
  }, [p, reduceMotion]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [
      { translateY: (1 - p.value) * -16 },
      { scale: 0.94 + 0.06 * p.value },
    ],
  }));

  return (
    <Animated.View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          maxWidth: '92%',
          backgroundColor: isError ? colors.danger : colors.inkStrong,
          borderRadius: 999,
          borderCurve: 'continuous',
          paddingVertical: 8,
          paddingLeft: 16,
          paddingRight: isError ? 10 : 16,
          shadowColor: '#000',
          shadowOpacity: 0.18,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
          elevation: 4,
        },
        animStyle,
      ]}
    >
      <Text
        numberOfLines={2}
        style={{ color: '#fff', fontSize: 13, lineHeight: 18, fontFamily: fonts.serifCn, flexShrink: 1 }}
      >
        {item.text}
      </Text>
      {isError ? (
        <Pressable
          onPress={() => onDismiss(item.id)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('关闭错误提示')}
          style={({ pressed }) => ({
            width: 22,
            height: 22,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.12)',
          })}
        >
          <Icon name="close" size={12} color="#fff" strokeWidth={2.3} />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

// 顶部居中小胶囊堆叠（info 默认 / error 危险色 + 可关闭按钮）。
// 渲染在 App 根最后一个，天然置顶（zIndex 高于 ApprovalLayer/PairConfirm）。
export function ToastLayer() {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState([]);
  const timersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timersRef.current.get(id));
    timersRef.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  useBus('toast', (t) => {
    const duration = t.kind === 'error' ? ERROR_DURATION_MS : INFO_DURATION_MS;
    setItems((xs) => {
      const existing = xs.find((x) => x.text === t.text && x.kind === t.kind);
      const targetId = existing ? existing.id : t.id;
      clearTimeout(timersRef.current.get(targetId));
      timersRef.current.set(targetId, setTimeout(() => dismiss(targetId), duration));
      return existing ? xs : [...xs, t];
    });
  }, [dismiss]);

  if (items.length === 0) return null;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        zIndex: 60,
        elevation: 60,
      }}
    >
      <View
        pointerEvents="box-none"
        style={{
          alignItems: 'center',
          gap: 8,
          paddingTop: insets.top + 8,
          paddingHorizontal: 16,
        }}
      >
        {items.map((t) => (
          <ToastCapsule key={t.id} item={t} colors={colors} fonts={fonts} onDismiss={dismiss} />
        ))}
      </View>
    </View>
  );
}
