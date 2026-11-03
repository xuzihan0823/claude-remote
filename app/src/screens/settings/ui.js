import { Children, Fragment, isValidElement, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Reanimated, {
  Easing,
  Extrapolation,
  FadeIn,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { GlassSurface } from '../../components/GlassSurface.js';
import { ProgressiveBlur } from '../../components/ProgressiveBlur.js';
import { Icon } from '../../components/Icon.js';
import { useTheme } from '../../theme.js';

// 设置页通用骨架（对照 Claude iOS 设置）：页面以 sheet 弹出，悬浮的液态玻璃圆钮 + 居中标题；
// 内容滚到导航区下面时，导航区是一层渐进模糊（顶部最糊、往下渐清）加淡淡的底色，透出下面的卡片。

export const HEADER_H = 64;

export function sheetBg(colors, dark) { return colors?.sheet ?? (dark ? colors.bg2 : colors.bg); }

export function GlassButton({ icon, onPress, label, disabled }) {
  const { colors } = useTheme();
  return (
    <GlassSurface interactive variant="pill" style={{ width: 44, height: 44, borderRadius: 22 }}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.4 : 1,
          backgroundColor: pressed ? colors.glassPressed : 'transparent',
        })}
      >
        <Icon name={icon} size={20} color={colors.inkStrong} />
      </Pressable>
    </GlassSurface>
  );
}

/**
 * left：'close'（设置首页，关闭整个 sheet）| 'back'（子页）。
 * right：{ icon, label, onPress } 或 null。
 */
export function SettingsPage({ title, left = 'back', right = null, children, keyboard = false }) {
  const { colors, dark } = useTheme();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const bg = sheetBg(colors, dark);
  const scrollY = useRef(new Animated.Value(0)).current;
  const fade = scrollY.interpolate({ inputRange: [0, 24], outputRange: [0, 1], extrapolate: 'clamp' });
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const id = scrollY.addListener(({ value }) => setScrolled(value > 1));
    return () => scrollY.removeListener(id);
  }, [scrollY]);

  const close = () => {
    // 根页的 ✕ 关掉整个设置 sheet（父 stack 的 Settings 路由）
    const parent = navigation.getParent();
    if (left === 'close' && parent) parent.goBack();
    else navigation.goBack();
  };

  const body = (
    <Animated.ScrollView
      contentContainerStyle={{ paddingTop: HEADER_H + 8, paddingBottom: Math.max(insets.bottom, 24) + 16, paddingHorizontal: 16 }}
      scrollIndicatorInsets={{ top: HEADER_H }}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
    >
      <View style={{ maxWidth: 600, width: '100%', alignSelf: 'center' }}>{children}</View>
    </Animated.ScrollView>
  );

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      {keyboard ? <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>{body}</KeyboardAvoidingView> : body}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: HEADER_H + 24 }}>
        <ProgressiveBlur tintColor={bg} fade={fade} active={scrolled} />
      </View>
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: HEADER_H, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}
      >
        <View style={{ width: 52 }}>
          <GlassButton icon={left === 'close' ? 'close' : 'back'} label={left === 'close' ? '关闭' : '返回'} onPress={close} />
        </View>
        <Text numberOfLines={1} style={{ flex: 1, textAlign: 'center', color: colors.inkStrong, fontSize: 17, fontWeight: '600' }}>
          {title}
        </Text>
        <View style={{ width: 52, alignItems: 'flex-end' }}>
          {right ? <GlassButton icon={right.icon} label={right.label} onPress={right.onPress} disabled={right.disabled} /> : null}
        </View>
      </View>
    </View>
  );
}

const FOLD_OPEN_SPRING = { damping: 26, stiffness: 280, mass: 0.8 };
const FOLD_CLOSE_MS = 220;
const FOLD_CLOSE_EASING = Easing.bezier(0.3, 0, 0.15, 1);
const CHEVRON_SPRING = { damping: 22, stiffness: 280, mass: 0.7 };

