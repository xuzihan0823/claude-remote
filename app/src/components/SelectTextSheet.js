import { Modal, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from './Icon.js';
import { usePref } from '../lib/prefs.js';
import { useTheme } from '../theme.js';

// iOS 的 <Text selectable> 只能整段拷贝；只读 TextInput 底层是 UITextView，才支持拖选任意范围
export function SelectTextSheet({ text, onClose }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const scale = usePref('fontScale');
  const textStyle = { color: colors.ink, fontSize: 17 * scale, lineHeight: Math.round(28 * scale) };
  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.line }}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={20} color={colors.ink} />
          </TouchableOpacity>
          <Text style={{ flex: 1, textAlign: 'center', color: colors.ink, fontSize: 15, fontWeight: '600' }}>选择文本</Text>
          <View style={{ width: 44 }} />
        </View>
        {Platform.OS === 'ios' ? (
          <TextInput value={text} editable={false} multiline scrollEnabled
            style={[textStyle, { flex: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 16 }]} />
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 16 }}>
            <Text selectable style={textStyle}>{text}</Text>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
