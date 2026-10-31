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
  FadeIn,
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
import { haptics } from '../lib/haptics.js';
import { useTheme } from '../theme.js';

const MENU_WIDTH = 252;
const GAP = 8;
const EDGE = 12;
const OPEN_SPRING = { damping: 24, stiffness: 310, mass: 0.85 };
const SIZE_SPRING = { damping: 24, stiffness: 340, mass: 0.8 };
const CLOSE_MS = 270;
const CLOSE_EASING = Easing.bezier(0.3, 0, 0.15, 1);
const MERGE_SPACING = 30;

function estimateMenuHeight({ items, title, header, large, maxH, expandedKey }) {
  const padV = (large ? 8 : 6) * 2;
  const headerH = header ? 44 : title ? 34 : 0;
  const expIdx = expandedKey ? (items || []).findIndex((it) => it.key === expandedKey) : -1;
  if (expIdx >= 0) {
    const expItem = items[expIdx];
    const aboveH = items.slice(0, expIdx).reduce((sum, item) => (
      item.type === 'section' ? sum + 32 : sum + (item.detail || item.sub ? 54 : 48)
    ), 0);
    const subH = (expItem.subItems || []).reduce((sum, sub) => (
      sum + (sub.detail || sub.sub ? 52 : 46)
    ), 0);
    return Math.min(Math.max(padV + headerH + aboveH + 52 + subH + 14, 56), maxH);
  }
  const rowsH = (items || []).reduce((sum, item) => {
    if (item.type === 'section') return sum + 32;
    if (large) return sum + 60;
    return sum + (item.detail || item.sub ? 54 : 48);
  }, 0);
  return Math.min(Math.max(padV + headerH + rowsH, 56), maxH);
}

