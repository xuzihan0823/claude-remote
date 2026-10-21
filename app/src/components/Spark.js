import { useEffect } from 'react';
import Animated, { Easing, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Line } from 'react-native-svg';
import { useTheme } from '../theme.js';

// 移植自 web/ui/components/spark.js：15 条芒星线，坐标 / 线宽原样保留。
// web 用 stroke="currentColor" + stroke-linecap="round" 设在 <svg> 上由子线继承；
// RN 端 react-native-svg 同样支持从 <Svg> 继承 stroke / strokeLinecap 到 <Line>。
const RAYS = [
  [12, 12, 12.12, 2.61, 2.1],
  [12, 12, 15.74, 4.05, 1.87],
  [12, 12, 19.08, 5.26, 2.11],
  [12, 12, 20.5, 9.21, 2.12],
  [12, 12, 20.99, 13.22, 1.64],
  [12, 12, 20.58, 16.96, 1.93],
  [12, 12, 18, 19.28, 2.09],
  [12, 12, 14.53, 21.37, 1.52],
  [12, 12, 10.46, 20.4, 1.63],
  [12, 12, 6.11, 19.54, 1.52],
  [12, 12, 3.33, 17.48, 1.84],
  [12, 12, 2.92, 12.61, 1.81],
  [12, 12, 3.77, 9.83, 1.89],
  [12, 12, 5.43, 5.94, 1.95],
  [12, 12, 8.02, 3.85, 2.02],
];

// 品牌芒星。color 缺省走主题 accent；暗色自动随 useColorScheme 切换。
export function Spark({ size = 16, color, style }) {
  const { colors } = useTheme();
  const stroke = color ?? colors.accent;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeLinecap="round"
      style={style}
    >
      {RAYS.map(([x1, y1, x2, y2, w], i) => (
        <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={w} />
      ))}
    </Svg>
  );
}

// ── 开屏绽放版芒星 ────────────────────────────────────────────────
// 15 条光芒按顺时针依次从中心长出（每条 back-out 回弹），整体先放大 1.35 倍再回落、带一点旋转，
// 结束后与静态 Spark 完全重合，所以首页直接用它占位，不需要再切换组件。
const AnimatedLine = Animated.createAnimatedComponent(Line);
const RAY_STAGGER = 25; // ms
const RAY_DUR = 350; // ms
export const BLOOM_MS = 100 + RAYS.length * RAY_STAGGER + RAY_DUR + 200; // ≈ 1s，含开头留白与收尾

function BloomRay({ ray, index, t }) {
  const [x1, y1, x2, y2, w] = ray;
  const props = useAnimatedProps(() => {
    const local = (t.value - 100 - index * RAY_STAGGER) / RAY_DUR;
    const p = local <= 0 ? 0 : local >= 1 ? 1 : backOut(local);
    return { x2: x1 + (x2 - x1) * p, y2: y1 + (y2 - y1) * p, strokeOpacity: local <= 0 ? 0 : 1 };
  });
  return <AnimatedLine x1={x1} y1={y1} x2={x1} y2={y1} strokeWidth={w} animatedProps={props} />;
}

function backOut(x) {
  'worklet';
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/** play=false 时与 Spark 一样静止显示；play=true 时挂载即播放一次绽放。 */
export function BloomSpark({ size = 48, color, style, play, onDone }) {
  const { colors } = useTheme();
  const stroke = color ?? colors.accent;
  const t = useSharedValue(play ? 0 : BLOOM_MS);
  useEffect(() => {
    if (!play) return;
    t.value = withTiming(BLOOM_MS, { duration: BLOOM_MS, easing: Easing.linear }, (finished) => {
      if (finished && onDone) runOnJS(onDone)();
    });
  }, [play]);
  const wrap = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, (t.value - 100) / (BLOOM_MS - 100)));
    // 放大到 1.35 再回落；旋转从 -28° 缓出到 0
    const scale = 1 + 0.35 * Math.sin(Math.PI * Math.min(1, p * 1.15));
    const rot = -0.5 * Math.pow(1 - p, 3);
    return { transform: [{ scale }, { rotate: `${rot}rad` }] };
  });
  return (
    <Animated.View style={[{ width: size, height: size }, style, wrap]}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeLinecap="round">
        {RAYS.map((ray, i) => <BloomRay key={i} ray={ray} index={i} t={t} />)}
      </Svg>
    </Animated.View>
  );
}
