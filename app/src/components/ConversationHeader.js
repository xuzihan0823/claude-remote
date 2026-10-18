import { useState } from 'react';
import { ActionSheetIOS, Alert, Keyboard, Pressable, Text, View } from 'react-native';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { ModeSheet } from './composer/ModeSheet.js';
import { useTheme } from '../theme.js';

const MODE_LABELS = { default: '标准', acceptEdits: '自动编辑', plan: '规划', bypassPermissions: 'Bypass' };

// 顶栏：左侧抽屉按钮；右侧三点菜单承载「会话信息 / 选择工作目录 / 权限模式」。
// 设置入口统一放在侧栏底部，不再出现在三点菜单里。
export function ConversationHeader({ title, subtitle, details, newChat = false, onNewChat, mode, onModeChange, showModeSelector = false, onPickCwd, cwdLabel }) {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const [modeOpen, setModeOpen] = useState(false);
  const buttonStyle = ({ pressed }) => ({
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: pressed ? colors.glassPressed : 'transparent',
  });
  const hasMode = showModeSelector && !!mode;
  const openMenu = () => {
    Keyboard.dismiss();
    const items = [];
    if (details) items.push({ label: '会话信息', run: () => Alert.alert(title || '会话信息', details) });
    if (onPickCwd) items.push({ label: cwdLabel ? `工作目录：${cwdLabel}` : '选择工作目录', run: onPickCwd });
    if (hasMode) items.push({ label: `权限模式：${MODE_LABELS[mode] || '标准'}`, run: () => setModeOpen(true) });
    const options = [...items.map((i) => i.label), '取消'];
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1 }, (index) => {
      items[index]?.run();
    });
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
      <GlassSurface interactive variant="pill" style={{ borderRadius: 24 }}>
        <Pressable style={buttonStyle} onPress={() => navigation.dispatch(DrawerActions.openDrawer())} testID="header-open-drawer" accessibilityRole="button" accessibilityLabel="打开会话列表">
          <Icon name="menu" />
        </Pressable>
      </GlassSurface>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
        {title ? <Text numberOfLines={1} style={{ color: colors.inkStrong, fontSize: 15, fontWeight: '500' }}>{title}</Text> : null}
        {subtitle}
      </View>
      <GlassSurface interactive variant="pill" style={{ borderRadius: 24, flexDirection: 'row' }}>
        {newChat ? <Pressable style={buttonStyle} onPress={onNewChat || (() => navigation.navigate('Home'))} testID="header-new-chat" accessibilityRole="button" accessibilityLabel="新建会话">
          <Icon name="newChat" size={21} />
        </Pressable> : null}
        <Pressable style={buttonStyle} onPress={openMenu} testID="header-more" accessibilityRole="button" accessibilityLabel="更多选项">
          <Icon name="more" />
        </Pressable>
      </GlassSurface>
      {hasMode ? (
        <ModeSheet
          open={modeOpen}
          mode={mode}
          onSelect={(m) => { onModeChange?.(m); setModeOpen(false); }}
          onClose={() => setModeOpen(false)}
        />
      ) : null}
    </View>
  );
}
