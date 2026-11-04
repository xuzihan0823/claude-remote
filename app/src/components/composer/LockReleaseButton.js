import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { toast } from '../../../../web/core/bus.js';
import { haptics } from '../../lib/haptics.js';
import { useTheme } from '../../theme.js';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const SIZE = 44;
const STROKE = 2.5;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;
const HOLD_MS = 1200;

// 终端占用时的解锁键：按住让红圈绕锁走满一圈才解除，松手即回退，避免误触抢走终端里正在用的会话
export function LockReleaseButton({ onRelease }) {
  const { colors } = useTheme();
  const progress = useSharedValue(0);
  const [busy, setBusy] = useState(false);
  const ringProps = useAnimatedProps(() => ({ strokeDashoffset: CIRC * (1 - progress.value) }));

  const release = async () => {
    setBusy(true);
    try {
      await onRelease();
    } finally {
      setBusy(false);
      progress.value = 0;
    }
  };
  const holdStart = () => {
    if (busy) return;
    haptics.selection();
    progress.value = withTiming(1, { duration: HOLD_MS * (1 - progress.value), easing: Easing.linear }, (finished) => {
      if (finished) runOnJS(release)();
    });
  };
  const holdEnd = () => {
    if (busy || progress.value >= 1) return;
    progress.value = withTiming(0, { duration: 200 });
  };

  return (
    <Pressable
      onPressIn={holdStart}
      onPressOut={holdEnd}
      onPress={() => { if (!busy) toast('按住锁直到红圈走满，解除终端占用', 'info'); }}
      onLongPress={() => {}}
      delayLongPress={300}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="解除终端占用"
      accessibilityHint="按住直到圆圈走满"
      accessibilityState={{ busy }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={() => { if (!busy) release(); }}
      style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}
    >
      {busy ? <ActivityIndicator size="small" color={colors.danger} /> : (
        <View>
          <Svg width={SIZE} height={SIZE} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
            <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke={colors.danger} strokeOpacity={0.2} strokeWidth={STROKE} fill="none" />
            <AnimatedCircle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke={colors.danger} strokeWidth={STROKE} fill="none"
              strokeLinecap="round" strokeDasharray={`${CIRC} ${CIRC}`} animatedProps={ringProps} />
          </Svg>
          <Svg width={SIZE} height={SIZE} viewBox="-10 -10 44 44">
            <Path d="M8 11V8a4 4 0 0 1 8 0v3" stroke={colors.danger} strokeWidth={2} strokeLinecap="round" fill="none" />
            <Rect x={5.5} y={11} width={13} height={9.5} rx={2.5} fill={colors.danger} />
            <Path d="M12 14.5v2.5" stroke={colors.bg} strokeWidth={2} strokeLinecap="round" />
          </Svg>
        </View>
      )}
    </Pressable>
  );
}
