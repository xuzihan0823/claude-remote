import { Animated, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '../theme.js';

// 渐进模糊：顶部最糊、往下逐渐清晰（BlurView 套一层渐变 alpha 遮罩）。
// expo-blur / masked-view 都是原生模块：旧的 dev client 没编进来时退回纯底色渐隐，
// 保证 JS 先更新时页面照常能用。
let BlurView = null;
let MaskedView = null;
try {
  /* eslint-disable global-require */
  // 包在但原生没编进来（JS 先热更新）时 require 不会抛，渲染才崩；先探测原生模块是否存在。
  // masked-view 与 expo-blur 同一次加入，ExpoBlur 在就说明这次原生构建两者都有。
  const { requireOptionalNativeModule } = require('expo-modules-core');
  if (!requireOptionalNativeModule('ExpoBlur')) throw new Error('ExpoBlur native module missing');
  BlurView = require('expo-blur').BlurView;
  MaskedView = require('@react-native-masked-view/masked-view').default;
  /* eslint-enable global-require */
} catch {
  BlurView = null;
  MaskedView = null;
}

export const hasNativeBlur = !!(BlurView && MaskedView);
export const NativeBlurView = BlurView;

function Fade({ id, color, stops }) {
  return (
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          {stops.map(([offset, opacity]) => (
            <Stop key={offset} offset={String(offset)} stopColor={color} stopOpacity={String(opacity)} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

/**
 * 铺满父容器（父容器给出高度并 pointerEvents="none"）。
 * fade：滚动驱动的 0→1，控制底色层显隐。active：是否挂载模糊层——静止在顶部时不挂，
 * 免得 BlurView 自带的 tint 让导航区和页面底色有色差；内容刚滚进来时再挂上，肉眼看不出切换。
 * tintColor：叠在模糊上的底色（通常是页面底色），保证标题在任何内容上都可读。
 */
export function ProgressiveBlur({ tintColor, intensity = 28, tintOpacity = 0.72, fade, active = true }) {
  const { dark } = useTheme();
  // fade（Animated 值）只作用在底色层：给 UIVisualEffectView 改 alpha 会让模糊失效
  const tint = (
    <Animated.View style={[StyleSheet.absoluteFill, fade ? { opacity: fade } : null]}>
      <Fade id="pbTint" color={tintColor} stops={hasNativeBlur
        ? [[0, tintOpacity], [0.55, tintOpacity * 0.6], [1, 0]]
        : [[0, 0.97], [0.62, 0.82], [1, 0]]}
      />
    </Animated.View>
  );
  if (!hasNativeBlur || !active) return tint;
  return (
    <View style={StyleSheet.absoluteFill}>
      <MaskedView
        style={StyleSheet.absoluteFill}
        maskElement={<Fade id="pbMask" color="#000" stops={[[0, 1], [0.5, 0.9], [1, 0]]} />}
      >
        <BlurView intensity={intensity} tint={dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      </MaskedView>
      {tint}
    </View>
  );
}
