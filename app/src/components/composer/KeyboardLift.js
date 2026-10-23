import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';

// 贴屏幕底部的 composer 专用：直接按键盘高度垫 paddingBottom，不依赖自身位置测量。
// KAV(automaticOffset) 只在 onLayout 时异步取一次窗口坐标，冷启动 / 开屏动画期间可能拿到错的 y，
// 之后布局不变就不再重测，键盘弹起时抬升为 0，输入框被整个盖住。
// innerPad 是子层已有的底部安全区间距，键盘打开时扣掉，使总间距恰好等于键盘高度。
export function KeyboardLift({ innerPad = 0, style, children }) {
  const { height } = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(-height.value - innerPad, 0) }), [innerPad]);
  return <Animated.View style={[style, lift]}>{children}</Animated.View>;
}
