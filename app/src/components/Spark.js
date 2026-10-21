import { useEffect, useRef } from 'react';
import Animated, {
  cancelAnimation, Easing, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue,
  withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import Svg, { Line } from 'react-native-svg';
import { useTheme } from '../theme.js';

// 品牌芒星：11 条光芒，角度略有错落、长短参差（2026-10 由 15 条等长改版）。
// 每项 [x1, y1, x2, y2, 线宽]，viewBox 24×24，全部从中心 (12,12) 出发。
// web/ui/components/spark.js 与 App 图标仍是旧版 15 条。
export const RAYS = [
  [12, 12, 12.0, 2.6, 2.1],
  [12, 12, 15.93, 6.73, 1.8],
  [12, 12, 19.5, 8.09, 2.0],
  [12, 12, 17.67, 13.33, 1.7],
  [12, 12, 19.02, 17.67, 2.1],
  [12, 12, 13.65, 18.95, 1.85],
  [12, 12, 10.27, 19.9, 1.95],
  [12, 12, 7.17, 15.9, 1.7],
  [12, 12, 3.03, 14.1, 2.1],
  [12, 12, 6.0, 8.87, 1.8],
  [12, 12, 7.62, 5.43, 1.9],
];

// 静态芒星。color 缺省走主题 accent；暗色自动随 useColorScheme 切换。
export function Spark({ size = 16, color, style }) {
  const { colors } = useTheme();
  const stroke = color ?? colors.accent;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeLinecap="round" style={style}>
      {RAYS.map(([x1, y1, x2, y2, w], i) => (
        <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={w} />
      ))}
    </Svg>
  );
}

// ── 动画芒星 ─────────────────────────────────────────────────────
// 一个组件覆盖开屏与登录的所有状态，结束时都与静态 Spark 完全重合：
//   play           挂载即绽放：光芒按顺时针依次从中心长出并回弹，整体放大 1.35 倍再回落、轻转（≈0.9s）
//   busy           连接中：持续旋转，光芒依次伸缩（呼吸感）
//   shake          数字每变一次左右抖一下（连接失败）
//   glideFrom      { x, y, size }：从登录页芒星的窗口位置平移缩放到自身位置（登录成功衔接首页）
const AnimatedLine = Animated.createAnimatedComponent(Line);
const RAY_STAGGER = 30; // ms
const RAY_DUR = 360; // ms
export const BLOOM_MS = 100 + RAYS.length * RAY_STAGGER + RAY_DUR + 150;
const GLIDE_MS = 620;
const TWO_PI = Math.PI * 2;

function backOut(x) {
  'worklet';
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function AnimRay({ ray, index, t, pulse, busyAmt }) {
  const [x1, y1, x2, y2, w] = ray;
  const props = useAnimatedProps(() => {
    const local = (t.value - 100 - index * RAY_STAGGER) / RAY_DUR;
    const grow = local <= 0 ? 0 : local >= 1 ? 1 : backOut(local);
    const breathe = 1 - busyAmt.value * (0.24 + 0.24 * Math.sin(pulse.value * 3 - index * 0.9));
    const p = grow * breathe;
    return { x2: x1 + (x2 - x1) * p, y2: y1 + (y2 - y1) * p, strokeOpacity: local <= 0 ? 0 : 1 };
  });
  return <AnimatedLine x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={w} animatedProps={props} />;
}

export function BloomSpark({ size = 48, color, style, play = false, busy = false, shake = 0, glideFrom = null, onDone }) {
  const { colors } = useTheme();
  const stroke = color ?? colors.accent;
  const ref = useRef(null);
  const t = useSharedValue(play ? 0 : BLOOM_MS);
  const pulse = useSharedValue(0); // busy 时 0→2π 循环
  const busyAmt = useSharedValue(0); // busy 的强度，0/1 之间过渡，避免停下时跳变
  const spin = useSharedValue(0); // 累计旋转（弧度）
  const shakeX = useSharedValue(0);
  const glide = useSharedValue(glideFrom ? 0 : 1);
  const from = useSharedValue({ dx: 0, dy: 0, s: 1 });
  const ready = useSharedValue(glideFrom ? 0 : 1); // glide 量好位置之前先隐藏，避免闪一帧

  useEffect(() => {
    if (!play) return;
    t.value = withTiming(BLOOM_MS, { duration: BLOOM_MS, easing: Easing.linear }, (finished) => {
      if (finished && onDone) runOnJS(onDone)();
    });
  }, [play]);

  useEffect(() => {
    if (busy) {
      busyAmt.value = withTiming(1, { duration: 250 });
      pulse.value = 0;
      pulse.value = withRepeat(withTiming(TWO_PI, { duration: 1100, easing: Easing.linear }), -1, false);
      spin.value = withRepeat(withTiming(spin.value + TWO_PI, { duration: 2600, easing: Easing.linear }), -1, false);
    } else {
      busyAmt.value = withTiming(0, { duration: 250 });
      cancelAnimation(spin);
      // 停在最近的整圈，回到和静态 Spark 一致的角度
      const target = Math.ceil(spin.value / TWO_PI) * TWO_PI;
      spin.value = withTiming(target, { duration: 450, easing: Easing.out(Easing.cubic) }, () => {
        spin.value = 0;
        cancelAnimation(pulse);
      });
    }
  }, [busy]);

  useEffect(() => {
    if (!shake) return;
    shakeX.value = withSequence(
      withTiming(-8, { duration: 50 }), withTiming(8, { duration: 70 }),
      withTiming(-6, { duration: 70 }), withTiming(5, { duration: 70 }),
      withTiming(0, { duration: 60 }),
    );
  }, [shake]);

  const onLayout = () => {
    if (!glideFrom || !ref.current) return;
    ref.current.measureInWindow((x, y, w, h) => {
      from.value = { dx: glideFrom.x - (x + w / 2), dy: glideFrom.y - (y + h / 2), s: glideFrom.size / size };
      ready.value = 1;
      glide.value = withTiming(1, { duration: GLIDE_MS, easing: Easing.bezier(0.32, 0.72, 0, 1) }, (finished) => {
        if (finished && onDone) runOnJS(onDone)();
      });
    });
  };

  const wrap = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, (t.value - 100) / (BLOOM_MS - 100)));
    const bloomScale = 1 + 0.35 * Math.sin(Math.PI * Math.min(1, p * 1.15));
    const bloomRot = -0.5 * Math.pow(1 - p, 3);
    const g = glide.value;
    const f = from.value;
    return {
      opacity: ready.value,
      transform: [
        { translateX: f.dx * (1 - g) + shakeX.value },
        { translateY: f.dy * (1 - g) },
        { scale: bloomScale * (f.s + (1 - f.s) * g) },
        { rotate: `${bloomRot + spin.value}rad` },
      ],
    };
  });

  return (
    <Animated.View ref={ref} onLayout={onLayout} collapsable={false} style={[{ width: size, height: size }, style, wrap]}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeLinecap="round">
        {RAYS.map((ray, i) => <AnimRay key={i} ray={ray} index={i} t={t} pulse={pulse} busyAmt={busyAmt} />)}
      </Svg>
    </Animated.View>
  );
}

/** 量出某个 view 的窗口中心与尺寸，供 glideFrom 使用。 */
export function measureSpark(ref) {
  return new Promise((resolve) => {
    if (!ref?.current) { resolve(null); return; }
    ref.current.measureInWindow((x, y, w, h) => resolve({ x: x + w / 2, y: y + h / 2, size: w }));
  });
}
