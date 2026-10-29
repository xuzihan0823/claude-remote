import { Fragment, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
   interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { Icon } from './Icon.js';
import { useTheme } from '../theme.js';

const MENU_WIDTH = 252;
const GAP = 8;
const EDGE = 12;
const OPEN_SPRING = { damping: 24, stiffness: 310, mass: 0.85 };
const SIZE_SPRING = { damping: 24, stiffness: 340, mass: 0.8 };
const CLOSE_MS = 270;
const CLOSE_EASING = Easing.bezier(0.3, 0, 0.15, 1);
const MERGE_SPACING = 30;

function estimateMenuHeight({ items, title, header, large, maxH }) {
  const padV = (large ? 8 : 6) * 2;
  const headerH = header ? 44 : title ? 34 : 0;
  const rowsH = (items || []).reduce((sum, item) => {
    if (item.type === 'section') return sum + 32;
    if (large) return sum + 60;
    return sum + (item.detail || item.sub ? 54 : 48);
  }, 0);
  return Math.min(Math.max(padV + headerH + rowsH, 56), maxH);
}

// 液态玻璃下拉/上拉菜单：
// - 展开时从触发按钮处的圆球（ballSize × ballSize）向目标方向弹簧伸展，内容随外壳拉开并渐入；
// - 收起时文字与内描边在前 35% 行程内快速消散，剩余纯液态玻璃迅速收拢为圆球，
//   并在 GlassContainer（UIGlassContainerEffect）中与触发按钮处的锚点圆球产生水滴拉丝融合，最终缩进按钮圆心。
export function GlassMenu({
  visible,
  anchor,
  items = [],
  title,
  header,
  children,
  onClose,
  placement = 'below',
  size = 'regular',
  width: customWidth,
  testID,
}) {
  const { colors, dark } = useTheme();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [mounted, setMounted] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const [contentRawH, setContentRawH] = useState(0);
  const progress = useSharedValue(0);
  const isClosing = useSharedValue(0);
  const measuredOnce = useRef(false);
  const pending = useRef(null);

  useEffect(() => {
    let active = true;
    let changed = false;
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', (v) => {
      changed = true;
      setReduceTransparency(v);
    });
    AccessibilityInfo.isReduceTransparencyEnabled().then((v) => {
      if (active && !changed) setReduceTransparency(v);
    }).catch(() => {});
    return () => { active = false; sub.remove(); };
  }, []);
  const glass = Platform.OS === 'ios' && !reduceTransparency
    && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  const resolvedAnchor = anchor || { x: screenW - 64, y: 54, width: 48, height: 48 };
  const above = placement === 'above';
  const large = size === 'large';
  const targetRadius = large ? 32 : 28;
  const menuW = Math.min(customWidth || MENU_WIDTH, screenW - EDGE * 2);

  const maxH = above
    ? Math.max(160, resolvedAnchor.y - GAP - EDGE * 4)
    : Math.max(160, screenH - (resolvedAnchor.y + resolvedAnchor.height + GAP) - EDGE * 3);

  const estH = estimateMenuHeight({ items, title, header, large, maxH });
  const targetH = useSharedValue(estH);

  useEffect(() => {
    if (!mounted) {
      measuredOnce.current = false;
      setContentRawH(0);
      targetH.value = estH;
    }
  }, [mounted, estH]);

  const flush = () => {
    const run = pending.current;
    pending.current = null;
    run?.();
  };

  const finishClose = () => {
    setMounted(false);
    setTimeout(flush, Platform.OS === 'ios' ? 320 : 0);
  };

  const startOpen = () => {
    isClosing.value = 0;
    progress.value = withSpring(1, OPEN_SPRING);
  };

  useEffect(() => {
    if (visible) {
      if (mounted) startOpen();
      else {
        progress.value = 0;
        isClosing.value = 0;
        setMounted(true);
      }
    } else if (mounted) {
      isClosing.value = 1;
      progress.value = withTiming(0, { duration: CLOSE_MS, easing: CLOSE_EASING }, (finished) => {
        if (finished) runOnJS(finishClose)();
      });
    }
  }, [visible]);

  const select = (item) => {
    if (item.disabled) return;
    if (item.keepOpen) {
      item.onPress?.();
      return;
    }
    pending.current = item.onPress;
    onClose?.();
  };

  const alignRight = resolvedAnchor.x + resolvedAnchor.width / 2 >= screenW / 2;
  const menuLeft = alignRight
    ? Math.max(EDGE, Math.min(screenW - EDGE - menuW, resolvedAnchor.x + resolvedAnchor.width - menuW))
    : Math.max(EDGE, Math.min(screenW - EDGE - menuW, resolvedAnchor.x));

  const ballSize = Math.min(Math.max(Math.min(resolvedAnchor.width, resolvedAnchor.height), 40), 48);
  const ballCx = alignRight
    ? resolvedAnchor.x + resolvedAnchor.width - ballSize / 2
    : resolvedAnchor.x + ballSize / 2;
  const ballCy = resolvedAnchor.y + resolvedAnchor.height / 2;
  const ballLeft = ballCx - ballSize / 2;
  const ballTop = ballCy - ballSize / 2;

  const anchorTopEdge = resolvedAnchor.y + resolvedAnchor.height + GAP;
  const anchorBottomEdge = resolvedAnchor.y - GAP;

  const onContentLayout = (e) => {
    const raw = Math.ceil(e.nativeEvent.layout.height);
    if (raw <= 0) return;
    setContentRawH(raw);
    const clamped = Math.min(raw, maxH);
    if (!measuredOnce.current) {
      measuredOnce.current = true;
      targetH.value = clamped;
    } else if (Math.abs(targetH.value - clamped) > 1) {
      targetH.value = withSpring(clamped, SIZE_SPRING);
    }
  };

  // 锚点水滴球：在展开前段与收起中后段固定在触发按钮圆心，与菜单玻璃球在 GlassContainer 中融合成 45° 水滴尖嘴
  const orbStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const closing = isClosing.value === 1;
    const menuH = targetH.value;
    const fullTop = above ? anchorBottomEdge - menuH : anchorTopEdge;
    const cornerLeft = alignRight ? menuLeft + menuW - ballSize : menuLeft;
    const cornerTop = above ? fullTop + menuH - ballSize : fullTop;

    const tuck = closing
      ? interpolate(p, [0.76, 1], [0, 1], Extrapolation.CLAMP)
      : interpolate(p, [0.42, 0.88], [0, 1], Extrapolation.CLAMP);

    const left = ballLeft + (cornerLeft - ballLeft) * tuck;
    const top = ballTop + (cornerTop - ballTop) * tuck;
    const fadeOut = closing ? interpolate(p, [0, 0.14], [0, 1], Extrapolation.CLAMP) : 1;
    const hideWhenOpen = interpolate(p, [0.92, 1], [1, 0], Extrapolation.CLAMP);

    return {
      position: 'absolute',
      left,
      top,
      width: ballSize,
      height: ballSize,
      borderRadius: ballSize / 2,
      opacity: fadeOut * hideWhenOpen,
    };
  });

  // 菜单外壳：收起时宽高快速球化，沿 45° 对角线与按钮锚点球拉出水滴轮廓后缩进按钮圆心
  const shellStyle = useAnimatedStyle(() => {
    const rawP = progress.value;
    const p = Math.max(0, Math.min(1, rawP));
    const closing = isClosing.value === 1;
    const menuH = targetH.value;

    const pW = closing ? Math.pow(p, 1.48) : rawP;
    const pH = closing ? Math.pow(p, 1.72) : rawP;
    const pPosY = closing ? Math.pow(p, 0.85) : rawP;
    const pPosX = closing ? Math.pow(p, 0.9) : rawP;

    const curW = Math.max(ballSize * 0.85, ballSize + (menuW - ballSize) * pW);
    const curH = Math.max(ballSize * 0.85, ballSize + (menuH - ballSize) * pH);

    const diagShiftX = closing ? Math.sin(p * Math.PI) * (alignRight ? -9 : 9) : 0;
    const left = (alignRight
      ? (ballLeft + ballSize) + ((menuLeft + menuW) - (ballLeft + ballSize)) * pPosX - curW
      : ballLeft + (menuLeft - ballLeft) * pPosX) + diagShiftX;

    const fullTop = above ? anchorBottomEdge - menuH : anchorTopEdge;
    const top = above
      ? (ballTop + ballSize) + (anchorBottomEdge - (ballTop + ballSize)) * pPosY - curH
      : ballTop + (fullTop - ballTop) * pPosY;

    const dynRadius = Math.min(curW / 2, curH / 2, targetRadius);
    const shellOpacity = closing
      ? interpolate(p, [0, 0.14], [0, 1], Extrapolation.CLAMP)
      : 1;

    return {
      position: 'absolute',
      left,
      top,
      width: curW,
      height: curH,
      borderRadius: dynRadius,
      borderCurve: 'continuous',
      backgroundColor: glass ? 'transparent' : colors.card,
      shadowColor: dark ? '#000000' : '#241E17',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: (dark ? 0.34 : 0.1) * interpolate(p, [0.2, 1], [0, 1], Extrapolation.CLAMP),
      shadowRadius: 20,
      opacity: shellOpacity,
    };
  });

  const clipStyle = useAnimatedStyle(() => {
    const rawP = progress.value;
    const p = Math.max(0, Math.min(1, rawP));
    const closing = isClosing.value === 1;
    const menuH = targetH.value;
    const pW = closing ? Math.pow(p, 1.48) : rawP;
    const pH = closing ? Math.pow(p, 1.72) : rawP;
    const curW = Math.max(ballSize * 0.85, ballSize + (menuW - ballSize) * pW);
    const curH = Math.max(ballSize * 0.85, ballSize + (menuH - ballSize) * pH);
    return {
      borderRadius: Math.min(curW / 2, curH / 2, targetRadius),
      borderCurve: 'continuous',
    };
  });

  // 内容与内描边：收起前 35%（p: 1 -> 0.65）内朝锚点角聚拢并完全淡出，确保水滴阶段为纯净液态玻璃
  const contentAnimStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const closing = isClosing.value === 1;
    const opacity = closing
      ? interpolate(p, [0.64, 1], [0, 1], Extrapolation.CLAMP)
      : interpolate(p, [0.22, 0.86], [0, 1], Extrapolation.CLAMP);
    const shiftY = (1 - p) * (above ? 8 : -8);
    const scale = closing
      ? interpolate(p, [0.55, 1], [0.84, 1], Extrapolation.CLAMP)
      : interpolate(p, [0, 1], [0.92, 1], Extrapolation.CLAMP);
    return {
      opacity,
      transform: [
        { translateY: shiftY },
        { scale },
      ],
    };
  });
  const borderStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const closing = isClosing.value === 1;
    return {
      opacity: closing
        ? interpolate(p, [0.72, 1], [0, 1], Extrapolation.CLAMP)
        : interpolate(p, [0.45, 1], [0, 1], Extrapolation.CLAMP),
    };
  });

  const scrollable = contentRawH > maxH + 2;
  const ContentContainer = scrollable ? ScrollView : View;
  const containerProps = scrollable
    ? { style: { maxHeight: maxH }, showsVerticalScrollIndicator: false, bounces: false }
    : null;

  const contentAnchorStyle = {
    width: menuW,
    position: 'absolute',
    [alignRight ? 'right' : 'left']: 0,
    [above ? 'bottom' : 'top']: 0,
    transformOrigin: `${above ? 'bottom' : 'top'} ${alignRight ? 'right' : 'left'}`,
  };

  const renderRows = () => (
    <View style={{ paddingVertical: large ? 8 : 6 }} testID={testID}>
      {header ? header : title ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8 }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, fontWeight: '500' }}>
            {title}
          </Text>
        </View>
      ) : null}
      {header || title ? (
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder, marginHorizontal: 14, marginBottom: 2 }} />
      ) : null}
      {children}
      {items.map((item, i) => {
        if (item.type === 'section') {
          return (
            <View
              key={item.key}
              accessible
              accessibilityRole="header"
              style={{ flexDirection: 'row', alignItems: 'center', paddingTop: i > 0 ? 10 : 6, paddingBottom: 4, paddingHorizontal: 16 }}
            >
              <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: 12.5, fontWeight: '600' }}>
                {item.label}
              </Text>
              {item.count != null ? (
                <Text style={{ color: colors.ink3, fontSize: 12, marginRight: 24, fontVariant: ['tabular-nums'] }}>
                  {item.count}
                </Text>
              ) : null}
            </View>
          );
        }
        const subText = item.detail ?? item.sub;
        const hasIcon = !!item.icon;
        const showCheck = item.selected !== undefined;
        const prevItem = i > 0 ? items[i - 1] : null;
        const showSep = i > 0 && !large && prevItem?.type !== 'section';
        return (
          <Fragment key={item.key}>
            {showSep ? (
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: colors.glassBorder,
                  marginLeft: hasIcon ? 52 : (item.indent ? 28 : 16),
                  marginRight: 16,
                }}
              />
            ) : null}
            <Pressable
              onPress={() => select(item)}
              disabled={item.disabled}
              testID={item.testID}
              accessibilityRole={item.accessibilityRole || 'menuitem'}
              accessibilityState={item.selected !== undefined ? { selected: !!item.selected, disabled: !!item.disabled } : (item.disabled ? { disabled: true } : undefined)}
              accessibilityLabel={item.accessibilityLabel || [item.label, item.badge, item.count != null ? `${item.count} 个对话` : '', subText].filter(Boolean).join('，')}
              style={({ pressed }) => ({
                minHeight: large ? 60 : 48,
                marginHorizontal: large ? 8 : 6,
                paddingLeft: large ? 8 : (item.indent ? 24 : 10),
                paddingRight: large ? 8 : 10,
                paddingVertical: large ? 6 : 8,
                borderRadius: large ? 24 : 16,
                borderCurve: 'continuous',
                flexDirection: 'row',
                alignItems: 'center',
                gap: large ? 14 : 12,
                backgroundColor: pressed ? colors.glassPressed : 'transparent',
                opacity: item.disabled ? 0.45 : 1,
              })}
            >
              {hasIcon ? (
                <View
                  style={large
                    ? { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.controlFill }
                    : { width: 24, alignItems: 'center' }}
                >
                  <Icon name={item.icon} size={large ? 21 : 19} color={item.tone === 'danger' ? colors.danger : colors.ink} />
                </View>
              ) : null}
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text
                    numberOfLines={1}
                    style={{
                      flexShrink: 1,
                      color: item.tone === 'danger' ? colors.danger : colors.inkStrong,
                      fontSize: large ? 17 : 15.5,
                      fontWeight: large ? '400' : '500',
                    }}
                  >
                    {item.label}
                  </Text>
                  {item.badge ? (
                    <Text style={{ color: colors.ink3, fontSize: 11.5 }}>{item.badge}</Text>
                  ) : null}
                </View>
                {subText ? (
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={{
                      color: item.detailTone === 'danger' ? colors.danger : colors.ink2,
                      fontSize: 12.5,
                      marginTop: 2,
                    }}
                  >
                    {subText}
                  </Text>
                ) : null}
              </View>
              {item.count != null ? (
                <Text style={{ color: colors.ink3, fontSize: 12.5, fontVariant: ['tabular-nums'] }}>
                  {item.count}
                </Text>
              ) : null}
              {showCheck ? (
                <View style={{ width: 20, alignItems: 'center', justifyContent: 'center' }}>
                  {item.selected ? <Icon name="check" size={17} strokeWidth={2.2} color={colors.accent} /> : null}
                </View>
              ) : null}
              {item.chevron ? <Icon name="chevronRight" size={16} color={colors.ink3} /> : null}
            </Pressable>
          </Fragment>
        );
      })}
    </View>
  );

  const Wrapper = glass ? GlassContainer : View;
  const wrapperProps = glass
    ? { spacing: MERGE_SPACING, style: StyleSheet.absoluteFill, pointerEvents: 'box-none' }
    : { style: StyleSheet.absoluteFill, pointerEvents: 'box-none' };

  return (
    <Modal
      transparent
      visible={mounted}
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      onShow={() => visible && startOpen()}
      onDismiss={flush}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="关闭菜单"
      />
      <Wrapper {...wrapperProps}>
        <Animated.View pointerEvents="none" style={orbStyle}>
          {glass ? (
            <GlassView
              pointerEvents="none"
              glassEffectStyle="regular"
              tintColor={colors.glassTint}
              colorScheme={dark ? 'dark' : 'light'}
              style={[StyleSheet.absoluteFill, { borderRadius: ballSize / 2, borderCurve: 'continuous' }]}
            />
          ) : null}
        </Animated.View>

        <Animated.View accessibilityViewIsModal style={shellStyle}>
          {glass ? (
            <GlassView
              pointerEvents="none"
              glassEffectStyle="regular"
              tintColor={colors.glassTint}
              colorScheme={dark ? 'dark' : 'light'}
              style={[StyleSheet.absoluteFill, { borderRadius: targetRadius, borderCurve: 'continuous' }]}
            />
          ) : null}
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: targetRadius,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: colors.glassBorder,
              },
              borderStyle,
            ]}
          />
          <Animated.View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }, clipStyle]}>
            <Animated.View style={[contentAnchorStyle, contentAnimStyle]} accessibilityRole="menu">
              <ContentContainer {...containerProps}>
                <View onLayout={onContentLayout}>
                  {renderRows()}
                </View>
              </ContentContainer>
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </Wrapper>
    </Modal>
  );
}
