import { useEffect, useRef } from 'react';
import Animated, {
  cancelAnimation, Easing, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue,
  withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '../theme.js';

// 品牌芒星：12 条锥形光芒 + 实心中心，按用户给的参考图描出来（2026-10）。
// 每项 [角度°（0 = 向右，顺时针）, 长度, 端部宽度]，viewBox 24×24，中心 (12,12)；按顺时针从正上方排序，绽放时依次长出。
// 光芒从中心的 0.75 倍宽渐宽到端部，端部是带小圆角的平头。web/ui/components/spark.js 与 App 图标仍是旧版。
export const RAYS = [
  [280, 8.88, 1.62],
  [313, 9.19, 2.24],
  [352.5, 9.05, 1.68],
  [15, 9.46, 1.45],
  [44, 9.69, 1.4],
  [60.5, 9.5, 1.91],
  [93.5, 9.82, 1.45],
  [121.5, 9.91, 1.4],
  [146.5, 9.42, 1.57],
  [178, 9.72, 1.28],
  [212.5, 9.72, 2.08],
  [241, 10.18, 2.24],
];
const HUB_R = 2.4;
const C = 12;

/** 一条光芒的 path。p 为生长比例（0..1+，回弹时可略大于 1）。 */
export function rayPath(angleDeg, len, width, p) {
  'worklet';
  const l = Math.max(0, len * p);
  if (l < 0.05) return 'M12 12Z';
  const k = Math.min(1, l / (width * 1.5)); // 很短时宽度也跟着缩，避免出现方块
  const w = width * k;
  const wb = w * 0.75;
  const r = w * 0.3;
  const t = (angleDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const pt = (x, y) => `${(C + x * c - y * s).toFixed(3)} ${(C + x * s + y * c).toFixed(3)}`;
  return `M${pt(0, -wb / 2)}L${pt(l - r, -w / 2)}Q${pt(l, -w / 2)} ${pt(l, -w / 2 + r)}`
    + `L${pt(l, w / 2 - r)}Q${pt(l, w / 2)} ${pt(l - r, w / 2)}L${pt(0, wb / 2)}Z`;
}

const STATIC_PATHS = RAYS.map(([a, l, w]) => rayPath(a, l, w, 1));

// 静态芒星。color 缺省走主题 accent；暗色自动随 useColorScheme 切换。
export function Spark({ size = 16, color, style }) {
  const { colors } = useTheme();
  const fill = color ?? colors.accent;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style}>
      <Circle cx={C} cy={C} r={HUB_R} fill={fill} />
      {STATIC_PATHS.map((d, i) => <Path key={i} d={d} fill={fill} />)}
    </Svg>
  );
}

// ── 动画芒星 ─────────────────────────────────────────────────────
// 一个组件覆盖开屏与登录的所有状态，结束时都与静态 Spark 完全重合：
//   play           挂载即绽放：光芒按顺时针依次从中心长出并回弹，整体放大 1.35 倍再回落、轻转（≈0.9s）
//   busy           连接中：不旋转，各光束像星星闪烁一样各自轻微伸缩（±8% 左右）
//   shake          数字每变一次左右抖一下（连接失败）
//   glideFrom      { x, y, size }：从登录页芒星的窗口位置平移缩放到自身位置（登录成功衔接首页）
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
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

const TWINKLE_AMP = 0.08;
// [频率, 相位]，固定伪随机值
const TWINKLE = RAYS.map((_, i) => [1 + ((i * 7) % 3), ((i * 2.399) % 6.283)]);

function AnimRay({ ray, index, t, pulse, busyAmt, fill }) {
  const [angle, len, width] = ray;
  const props = useAnimatedProps(() => {
    const local = (t.value - 100 - index * RAY_STAGGER) / RAY_DUR;
    const grow = local <= 0 ? 0 : local >= 1 ? 1 : backOut(local);
    // 每条光束用不同的整数频率和相位叠两个正弦，看起来无规律但一圈后无缝衔接
    const [k, ph] = TWINKLE[index];
    const wave = 0.65 * Math.sin(k * pulse.value + ph) + 0.35 * Math.sin((k + 2) * pulse.value + ph * 1.7);
    const breathe = 1 + busyAmt.value * TWINKLE_AMP * wave;
    return { d: rayPath(angle, len, width, grow * breathe) };
  });
  return <AnimatedPath fill={fill} animatedProps={props} />;
}

function AnimHub({ t, fill }) {
  const props = useAnimatedProps(() => {
    const p = Math.min(1, Math.max(0, (t.value - 60) / 180));
    return { r: HUB_R * backOut(p) };
  });
  return <AnimatedCircle cx={C} cy={C} fill={fill} animatedProps={props} />;
}

export function BloomSpark({ size = 48, color, style, play = false, busy = false, shake = 0, glideFrom = null, onDone }) {
  const { colors } = useTheme();
  const fill = color ?? colors.accent;
  const ref = useRef(null);
  const t = useSharedValue(play ? 0 : BLOOM_MS);
  const pulse = useSharedValue(0); // busy 时 0→2π 循环
  const busyAmt = useSharedValue(0); // busy 的强度，0/1 之间过渡，避免停下时跳变
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
      pulse.value = withRepeat(withTiming(TWO_PI, { duration: 3200, easing: Easing.linear }), -1, false);
    } else {
      // 闪烁幅度渐收到 0 再停，光束回到原长，不跳变
      busyAmt.value = withTiming(0, { duration: 300 }, () => cancelAnimation(pulse));
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
        { rotate: `${bloomRot}rad` },
      ],
    };
  });

  return (
    <Animated.View ref={ref} onLayout={onLayout} collapsable={false} style={[{ width: size, height: size }, style, wrap]}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <AnimHub t={t} fill={fill} />
        {RAYS.map((ray, i) => <AnimRay key={i} ray={ray} index={i} t={t} pulse={pulse} busyAmt={busyAmt} fill={fill} />)}
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
