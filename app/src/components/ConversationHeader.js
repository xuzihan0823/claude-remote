import { ActionSheetIOS, Alert, Pressable, Text, View } from 'react-native';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { useTheme } from '../theme.js';

export function ConversationHeader({ title, subtitle, details, newChat = false }) {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const buttonStyle = ({ pressed }) => ({
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: pressed ? colors.glassPressed : 'transparent',
  });
  const openMenu = () => {
    const options = details ? ['会话信息', '设置', '取消'] : ['设置', '取消'];
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1 }, (index) => {
      if (options[index] === '设置') navigation.navigate('Settings');
      if (options[index] === '会话信息') Alert.alert(title || '会话信息', details);
    });
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
      <GlassSurface interactive variant="pill" style={{ borderRadius: 24 }}>
        <Pressable style={buttonStyle} onPress={() => navigation.dispatch(DrawerActions.openDrawer())} accessibilityRole="button" accessibilityLabel="打开会话列表">
          <Icon name="menu" />
        </Pressable>
      </GlassSurface>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
        {title ? <Text numberOfLines={1} style={{ color: colors.inkStrong, fontSize: 15, fontWeight: '500' }}>{title}</Text> : null}
        {subtitle}
      </View>
      <GlassSurface interactive variant="pill" style={{ borderRadius: 24, flexDirection: 'row' }}>
        {newChat ? <Pressable style={buttonStyle} onPress={() => navigation.navigate('Home')} accessibilityRole="button" accessibilityLabel="新建会话">
          <Icon name="newChat" size={21} />
        </Pressable> : null}
        <Pressable style={buttonStyle} onPress={openMenu} accessibilityRole="button" accessibilityLabel="更多选项">
          <Icon name="more" />
        </Pressable>
      </GlassSurface>
    </View>
  );
}
