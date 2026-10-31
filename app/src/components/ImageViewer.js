import { Image, Modal, Pressable, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from './Icon.js';

export function ImageViewer({ source, label, visible, onClose }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <ScrollView
        style={{ flex: 1, backgroundColor: '#000' }}
        contentContainerStyle={{ width, height }}
        minimumZoomScale={1}
        maximumZoomScale={5}
        centerContent
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
      >
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭图片">
          <Image source={source} resizeMode="contain" accessibilityLabel={label} style={{ width, height }} />
        </Pressable>
      </ScrollView>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="关闭"
        onPress={onClose}
        hitSlop={8}
        style={{ position: 'absolute', top: insets.top + 8, right: 16, width: 40, height: 40, borderRadius: 20,
          alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.18)' }}
      >
        <Icon name="close" size={20} color="#fff" />
      </TouchableOpacity>
    </Modal>
  );
}
