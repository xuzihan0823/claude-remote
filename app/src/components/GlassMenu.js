import { Fragment, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { useTheme } from '../theme.js';

const MENU_WIDTH = 248;
const GAP = 8;
const EDGE = 12;
const CLOSE_MS = 180;
const GLASS_DISSOLVE = { style: 'none', animate: true, animationDuration: CLOSE_MS / 1000 };

// 液态玻璃下拉菜单：锚定在触发按钮下方，从按钮所在角「弹出」。
// anchor 为触发元素的 measureInWindow 结果 { x, y, width, height }。
// 只对玻璃容器做 scale 变换，透明度动画仅作用于玻璃内部的内容层（见 GlassSurface 约束）。
// 选项的 onPress 在菜单 Modal 完全卸载后再执行，避免与后续 Alert / BottomSheet 抢占呈现层。
// placement="above" 时菜单左对齐、从按钮上方弹出（用于底部输入栏）；size="large" 为大行 + 圆底图标、无分隔线。
export function GlassMenu({ visible, anchor, items, onClose, placement = 'below', size = 'regular' }) {
  const { colors } = useTheme();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [mounted, setMounted] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const pending = useRef(null);

  const flush = () => {
    const run = pending.current;
    pending.current = null;
    run?.();
  };

  const open = () => {
    progress.stopAnimation();
    Animated.spring(progress, { toValue: 1, damping: 20, stiffness: 320, mass: 0.9, useNativeDriver: true }).start();
  };

  // 首次打开等 Modal onShow 再起动画：Modal 呈现是异步的，提前起跑会丢掉开头几帧，菜单像是「跳」出来
  useEffect(() => {
    if (visible) {
      if (mounted) open();
      else setMounted(true);
    } else if (mounted) {
      progress.stopAnimation();
      Animated.timing(progress, { toValue: 0, duration: CLOSE_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true })
        .start(({ finished }) => {
          if (!finished) return;
          setMounted(false);
          // iOS 优先由 Modal.onDismiss 触发；其它平台无该回调，兜底定时执行（flush 幂等）
          setTimeout(flush, Platform.OS === 'ios' ? 400 : 0);
        });
    }
  }, [visible]);

  if (!anchor) return null;

  const select = (item) => {
    pending.current = item.onPress;
    onClose?.();
  };

  const above = placement === 'above';
  const large = size === 'large';
  const width = Math.min(MENU_WIDTH, screenW - EDGE * 2);
  const position = above
    ? { bottom: screenH - anchor.y + GAP, left: Math.max(EDGE, anchor.x), maxHeight: anchor.y - GAP - EDGE * 4, transformOrigin: 'bottom left' }
    : { top: anchor.y + anchor.height + GAP, right: Math.max(EDGE, screenW - (anchor.x + anchor.width)), maxHeight: screenH - (anchor.y + anchor.height + GAP) - EDGE * 3, transformOrigin: 'top right' };

  // 收起时玻璃不能靠透明度淡出，缩到 0.35 会剩一块不透明的玻璃停到 Modal 卸载（录屏可见）。
  // 改为原生动画把玻璃材质消融掉，外层只做轻微收缩，再把剩下的描边和阴影一起淡出
  const closing = !visible;
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [closing ? 0.9 : 0.35, 1] });
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [above ? 6 : -6, 0] });
  const contentOpacity = progress.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, 0.6, 1], extrapolate: 'clamp' });
  const shellOpacity = closing ? progress : 1;

  return (
    <Modal transparent visible={mounted} animationType="none" statusBarTranslucent onRequestClose={onClose} onShow={() => visible && open()} onDismiss={flush}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="关闭菜单"
      />
      <Animated.View
        accessibilityViewIsModal
        style={{
          position: 'absolute',
          ...position,
          width,
          transform: [{ translateY }, { scale }],
          opacity: shellOpacity,
        }}
      >
        <GlassSurface style={{ borderRadius: large ? 32 : 24 }} effectStyle={closing ? GLASS_DISSOLVE : 'regular'}>
          <Animated.View accessibilityRole="menu" style={{ opacity: contentOpacity, paddingVertical: large ? 8 : 6 }}>
            {items.map((item, i) => (
              <Fragment key={item.key}>
                {i > 0 && !large ? (
                  <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder, marginLeft: 52, marginRight: 16 }} />
                ) : null}
                <Pressable
                  onPress={() => select(item)}
                  testID={item.testID}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.detail ? `${item.label}，${item.detail}` : item.label}
                  style={({ pressed }) => ({
                    minHeight: large ? 60 : 48,
                    marginHorizontal: large ? 8 : 6,
                    paddingHorizontal: large ? 8 : 10,
                    paddingVertical: large ? 6 : 8,
                    borderRadius: large ? 24 : 16,
                    borderCurve: 'continuous',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: large ? 14 : 12,
                    backgroundColor: pressed ? colors.glassPressed : 'transparent',
                  })}
                >
                  <View style={large
                    ? { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.controlFill }
                    : { width: 24, alignItems: 'center' }}
                  >
                    <Icon name={item.icon} size={large ? 21 : 19} color={item.tone === 'danger' ? colors.danger : colors.ink} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ color: item.tone === 'danger' ? colors.danger : colors.inkStrong, fontSize: large ? 17 : 15.5, fontWeight: large ? '400' : '500' }}>
                      {item.label}
                    </Text>
                    {item.detail ? (
                      <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: item.detailTone === 'danger' ? colors.danger : colors.ink2, fontSize: 12.5, marginTop: 2 }}>
                        {item.detail}
                      </Text>
                    ) : null}
                  </View>
                  {item.chevron ? <Icon name="chevronRight" size={16} color={colors.ink3} /> : null}
                </Pressable>
              </Fragment>
            ))}
          </Animated.View>
        </GlassSurface>
      </Animated.View>
    </Modal>
  );
}
