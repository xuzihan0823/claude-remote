import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay } from 'react-native-screens';
import {
  EFFORT_DESCRIPTIONS,
  EFFORT_LEVELS,
  effortLabel,
  effortUsable,
} from '../../../../web/core/effort.js';
import { Icon } from '../Icon.js';
import { NativeBlurView } from '../ProgressiveBlur.js';
import { useTheme } from '../../theme.js';
import { haptics } from '../../lib/haptics.js';

const KNOB = 48;
const INSET = 4;
const TRACK_H = KNOB + INSET * 2;
const SNAP = { damping: 22, stiffness: 360, mass: 0.8 };
const BOTTOM_GAP = 20;
const ABOVE_KEYBOARD = 16;
const BLUR = 40;
const AnimatedBlur = NativeBlurView ? Animated.createAnimatedComponent(NativeBlurView) : null;

function Dot({ x, at, colors }) {
  const style = useAnimatedStyle(() => ({
    backgroundColor: x.value >= at - 1 ? 'rgba(255,255,255,0.6)' : colors.ink3,
  }), [at, colors.ink3]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', top: TRACK_H / 2 - 4, left: TRACK_H / 2 + at - 4, width: 8, height: 8, borderRadius: 4 }, style]}
    />
  );
}

// 离散滑块：按住任意位置跟手拖动，松手吸附到最近档位；经过档位时轻触感反馈。
// x 是滑钮中心相对最左档位的位移，单位 px。
function EffortSlider({ count, index, label, onPreview, onCommit }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const span = Math.max(width - TRACK_H, 0);
  const step = count > 1 ? span / (count - 1) : 0;
  const x = useSharedValue(0);
  const pressed = useSharedValue(0);
  const last = useSharedValue(index);
  const placed = useRef(false);

  useEffect(() => {
    if (!step) return;
    last.value = index;
    // 首次量到宽度时直接就位，不从最左边滑过来
    x.value = placed.current ? withSpring(index * step, SNAP) : index * step;
    placed.current = true;
  }, [index, step]);

  const pan = Gesture.Pan()
    .minDistance(0)
    .shouldCancelWhenOutside(false)
    .onBegin((e) => {
      const target = Math.min(span, Math.max(0, e.x - TRACK_H / 2));
      pressed.value = withSpring(1, SNAP);
      x.value = withTiming(target, { duration: 140 });
      const i = step ? Math.round(target / step) : 0;
      if (i !== last.value) { last.value = i; runOnJS(onPreview)(i); }
    })
    .onUpdate((e) => {
      x.value = Math.min(span, Math.max(0, e.x - TRACK_H / 2));
      const i = step ? Math.round(x.value / step) : 0;
      if (i !== last.value) { last.value = i; runOnJS(onPreview)(i); }
    })
    .onFinalize(() => {
      pressed.value = withSpring(0, SNAP);
      x.value = withSpring(last.value * step, SNAP);
      runOnJS(onCommit)(last.value);
    });

  const fillStyle = useAnimatedStyle(() => ({ width: x.value + TRACK_H }));
  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { scale: 1 + pressed.value * 0.06 }],
  }));

  return (
    <View
      style={{
        borderRadius: TRACK_H / 2 + 8,
        borderCurve: 'continuous',
        padding: 8,
        backgroundColor: colors.card,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.controlBorder,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      }}
    >
      <GestureDetector gesture={pan}>
        <View
          testID="effort-slider"
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="思考程度"
          accessibilityValue={{ text: label }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={({ nativeEvent }) => {
            const next = index + (nativeEvent.actionName === 'increment' ? 1 : -1);
            if (next >= 0 && next < count) { onPreview(next); onCommit(next); }
          }}
          style={{ height: TRACK_H, borderRadius: TRACK_H / 2, borderCurve: 'continuous', backgroundColor: colors.controlFill, overflow: 'hidden' }}
        >
          <Animated.View style={[{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: TRACK_H / 2, backgroundColor: colors.accent }, fillStyle]} />
          {step ? Array.from({ length: count }, (_, i) => <Dot key={i} x={x} at={i * step} colors={colors} />) : null}
          <Animated.View
            pointerEvents="none"
            style={[{
              position: 'absolute',
              top: INSET,
              left: INSET,
              width: KNOB,
              height: KNOB,
              borderRadius: KNOB / 2,
              backgroundColor: '#FFFFFF',
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
            }, knobStyle]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}

// iOS 用 FullWindowOverlay 盖在整个窗口上：它不会像 Modal 那样抢走输入框焦点，键盘保持弹出。
function OverlayHost({ onClose, children }) {
  if (Platform.OS === 'ios') return <FullWindowOverlay>{children}</FullWindowOverlay>;
  return <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>{children}</Modal>;
}

// 思考程度：入口在 + 菜单；选了非默认档位时在模型 pill 旁显示 chip，点 chip 也能打开。
// 打开后是模糊背景上的滑块浮层（键盘在时骑在键盘上方），最左一档为「跟随默认」，点空白处关闭。
// 网关确认过档位时只列支持的档位；未确认时列出全部五档。
export function EffortPicker({ open, onOpen, onClose, effort, options, onPick }) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const usable = effortUsable(options, effort);
  const levels = options?.verified ? options.levels : EFFORT_LEVELS;
  const stops = ['', ...levels];
  const committed = stops.indexOf(effort);
  const [preview, setPreview] = useState(-1);
  const [mounted, setMounted] = useState(false);
  const fade = useSharedValue(0);

  useEffect(() => {
    if (open) {
      setPreview(-1);
      setMounted(true);
      fade.value = withTiming(1, { duration: 200 });
    } else {
      fade.value = withTiming(0, { duration: 160 }, (done) => { if (done) runOnJS(setMounted)(false); });
    }
  }, [open]);

  const blurProps = useAnimatedProps(() => ({ intensity: fade.value * BLUR }));
  const layerStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - fade.value) * 16 }] }));

  const shown = preview >= 0 ? stops[preview] : effort;
  const shownOk = effortUsable(options, shown);

  const previewAt = (i) => {
    haptics.selection();
    setPreview(i);
  };
  const commitAt = (i) => {
    if (stops[i] !== effort) onPick(stops[i]);
  };

  const hint = options?.verified
    ? (levels.length ? '' : '当前模型不支持调整思考程度')
    : options ? '未能从网关确认该模型支持的档位' : '';

  return (
    <>
      {effort ? (
        <TouchableOpacity
          testID="effort-chip"
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`思考程度：${effortLabel(effort)}${usable ? '' : '，当前模型不支持'}`}
          style={{
            minHeight: 44,
            paddingHorizontal: 12,
            borderRadius: 22,
            borderCurve: 'continuous',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            backgroundColor: usable ? colors.controlFill : colors.glassTintAccent,
            borderWidth: 1,
            borderColor: usable ? colors.controlBorder : colors.danger,
          }}
        >
          <Icon name="brain" size={16} color={usable ? colors.accent : colors.danger} />
          <Text style={{ color: usable ? colors.ink : colors.danger, fontSize: 13.5, fontWeight: '500' }}>
            {effortLabel(effort)}
          </Text>
        </TouchableOpacity>
      ) : null}
      {mounted ? (
        <OverlayHost onClose={onClose}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            {AnimatedBlur ? <AnimatedBlur animatedProps={blurProps} intensity={0} tint={dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} /> : null}
            <Animated.View style={[StyleSheet.absoluteFill, layerStyle]}>
              <Pressable
                testID="effort-backdrop"
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="关闭思考程度"
                style={[StyleSheet.absoluteFill, { backgroundColor: AnimatedBlur ? (dark ? 'rgba(0,0,0,0.35)' : 'rgba(250,249,245,0.35)') : colors.bg, opacity: AnimatedBlur ? 1 : 0.92 }]}
              />
              <KeyboardStickyView
                offset={{ opened: insets.bottom + BOTTOM_GAP - ABOVE_KEYBOARD }}
                style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + BOTTOM_GAP }}
              >
                <Animated.View accessibilityViewIsModal style={[{ alignItems: 'center' }, panelStyle]}>
                  <Text style={{ color: colors.ink2, fontSize: 13, fontWeight: '500', letterSpacing: 0.5 }}>思考程度</Text>
                  <Animated.Text
                    key={shown || 'default'}
                    entering={FadeIn.duration(140)}
                    testID="effort-value"
                    style={{ color: shownOk ? colors.inkStrong : colors.danger, fontSize: 30, fontWeight: '600', marginTop: 4 }}
                  >
                    {effortLabel(shown)}
                  </Animated.Text>
                  <Text style={{ color: shownOk ? colors.ink2 : colors.danger, fontSize: 13.5, marginTop: 4, marginBottom: 18, textAlign: 'center' }}>
                    {shownOk ? EFFORT_DESCRIPTIONS[shown] : '当前模型不支持这一档，请重新选择'}
                  </Text>
                  {levels.length ? (
                    <View style={{ alignSelf: 'stretch' }}>
                      <EffortSlider
                        count={stops.length}
                        index={Math.max(committed, 0)}
                        label={effortLabel(shown)}
                        onPreview={previewAt}
                        onCommit={commitAt}
                      />
                    </View>
                  ) : null}
                  {hint ? <Text style={{ color: colors.ink3, fontSize: 12.5, marginTop: 12 }}>{hint}</Text> : null}
                </Animated.View>
              </KeyboardStickyView>
            </Animated.View>
          </GestureHandlerRootView>
        </OverlayHost>
      ) : null}
    </>
  );
}
