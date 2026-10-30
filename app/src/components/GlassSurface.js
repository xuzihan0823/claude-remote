import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useTheme } from '../theme.js';

export function GlassSurface({
  children,
  style,
  interactive = false,
  variant = 'regular',
  effectStyle = 'regular',
  tintColor,
}) {
  const { colors, dark, darkProgress = dark ? 1 : 0 } = useTheme();
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let active = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', (value) => {
      changed = true;
      setReduceTransparency(value);
    });
    AccessibilityInfo.isReduceTransparencyEnabled().then((value) => {
      if (active && !changed) setReduceTransparency(value);
    }).catch(() => {});
    return () => { active = false; subscription.remove(); };
  }, []);

  const glass = Platform.OS === 'ios' && !reduceTransparency
    && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  const flatStyle = StyleSheet.flatten(style) || {};
  const resolvedRadius = flatStyle.borderRadius ?? 28;
  const isAccent = variant === 'accent';
  const isPill = variant === 'pill' || interactive;

  const resolvedTint = tintColor ?? (
    isAccent
      ? colors.glassTintAccent
      : isPill
        ? colors.glassTintInteractive
        : colors.glassTint
  );

  const fallbackBg = isAccent
    ? (colors.cardAccent ?? (dark ? '#33241E' : '#F9EBE5'))
    : colors.card;

  const innerBorderColor = isAccent ? colors.glassBorderAccent : colors.glassBorder;
  const lightShadowOp = isAccent ? 0.12 : isPill ? 0.075 : 0.085;
  const darkShadowOp = isPill ? 0.26 : 0.32;
  return (
    <View
      style={[
        {
          borderRadius: resolvedRadius,
          borderCurve: 'continuous',
          backgroundColor: glass ? 'transparent' : fallbackBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: isAccent ? colors.glassBorderAccent : colors.glassEdgeOuter,
          shadowColor: isAccent ? '#B85435' : (colors.glassShadow ?? (dark ? '#000000' : '#241E17')),
          shadowOffset: { width: 0, height: isPill ? 4 : 6 },
          shadowOpacity: lightShadowOp + (darkShadowOp - lightShadowOp) * darkProgress,
          shadowRadius: isPill ? 12 : 18,
        },
        style,
      ]}
    >
      {glass ? (
        <GlassView
          pointerEvents="none"
          isInteractive={interactive}
          glassEffectStyle={effectStyle}
          tintColor={resolvedTint}
          colorScheme={dark ? 'dark' : 'light'}
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: resolvedRadius, borderCurve: 'continuous' },
          ]}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: resolvedRadius,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: innerBorderColor,
          },
        ]}
      />
      {children}
    </View>
  );
}
