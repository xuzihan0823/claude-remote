import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme.js';

const DOT = 6;
const GAP = 5;
const AMP = 2.5;
const PERIOD_MS = 1200;
const TWO_PI = Math.PI * 2;
// 从「左右高、中间最低」这一帧开始；减弱动态效果时也停在这一帧
const START = (TWO_PI * 5) / 6;

function Dot({ index, phase, color }) {
  const style = useAnimatedStyle(() => {
    // 三个点相位依次落后 1/3 圈，波峰从左往右传
    const v = Math.cos(phase.value - (index * TWO_PI) / 3);
    return {
      opacity: 0.75 + 0.25 * v,
      transform: [{ translateY: -AMP * v }, { scale: 0.9 + 0.1 * v }],
    };
  });
  return <Animated.View style={[{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: color }, style]} />;
}

export function TypingDots({ style }) {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const phase = useSharedValue(START);

  useEffect(() => {
    if (reduceMotion) return undefined;
    phase.value = withRepeat(withTiming(START + TWO_PI, { duration: PERIOD_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(phase);
  }, [reduceMotion]);

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: GAP, height: DOT + AMP * 2 + 4 }, style]}>
      {[0, 1, 2].map((i) => <Dot key={i} index={i} phase={phase} color={colors.accent} />)}
    </View>
  );
}
