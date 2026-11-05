import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeInDown, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from '../../../web/core/bus.js';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { NativeBlurView } from './ProgressiveBlur.js';
import { copyText } from '../lib/clipboard.js';
import { haptics } from '../lib/haptics.js';
import { usePref } from '../lib/prefs.js';
import { useTheme } from '../theme.js';

const MENU_WIDTH = 220;

function MenuRow({ label, icon, onPress }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="menuitem" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48, marginHorizontal: 6, paddingHorizontal: 14, borderRadius: 16, borderCurve: 'continuous',
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        backgroundColor: pressed ? colors.glassPressed : 'transparent',
      })}>
      <Text style={{ color: colors.inkStrong, fontSize: 16 }}>{label}</Text>
      <Icon name={icon} size={20} color={colors.ink} />
    </Pressable>
  );
}

// 长按回复浮起消息卡片 + 操作菜单；「选择文本」后卡片原地变为可拖选。
// iOS 的 <Text selectable> 只能整段拷贝，只读 TextInput 底层是 UITextView，才支持任意范围选择。
export function MessageActionSheet({ text, onClose }) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const scale = usePref('fontScale');
  const [selecting, setSelecting] = useState(false);
  const textStyle = { color: colors.inkStrong, fontSize: 17 * scale, lineHeight: Math.round(28 * scale) };
  const cardMaxH = screenH - insets.top - insets.bottom - (selecting ? 120 : 240);

  const copy = async () => {
    if (!(await copyText(text))) return;
    haptics.success();
    toast('已复制', 'info');
    onClose();
  };
  const share = () => {
    onClose();
    Share.share({ message: text }).catch(() => {});
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      {NativeBlurView ? (
        <NativeBlurView intensity={28} tint={dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: dark ? 'rgba(0,0,0,0.45)' : 'rgba(20,16,12,0.22)' }]} />
      <View pointerEvents="box-none"
        style={{ flex: 1, justifyContent: 'center', gap: 10, paddingHorizontal: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }}>
        <Animated.View entering={ZoomIn.springify().damping(20).stiffness(260)}
          style={{ maxHeight: cardMaxH, backgroundColor: colors.bubble, borderRadius: 26, borderCurve: 'continuous', overflow: 'hidden' }}>
          {Platform.OS === 'ios' ? (
            <TextInput value={text} editable={false} multiline scrollEnabled
              style={[textStyle, { maxHeight: cardMaxH, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 14 }]} />
          ) : (
            <ScrollView style={{ maxHeight: cardMaxH }} contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 14 }}>
              <Text selectable style={textStyle}>{text}</Text>
            </ScrollView>
          )}
        </Animated.View>
        {selecting ? (
          <Animated.View key="done" entering={FadeIn.duration(160)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: colors.ink2, fontSize: 13, marginLeft: 4 }}>长按文字，拖动两端选择</Text>
            <Pressable accessibilityRole="button" onPress={onClose}>
              <GlassSurface variant="pill" style={{ borderRadius: 22, minHeight: 44, paddingHorizontal: 22, justifyContent: 'center' }}>
                <Text style={{ color: colors.inkStrong, fontSize: 15, fontWeight: '600' }}>完成</Text>
              </GlassSurface>
            </Pressable>
          </Animated.View>
        ) : (
          <Animated.View key="menu" entering={FadeInDown.springify().damping(22).stiffness(280)} style={{ width: MENU_WIDTH }}>
            <GlassSurface style={{ borderRadius: 24, paddingVertical: 6 }}>
              <View accessibilityRole="menu">
                <MenuRow label="复制" icon="copy" onPress={copy} />
                <MenuRow label="选择文本" icon="textSelect" onPress={() => { haptics.selection(); setSelecting(true); }} />
                <MenuRow label="分享" icon="share" onPress={share} />
              </View>
            </GlassSurface>
          </Animated.View>
        )}
      </View>
    </Modal>
  );
}