// 液态玻璃下拉/上拉菜单：
// - 支持两种展开锚点形态：
//   1. morphAnchor=true（如顶栏右上角「新建会话 + 更多选项」胶囊）：直接从整个胶囊原位尺寸膨胀变形为下拉框，收起时缩回该胶囊；
//   2. 默认模式：从触发按钮向目标方向弹簧伸展，并在收起时与触发按钮锚点球产生液态玻璃融合；
// - 支持菜单项内嵌「内层下拉框」（item.subItems）：点击后上方条目保留并半透明淡化，当前项原位浮起圆角内层下拉框展示子项。
export function GlassMenu({
  visible,
  anchor,
  items = [],
  title,
  header,
  children,
  renderContent,
  onClose,
  onAfterClose,
  placement = 'below',
  size = 'regular',
  width: customWidth,
  height: customHeight,
  coverAnchor = false,
  morphAnchor = false,
  anchorSnapshot = null,
  testID,
}) {
  const { colors, dark } = useTheme();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [mounted, setMounted] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const [contentRawH, setContentRawH] = useState(0);
  const [expandedKey, setExpandedKey] = useState(null);
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

  const anchorTopEdge = morphAnchor
    ? resolvedAnchor.y
    : resolvedAnchor.y + resolvedAnchor.height + GAP;
  const anchorBottomEdge = coverAnchor || morphAnchor
    ? resolvedAnchor.y + resolvedAnchor.height
    : resolvedAnchor.y - GAP;

  const maxH = above
    ? Math.max(160, anchorBottomEdge - EDGE * 4)
    : Math.max(160, screenH - anchorTopEdge - EDGE * 3);

  const estH = customHeight
    ? Math.min(Math.max(customHeight, 56), maxH)
    : estimateMenuHeight({ items, title, header, large, maxH, expandedKey });
  const targetH = useSharedValue(estH);
  const targetW = useSharedValue(menuW);
  const targetBottom = useSharedValue(anchorBottomEdge);

  useEffect(() => {
    if (!mounted) {
      measuredOnce.current = false;
      setContentRawH(0);
      setExpandedKey(null);
      targetH.value = estH;
      targetW.value = menuW;
      targetBottom.value = anchorBottomEdge;
      return;
    }
    if (Math.abs(targetW.value - menuW) > 1) {
      targetW.value = withSpring(menuW, SIZE_SPRING);
    }
    if (Math.abs(targetBottom.value - anchorBottomEdge) > 1) {
      targetBottom.value = withSpring(anchorBottomEdge, SIZE_SPRING);
    }
    if (customHeight && Math.abs(targetH.value - estH) > 1) {
      targetH.value = withSpring(estH, SIZE_SPRING);
    }
  }, [mounted, estH, menuW, anchorBottomEdge, customHeight]);

  const flush = () => {
    const run = pending.current;
    pending.current = null;
    run?.();
  };

  const finishClose = () => {
    setMounted(false);
    onAfterClose?.();
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

  const closeWith = (fn) => {
    pending.current = fn;
    onClose?.();
  };

  const select = (item) => {
    if (item.disabled) return;
    if (Array.isArray(item.subItems) && item.subItems.length > 0) {
      haptics.selection();
      setExpandedKey((cur) => (cur === item.key ? null : item.key));
      return;
    }
    if (item.keepOpen) {
      item.onPress?.();
      return;
    }
    closeWith(item.onPress);
  };

  const alignRight = resolvedAnchor.x + resolvedAnchor.width / 2 >= screenW / 2;

  const startW = morphAnchor
    ? Math.max(resolvedAnchor.width, 48)
    : Math.min(Math.max(Math.min(resolvedAnchor.width, resolvedAnchor.height), 40), 48);
  const startH = morphAnchor
    ? Math.max(resolvedAnchor.height, 44)
    : startW;

  const ballSize = Math.min(Math.max(Math.min(resolvedAnchor.width, resolvedAnchor.height), 40), 48);
  const ballCx = alignRight
    ? resolvedAnchor.x + resolvedAnchor.width - ballSize / 2
    : resolvedAnchor.x + ballSize / 2;
  const ballCy = resolvedAnchor.y + resolvedAnchor.height / 2;
  const ballLeft = morphAnchor ? resolvedAnchor.x : ballCx - ballSize / 2;
  const ballTop = morphAnchor ? resolvedAnchor.y : ballCy - ballSize / 2;

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

  // 锚点水滴球：非 morphAnchor 模式下与菜单玻璃球在 GlassContainer 中融合
  const orbStyle = useAnimatedStyle(() => {
    if (morphAnchor) {
      return { position: 'absolute', width: 0, height: 0, opacity: 0 };
    }
    const p = Math.max(0, Math.min(1, progress.value));
    const closing = isClosing.value === 1;
    const menuH = targetH.value;
    const curW = targetW.value;
    const bottomEdge = targetBottom.value;
    const curMenuLeft = alignRight
      ? Math.max(EDGE, Math.min(screenW - EDGE - curW, resolvedAnchor.x + resolvedAnchor.width - curW))
      : Math.max(EDGE, Math.min(screenW - EDGE - curW, resolvedAnchor.x));
    const fullTop = above ? bottomEdge - menuH : anchorTopEdge;
    const cornerLeft = alignRight ? curMenuLeft + curW - ballSize : curMenuLeft;
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

  const shellFrame = (rawP, closing, menuH) => {
    'worklet';
    const p = Math.max(0, Math.min(1, rawP));
    const curW = targetW.value;
    const bottomEdge = targetBottom.value;
    const curMenuLeft = alignRight
      ? Math.max(EDGE, Math.min(screenW - EDGE - curW, resolvedAnchor.x + resolvedAnchor.width - curW))
      : Math.max(EDGE, Math.min(screenW - EDGE - curW, resolvedAnchor.x));

    if (morphAnchor) {
      const pW = closing ? Math.pow(p, 1.25) : rawP;
      const pH = closing ? Math.pow(p, 1.35) : rawP;
      const width = Math.max(startW * 0.92, startW + (curW - startW) * pW);
      const height = Math.max(startH * 0.92, startH + (menuH - startH) * pH);
      const anchorRight = resolvedAnchor.x + startW;
      const targetRight = curMenuLeft + curW;
      const rightEdge = anchorRight + (targetRight - anchorRight) * p;
      const left = alignRight
        ? rightEdge - width
        : resolvedAnchor.x + (curMenuLeft - resolvedAnchor.x) * p;
      const top = resolvedAnchor.y;
      const pillRadius = startH / 2;
      const radius = pillRadius + (targetRadius - pillRadius) * Math.min(1, p * 1.4);
      return {
        p,
        left,
        top,
        width,
        height,
        borderRadius: Math.min(width / 2, height / 2, radius),
      };
    }

    const pW = closing ? Math.pow(p, 1.48) : rawP;
    const pH = closing ? Math.pow(p, 1.72) : rawP;
    const pPosY = closing ? Math.pow(p, 0.85) : rawP;
    const pPosX = closing ? Math.pow(p, 0.9) : rawP;

    const width = Math.max(ballSize * 0.85, ballSize + (curW - ballSize) * pW);
    const height = Math.max(ballSize * 0.85, ballSize + (menuH - ballSize) * pH);

    const diagShiftX = closing ? Math.sin(p * Math.PI) * (alignRight ? -9 : 9) : 0;
    const left = (alignRight
      ? (ballLeft + ballSize) + ((curMenuLeft + curW) - (ballLeft + ballSize)) * pPosX - width
      : ballLeft + (curMenuLeft - ballLeft) * pPosX) + diagShiftX;

    const fullTop = above ? bottomEdge - menuH : anchorTopEdge;
    const top = above
      ? (ballTop + ballSize) + (bottomEdge - (ballTop + ballSize)) * pPosY - height
      : ballTop + (fullTop - ballTop) * pPosY;
    return {
      p,
      left,
      top,
      width,
      height,
      borderRadius: Math.min(width / 2, height / 2, targetRadius),
    };
  };

  const shellStyle = useAnimatedStyle(() => {
    const closing = isClosing.value === 1;
    const { p, left, top, width, height, borderRadius } = shellFrame(progress.value, closing, targetH.value);
    const shellOpacity = morphAnchor
      ? 1
      : closing
        ? interpolate(p, [0, 0.14], [0, 1], Extrapolation.CLAMP)
        : 1;

    return {
      position: 'absolute',
      left,
      top,
      width,
      height,
      borderRadius,
      borderCurve: 'continuous',
      backgroundColor: glass ? 'transparent' : colors.card,
      shadowColor: dark ? '#000000' : '#241E17',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: (dark ? 0.34 : 0.1) * interpolate(p, [0.15, 1], [0.25, 1], Extrapolation.CLAMP),
      shadowRadius: 20,
      opacity: shellOpacity,
    };
  });

  const frameStyle = useAnimatedStyle(() => {
    const { left, top, width, height, borderRadius } = shellFrame(progress.value, isClosing.value === 1, targetH.value);
    return {
      position: 'absolute',
      left,
      top,
      width,
      height,
      borderRadius,
      borderCurve: 'continuous',
      overflow: 'hidden',
    };
  });

  // 胶囊原位变形时，胶囊内的原始按钮图标在展开前段迅速淡出、收起末段重新浮现
  const snapshotStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    return {
      position: 'absolute',
      top: 0,
      right: alignRight ? 0 : undefined,
      left: alignRight ? undefined : 0,
      width: startW,
      height: startH,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: interpolate(p, [0, 0.24], [1, 0], Extrapolation.CLAMP),
    };
  });

  const contentAnimStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const closing = isClosing.value === 1;
    const opacity = closing
      ? interpolate(p, [0.58, 1], [0, 1], Extrapolation.CLAMP)
      : interpolate(p, [0.18, 0.82], [0, 1], Extrapolation.CLAMP);
    const shiftY = (1 - p) * (above ? 8 : -8);
    const scale = closing
      ? interpolate(p, [0.5, 1], [0.86, 1], Extrapolation.CLAMP)
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
      opacity: morphAnchor
        ? 1
        : closing
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

  const renderSingleRow = (item, i, list, { dimmed = false, insideSub = false } = {}) => {
    if (item.type === 'section') {
      return (
        <View
          key={item.key}
          accessible
          accessibilityRole="header"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingTop: i > 0 ? 10 : 6,
            paddingBottom: 4,
            paddingHorizontal: 16,
            opacity: dimmed ? 0.38 : 1,
          }}
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
    const prevItem = i > 0 ? list[i - 1] : null;
    const showSep = i > 0 && !large && prevItem?.type !== 'section';
    const hasSubItems = Array.isArray(item.subItems) && item.subItems.length > 0;
    return (
      <Fragment key={item.key}>
        {showSep ? (
          <View
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: colors.glassBorder,
              marginLeft: hasIcon ? 50 : (item.indent ? 28 : 16),
              marginRight: 16,
              opacity: dimmed ? 0.38 : 1,
            }}
          />
        ) : null}
        <Pressable
          onPress={() => {
            if (dimmed) {
              haptics.selection();
              setExpandedKey(null);
              return;
            }
            select(item);
          }}
          disabled={item.disabled}
          testID={item.testID}
          accessibilityRole={item.accessibilityRole || 'menuitem'}
          accessibilityState={item.selected !== undefined ? { selected: !!item.selected, disabled: !!item.disabled } : (item.disabled ? { disabled: true } : undefined)}
          accessibilityLabel={item.accessibilityLabel || [item.label, item.badge, item.count != null ? `${item.count} 个对话` : '', subText].filter(Boolean).join('，')}
          style={({ pressed }) => ({
            minHeight: large ? 60 : (insideSub ? 46 : 48),
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
            opacity: item.disabled ? 0.45 : (dimmed ? 0.38 : 1),
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
          {item.chevron || hasSubItems ? <Icon name="chevronRight" size={16} color={colors.ink3} /> : null}
        </Pressable>
      </Fragment>
    );
  };

  const renderRows = () => {
    const expIdx = expandedKey ? items.findIndex((it) => it.key === expandedKey) : -1;
    const expItem = expIdx >= 0 ? items[expIdx] : null;
    const hasExpanded = !!expItem && Array.isArray(expItem.subItems);

    return (
      <View style={{ paddingVertical: large ? 8 : 6 }} testID={testID}>
        {header ? header : title ? (
          <Pressable
            disabled={!hasExpanded}
            onPress={() => {
              if (hasExpanded) {
                haptics.selection();
                setExpandedKey(null);
              }
            }}
            style={{
              paddingHorizontal: 16,
              paddingTop: 6,
              paddingBottom: 8,
              opacity: hasExpanded ? 0.38 : 1,
            }}
          >
            <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, fontWeight: '500' }}>
              {title}
            </Text>
          </Pressable>
        ) : null}
        {header || title ? (
          <View
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: colors.glassBorder,
              marginHorizontal: 14,
              marginBottom: 2,
              opacity: hasExpanded ? 0.38 : 1,
            }}
          />
        ) : null}
        {children}
        {hasExpanded ? (
          <>
            {items.slice(0, expIdx).map((it, idx, arr) => renderSingleRow(it, idx, arr, { dimmed: true }))}
            <Animated.View
              entering={FadeIn.duration(170)}
              style={{
                marginHorizontal: 3,
                marginTop: expIdx > 0 || title ? 4 : 0,
                marginBottom: 2,
                paddingVertical: 4,
                borderRadius: 23,
                borderCurve: 'continuous',
                backgroundColor: dark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.78)',
                borderWidth: 1,
                borderColor: colors.glassBorder,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: dark ? 0.32 : 0.08,
                shadowRadius: 12,
              }}
            >
              <Pressable
                onPress={() => {
                  haptics.selection();
                  setExpandedKey(null);
                }}
                testID={expItem.testID}
                accessibilityRole="menuitem"
                accessibilityState={{ expanded: true }}
                style={({ pressed }) => ({
                  minHeight: 46,
                  marginHorizontal: 5,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderRadius: 16,
                  borderCurve: 'continuous',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  backgroundColor: pressed ? colors.glassPressed : 'transparent',
                })}
              >
                {expItem.icon ? (
                  <View style={{ width: 24, alignItems: 'center' }}>
                    <Icon name={expItem.icon} size={19} color={colors.inkStrong} />
                  </View>
                ) : null}
                <Text
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    color: colors.inkStrong,
                    fontSize: 15.5,
                    fontWeight: '600',
                  }}
                >
                  {expItem.label}
                </Text>
                <Icon name="chevron" size={16} color={colors.ink2} />
              </Pressable>
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: colors.glassBorder,
                  marginHorizontal: 14,
                  marginVertical: 2,
                }}
              />
              {expItem.subItems.map((sub, idx, arr) => renderSingleRow(sub, idx, arr, { insideSub: true }))}
            </Animated.View>
          </>
        ) : (
          items.map((item, i) => renderSingleRow(item, i, items))
        )}
      </View>
    );
  };

  // GlassContainer 内部的 UIVisualEffectView 会吞掉所有触摸（box-none 拦不住原生子视图），
  // 所以玻璃层整体 pointerEvents="none"，可点的内容放在其上方独立的一层。
  const Wrapper = glass ? GlassContainer : View;
  const wrapperProps = glass
    ? { spacing: MERGE_SPACING, style: StyleSheet.absoluteFill, pointerEvents: 'none' }
    : { style: StyleSheet.absoluteFill, pointerEvents: 'none' };

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
        <Animated.View style={orbStyle}>
          {glass && !morphAnchor ? (
            <GlassView
              glassEffectStyle="regular"
              tintColor={colors.glassTint}
              colorScheme={dark ? 'dark' : 'light'}
              style={[StyleSheet.absoluteFill, { borderRadius: ballSize / 2, borderCurve: 'continuous' }]}
            />
          ) : null}
        </Animated.View>

        <Animated.View style={shellStyle}>
          {glass ? (
            <GlassView
              glassEffectStyle="regular"
              tintColor={colors.glassTint}
              colorScheme={dark ? 'dark' : 'light'}
              style={[StyleSheet.absoluteFill, { borderRadius: targetRadius, borderCurve: 'continuous' }]}
            />
          ) : null}
        </Animated.View>
      </Wrapper>

      <Animated.View accessibilityViewIsModal style={frameStyle}>
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
        {morphAnchor && anchorSnapshot ? (
          <Animated.View pointerEvents="none" style={snapshotStyle}>
            {anchorSnapshot}
          </Animated.View>
        ) : null}
        <Animated.View style={[contentAnchorStyle, contentAnimStyle]} accessibilityRole="menu">
          {renderContent ? (
            <View style={{ width: menuW, height: estH }} onLayout={onContentLayout}>
              {renderContent({ closeWith, width: menuW, height: estH })}
            </View>
          ) : (
            <ContentContainer {...containerProps}>
              <View onLayout={onContentLayout}>
                {renderRows()}
              </View>
            </ContentContainer>
          )}
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}
