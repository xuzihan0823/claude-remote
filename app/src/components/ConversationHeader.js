import { useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { GlassMenu } from './GlassMenu.js';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { buildModeMenuItems, MODE_LABELS } from './composer/ModeSheet.js';
import { useTheme } from '../theme.js';

// 顶栏：左侧抽屉按钮；右侧三点菜单承载「会话信息 / 选择工作目录 / 权限模式」。
// 点击「权限模式」直接在同一个液态玻璃菜单内展开子列表，选完或点空白处后水滴收起回三点按钮。
export function ConversationHeader({
  title,
  subtitle,
  details,
  newChat = false,
  onNewChat,
  mode,
  onModeChange,
  showModeSelector = false,
  onPickCwd,
  cwdLabel,
}) {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [subpage, setSubpage] = useState(null); // null | 'mode'
  const [menuAnchor, setMenuAnchor] = useState(null);
  const moreBtnRef = useRef(null);

  const buttonStyle = ({ pressed }) => ({
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: pressed ? colors.glassPressed : 'transparent',
  });

  const hasMode = showModeSelector && !!mode;
  const rootItems = [];
  if (details) {
    rootItems.push({
      key: 'info',
      icon: 'info',
      label: '会话信息',
      testID: 'menu-info',
      onPress: () => Alert.alert(title || '会话信息', details),
    });
  }
  if (onPickCwd) {
    rootItems.push({
      key: 'cwd',
      icon: 'folder',
      label: cwdLabel ? '工作目录' : '选择工作目录',
      detail: cwdLabel || '未选择',
      detailTone: cwdLabel ? undefined : 'danger',
      chevron: true,
      testID: 'menu-cwd',
      onPress: () => onPickCwd(menuAnchor),
    });
  }
  if (hasMode) {
    rootItems.push({
      key: 'mode',
      icon: 'shield',
      label: '权限模式',
      detail: MODE_LABELS[mode] || '标准',
      detailTone: mode === 'bypassPermissions' ? 'danger' : undefined,
      chevron: true,
      testID: 'menu-mode',
      keepOpen: true,
      onPress: () => setSubpage('mode'),
    });
  }

  const modeItems = hasMode ? buildModeMenuItems(mode, onModeChange) : [];

  const modeHeader = subpage === 'mode' ? (
    <Pressable
      onPress={() => setSubpage(null)}
      accessibilityRole="button"
      accessibilityLabel="返回上一级菜单"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginHorizontal: 6,
        borderRadius: 12,
        backgroundColor: pressed ? colors.glassPressed : 'transparent',
      })}
    >
      <Icon name="back" size={16} color={colors.ink2} />
      <Text style={{ color: colors.ink2, fontSize: 13, fontWeight: '600' }}>权限模式</Text>
    </Pressable>
  ) : null;

  const closeMenu = () => {
    setMenuOpen(false);
    setTimeout(() => setSubpage(null), 280);
  };

  const openMenu = () => {
    Keyboard.dismiss();
    if (!rootItems.length) return;
    const node = moreBtnRef.current;
    if (!node) return;
    node.measureInWindow((x, y, width, height) => {
      setSubpage(null);
      setMenuAnchor({ x, y, width, height });
      setMenuOpen(true);
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
        {newChat ? (
          <Pressable style={buttonStyle} onPress={onNewChat || (() => navigation.navigate('Home'))} testID="header-new-chat" accessibilityRole="button" accessibilityLabel="新建会话">
            <Icon name="newChat" size={21} />
          </Pressable>
        ) : null}
        <View ref={moreBtnRef} collapsable={false}>
          <Pressable style={buttonStyle} onPress={openMenu} testID="header-more" accessibilityRole="button" accessibilityLabel="更多选项" accessibilityState={{ expanded: menuOpen }}>
            <Icon name="more" />
          </Pressable>
        </View>
      </GlassSurface>
      <GlassMenu
        visible={menuOpen}
        anchor={menuAnchor}
        header={modeHeader}
        items={subpage === 'mode' ? modeItems : rootItems}
        onClose={closeMenu}
      />
    </View>
  );
}
