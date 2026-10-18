import { Fragment, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { spring, useTheme } from '../theme.js';

const MENU_WIDTH = 248;
const GAP = 8;
const EDGE = 12;

// 液态玻璃下拉菜单：锚定在触发按钮下方，从按钮所在角「弹出」。
// anchor 为触发元素的 measureInWindow 结果 { x, y, width, height }。
// 只对玻璃容器做 scale 变换，透明度动画仅作用于玻璃内部的内容层（见 GlassSurface 约束）。
// 选项的 onPress 在菜单 Modal 完全卸载后再执行，避免与后续 Alert / BottomSheet 抢占呈现层。
export function GlassMenu({ visible, anchor, items, onClose }) {
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

  useEffect(() => {
    if (visible) {
      setMounted(true);
      progress.stopAnimation();
      Animated.spring(progress, { toValue: 1, damping: 20, stiffness: 320, mass: 0.9, useNativeDriver: true }).start();
    } else if (mounted) {
      progress.stopAnimation();
      Animated.timing(progress, { toValue: 0, duration: 150, easing: Easing.bezier(...spring), useNativeDriver: true })
        .start(() => {
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

  const right = Math.max(EDGE, screenW - (anchor.x + anchor.width));
  const top = anchor.y + anchor.height + GAP;
  const width = Math.min(MENU_WIDTH, screenW - EDGE * 2);

  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] });
  const contentOpacity = progress.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, 0.6, 1], extrapolate: 'clamp' });

  return (
    <Modal transparent visible={mounted} animationType="none" statusBarTranslucent onRequestClose={onClose} onDismiss={flush}>
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
          top,
          right,
          width,
          maxHeight: screenH - top - EDGE * 3,
          transformOrigin: 'top right',
          transform: [{ translateY }, { scale }],
        }}
      >
        <GlassSurface style={{ borderRadius: 24 }}>
          <Animated.View accessibilityRole="menu" style={{ opacity: contentOpacity, paddingVertical: 6 }}>
            {items.map((item, i) => (
              <Fragment key={item.key}>
                {i > 0 ? (
                  <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder, marginLeft: 52, marginRight: 16 }} />
                ) : null}
                <Pressable
                  onPress={() => select(item)}
                  testID={item.testID}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.detail ? `${item.label}，${item.detail}` : item.label}
                  style={({ pressed }) => ({
                    minHeight: 48,
                    marginHorizontal: 6,
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
                  <View style={{ width: 24, alignItems: 'center' }}>
                    <Icon name={item.icon} size={19} color={item.tone === 'danger' ? colors.danger : colors.ink} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ color: item.tone === 'danger' ? colors.danger : colors.inkStrong, fontSize: 15.5, fontWeight: '500' }}>
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