export function Collapse({ open, dividerInset = 54, children }) {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);
  const bodyH = useSharedValue(196);

  useEffect(() => {
    if (open) {
      setMounted(true);
      progress.value = reduceMotion ? 1 : withSpring(1, FOLD_OPEN_SPRING);
    } else if (mounted) {
      if (reduceMotion) {
        progress.value = 0;
        setMounted(false);
      } else {
        progress.value = withTiming(
          0,
          { duration: FOLD_CLOSE_MS, easing: FOLD_CLOSE_EASING },
          (done) => {
            if (done) runOnJS(setMounted)(false);
          },
        );
      }
    }
  }, [open, mounted, reduceMotion, progress]);

  const clipStyle = useAnimatedStyle(() => {
    const p = Math.max(0, progress.value);
    return {
      height: p * bodyH.value,
      opacity: interpolate(p, [0, 0.15, 1], [0, 0.35, 1], Extrapolation.CLAMP),
      overflow: 'hidden',
    };
  });

  const innerStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    return {
      transform: [{ translateY: (1 - p) * -10 }],
    };
  });

  if (!open && !mounted) return null;
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <Reanimated.View pointerEvents={open ? 'auto' : 'none'} style={clipStyle}>
      <Reanimated.View
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (h > 0) bodyH.value = h;
        }}
        style={[{ position: 'absolute', top: 0, left: 0, right: 0 }, innerStyle]}
      >
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: dividerInset, marginRight: 16 }} />
        {items.map((child, i) => (
          <Fragment key={child.key ?? i}>
            {child}
            {i < items.length - 1 ? (
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: child.props.icon ? 54 : 16, marginRight: 16 }} />
            ) : null}
          </Fragment>
        ))}
      </Reanimated.View>
    </Reanimated.View>
  );
}

export function Group({ title, footer, children, style }) {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const [shownFooter, setShownFooter] = useState(footer);
  const footerProgress = useSharedValue(footer ? 1 : 0);

  useEffect(() => {
    if (footer) {
      setShownFooter(footer);
      footerProgress.value = reduceMotion ? 1 : withSpring(1, FOLD_OPEN_SPRING);
    } else if (shownFooter) {
      if (reduceMotion) {
        footerProgress.value = 0;
        setShownFooter(undefined);
      } else {
        footerProgress.value = withTiming(
          0,
          { duration: FOLD_CLOSE_MS, easing: FOLD_CLOSE_EASING },
          (done) => {
            if (done) runOnJS(setShownFooter)(undefined);
          },
        );
      }
    }
  }, [footer, shownFooter, reduceMotion, footerProgress]);

  const footerStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, footerProgress.value));
    return {
      opacity: p,
      transform: [{ translateY: (1 - p) * -6 }],
    };
  });

  const items = Children.toArray(children).filter(isValidElement);
  const activeFooter = footer || shownFooter;
  return (
    <View style={[{ marginBottom: 26 }, style]}>
      {title ? <Text style={{ color: colors.ink2, fontSize: 13.5, marginLeft: 16, marginBottom: 8 }}>{title}</Text> : null}
      <View style={{ backgroundColor: colors.card, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden' }}>
        {items.map((child, i) => (
          <Fragment key={child.key ?? i}>
            {child}
            {i < items.length - 1 && items[i + 1]?.type !== Collapse ? (
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: child.props.icon ? 54 : 16, marginRight: 16 }} />
            ) : null}
          </Fragment>
        ))}
      </View>
      {activeFooter ? (
        <Reanimated.Text style={[{ color: colors.ink2, fontSize: 12.5, lineHeight: 18, marginHorizontal: 16, marginTop: 8 }, footerStyle]}>
          {activeFooter}
        </Reanimated.Text>
      ) : null}
    </View>
  );
}

