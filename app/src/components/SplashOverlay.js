import { useEffect } from 'react';
import { Image, StyleSheet, useColorScheme } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { palettes } from '../theme.js';
import { SPLASH_FADE_MS } from '../lib/intro.js';

// 开屏字标接管层：与原生启动屏（app.json 的 expo-splash-screen）像素级一致——同一张图、同样居中、同样宽度、
// 跟随系统深浅色（原生启动屏不认 App 内的外观设置）。冷启动首帧就渲染在最上层，
// leaving 后先瞬间收起原生启动屏（下面就是一模一样的这一层，看不出切换），再让字标轻轻放大淡出，
// 露出登录页 / 首页的芒星绽放。改字标时用 design/gen-splash.py 重新生成两张图并同步 LOCKUP_W。
export const LOCKUP_W = 254; // pt，等于 app.json 里的 imageWidth
const LOCKUP_H = LOCKUP_W * (128 / 763);
const LIGHT = require('../../assets/splash-lockup.png');
const DARK = require('../../assets/splash-lockup-dark.png');

export function SplashOverlay({ leaving, onDone }) {
  const dark = useColorScheme() === 'dark';
  const reduceMotion = useReducedMotion();
  const bgOp = useSharedValue(1);
  const markOp = useSharedValue(1);
  const markScale = useSharedValue(1);

  useEffect(() => {
    if (!leaving) return;
    SplashScreen.hideAsync().catch(() => { /* noop */ });
    const ease = Easing.out(Easing.cubic);
    markOp.value = withTiming(0, { duration: SPLASH_FADE_MS * 0.75, easing: ease });
    if (!reduceMotion) markScale.value = withTiming(1.05, { duration: SPLASH_FADE_MS, easing: ease });
    bgOp.value = withTiming(0, { duration: SPLASH_FADE_MS, easing: Easing.inOut(Easing.quad) }, (finished) => {
      if (finished && onDone) runOnJS(onDone)();
    });
  }, [leaving]);

  const bgStyle = useAnimatedStyle(() => ({ opacity: bgOp.value }));
  const markStyle = useAnimatedStyle(() => ({ opacity: markOp.value, transform: [{ scale: markScale.value }] }));

  return (
    <Animated.View pointerEvents={leaving ? 'none' : 'auto'} style={[StyleSheet.absoluteFill, styles.center, bgStyle, { backgroundColor: palettes[dark ? 'dark' : 'light'].bg }]}>
      <Animated.View style={markStyle}>
        <Image source={dark ? DARK : LIGHT} style={{ width: LOCKUP_W, height: LOCKUP_H }} resizeMode="contain" />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ center: { alignItems: 'center', justifyContent: 'center' } });
