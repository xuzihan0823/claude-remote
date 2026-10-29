import { useEffect } from 'react';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

// 开屏时首页其它元素的渐入：透明度 0→1，同时从 dy 位移回原位。play=false 直接显示。
export function FadeIn({ play, delay = 0, dy = 8, duration = 380, style, children }) {
  const p = useSharedValue(play ? 0 : 1);
  useEffect(() => {
    if (play) p.value = withDelay(delay, withTiming(1, { duration, easing: Easing.out(Easing.cubic) }));
  }, [play]);
  const anim = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: (1 - p.value) * dy }] }));
  return <Animated.View style={[style, anim]}>{children}</Animated.View>;
}
