import { Children, Fragment, isValidElement, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
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

export function sheetBg(colors, dark) { return dark ? colors.bg2 : colors.bg; }

export function GlassButton({ icon, onPress, label, disabled }) {
  const { colors } = useTheme();
  return (
    <GlassSurface interactive variant="pill" style={{ borderRadius: 22 }}>
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

export function Group({ title, footer, children, style }) {
  const { colors } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[{ marginBottom: 26 }, style]}>
      {title ? <Text style={{ color: colors.ink2, fontSize: 13.5, marginLeft: 16, marginBottom: 8 }}>{title}</Text> : null}
      <View style={{ backgroundColor: colors.card, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden' }}>
        {items.map((child, i) => (
          <Fragment key={child.key ?? i}>
            {child}
            {i < items.length - 1 ? (
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: child.props.icon ? 54 : 16, marginRight: 16 }} />
            ) : null}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={{ color: colors.ink2, fontSize: 12.5, lineHeight: 18, marginHorizontal: 16, marginTop: 8 }}>{footer}</Text> : null}
    </View>
  );
}

/**
 * 一行设置。右侧四选一：toggle（Switch）、checked（✓）、chevron（默认，有 onPress 时）、无。
 * dot：值前面的状态点颜色；tone：'danger' | 'accent' 改文字颜色；center：居中按钮样式（如「移除此设备」）。
 */
export function Row({
  icon, iconColor, label, sub, value, dot, onPress, onLongPress, toggle, onToggle, checked,
  chevron, tone, center, disabled, accessibilityLabel,
}) {
  const { colors } = useTheme();
  const isToggle = typeof toggle === 'boolean';
  const showChevron = chevron ?? (!!onPress && !isToggle && checked === undefined && !center);
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
          style={{ marginLeft: 8 }}
        />
      ) : null}
      {checked ? <View style={{ marginLeft: 8 }}><Icon name="check" size={20} color={colors.accent} strokeWidth={2.2} /></View> : null}
      {checked === false ? <View style={{ width: 28 }} /> : null}
      {showChevron ? <View style={{ marginLeft: 4, marginRight: -4 }}><Icon name="chevronRight" size={20} color={colors.ink3} /></View> : null}
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
      accessibilityState={checked !== undefined ? { selected: !!checked } : undefined}
      style={({ pressed }) => [rowStyle, { backgroundColor: pressed ? colors.glassPressed : 'transparent', opacity: disabled ? 0.5 : 1 }]}
    >
      {content}
    </Pressable>
  );
}