function FoldChevron({ up, color }) {
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(up ? 1 : 0);
  useEffect(() => {
    p.value = reduceMotion ? (up ? 1 : 0) : withSpring(up ? 1 : 0, CHEVRON_SPRING);
  }, [up, reduceMotion, p]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${p.value * 180}deg` }],
  }));
  return (
    <Reanimated.View style={[{ marginLeft: 4, marginRight: -4 }, style]}>
      <Icon name="chevron" size={20} color={color} />
    </Reanimated.View>
  );
}

/**
 * 一行设置。右侧四选一：toggle（Switch）、checked（✓）、chevron（默认，有 onPress 时；传图标名可换成上下箭头）、无。
 * onDetail：在最右侧放一个独立的 ⓘ 按钮（不显示 chevron），点行本身和点 ⓘ 是两个动作。
 * dot：值前面的状态点颜色；tone：'danger' | 'accent' 改文字颜色；center：居中按钮样式（如「移除此设备」）。
 */
export function Row({
  icon, iconColor, label, sub, value, dot, onPress, onLongPress, toggle, onToggle, checked,
  chevron, onDetail, tone, center, disabled, accessibilityLabel,
}) {
  const { colors } = useTheme();
  const isToggle = typeof toggle === 'boolean';
  const isFold = chevron === 'chevron' || chevron === 'chevronUp';
  const showChevron = chevron ?? (!!onPress && !onDetail && !isToggle && checked === undefined && !center);
  const color = tone === 'danger' ? colors.danger : tone === 'accent' ? colors.accent : colors.inkStrong;
  const content = (
    <>
      {icon ? <View style={{ width: 26, marginRight: 12, alignItems: 'center' }}><Icon name={icon} size={22} color={iconColor || colors.ink} strokeWidth={1.6} /></View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color, fontSize: 16.5, textAlign: center ? 'center' : 'left', fontWeight: center ? '500' : '400' }}>{label}</Text>
        {sub ? <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 12.5, marginTop: 2 }}>{sub}</Text> : null}
      </View>
      {dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot, marginLeft: 8, marginRight: value ? 6 : 0 }} /> : null}
      {value ? <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 15, marginLeft: dot ? 0 : 8, maxWidth: '55%' }}>{value}</Text> : null}
      {isToggle ? (
        <Switch
          value={toggle}
          onValueChange={onToggle}
          disabled={disabled}
          trackColor={{ true: colors.accent, false: colors.controlBorder }}
          ios_backgroundColor={colors.controlBorder}
          style={{ marginLeft: 8, alignSelf: 'center' }}
        />
      ) : null}
      {checked ? <Reanimated.View entering={FadeIn.duration(150)} style={{ marginLeft: 8 }}><Icon name="check" size={20} color={colors.accent} strokeWidth={2.2} /></Reanimated.View> : null}
      {checked === false ? <View style={{ width: 28 }} /> : null}
      {onDetail ? (
        <Pressable
          onPress={onDetail}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${label} 详情`}
          style={({ pressed }) => ({ marginLeft: 6, marginRight: -8, padding: 8, borderRadius: 19, backgroundColor: pressed ? colors.glassPressed : 'transparent' })}
        >
          <Icon name="info" size={22} color={colors.ink2} strokeWidth={1.6} />
        </Pressable>
      ) : null}
      {showChevron ? (
        isFold ? (
          <FoldChevron up={chevron === 'chevronUp'} color={colors.ink3} />
        ) : (
          <View style={{ marginLeft: 4, marginRight: -4 }}>
            <Icon name={typeof chevron === 'string' ? chevron : 'chevronRight'} size={20} color={colors.ink3} />
          </View>
        )
      ) : null}
    </>
  );
  const rowStyle = { minHeight: sub ? 62 : 52, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' };
  if (!onPress && !onLongPress) return <View style={rowStyle} accessibilityLabel={accessibilityLabel}>{content}</View>;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={checked !== undefined ? { selected: !!checked } : isFold ? { expanded: chevron === 'chevronUp' } : undefined}
      style={({ pressed }) => [rowStyle, { backgroundColor: pressed ? colors.glassPressed : 'transparent', opacity: disabled ? 0.5 : 1 }]}
    >
      {content}
    </Pressable>
  );
}

