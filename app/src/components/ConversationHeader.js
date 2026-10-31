import { useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { GlassMenu } from './GlassMenu.js';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { buildModeMenuItems, MODE_LABELS } from './composer/ModeSheet.js';
import { haptics } from '../lib/haptics.js';
import { useTheme } from '../theme.js';

// 顶栏：左侧抽屉按钮；右侧胶囊（新建会话 + 三点菜单）点击时整体原位变形为液态玻璃下拉框。
// 点击「权限模式」在下拉框内直接展开圆角内层下拉框（上方条目保留并半透明淡化），选完或点空白处后收起回右上角胶囊。
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
  const [pillHidden, setPillHidden] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const pillRef = useRef(null);

  const buttonStyle = ({ pressed }) => ({
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: pressed ? colors.glassPressed : 'transparent',
  });

  const hasMode = showModeSelector && !!mode;
  const modeItems = hasMode ? buildModeMenuItems(mode, onModeChange) : [];
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
      subItems: modeItems,
    });
  }

  const closeMenu = () => {
    setMenuOpen(false);
  };

  const openMenu = () => {
    Keyboard.dismiss();
    if (!rootItems.length) return;
    haptics.tap();
    const node = pillRef.current;
    if (!node) return;
    node.measureInWindow((x, y, width, height) => {
      setMenuAnchor({ x, y, width, height });
      setPillHidden(true);
      setMenuOpen(true);
    });
  };

  const pillIconsSnapshot = (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {newChat ? (
        <View style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="newChat" size={21} strokeWidth={2} />
        </View>
      ) : null}
      <View style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="more" />
      </View>
    </View>
  );

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
      <View
        ref={pillRef}
        collapsable={false}
        pointerEvents={pillHidden ? 'none' : 'auto'}
        style={{ opacity: pillHidden ? 0 : 1 }}
      >
        <GlassSurface interactive variant="pill" style={{ borderRadius: 24, flexDirection: 'row' }}>
          {newChat ? (
            <Pressable style={buttonStyle} onPress={onNewChat || (() => navigation.navigate('Home'))} testID="header-new-chat" accessibilityRole="button" accessibilityLabel="新建会话">
              <Icon name="newChat" size={21} strokeWidth={2} />
            </Pressable>
          ) : null}
          <Pressable style={buttonStyle} onPress={openMenu} testID="header-more" accessibilityRole="button" accessibilityLabel="更多选项" accessibilityState={{ expanded: menuOpen }}>
            <Icon name="more" />
          </Pressable>
        </GlassSurface>
      </View>
      <GlassMenu
        visible={menuOpen}
        anchor={menuAnchor}
        morphAnchor
        anchorSnapshot={pillIconsSnapshot}
        title={title || undefined}
        items={rootItems}
        onClose={closeMenu}
        onAfterClose={() => setPillHidden(false)}
      />
    </View>
  );
}
