import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from './Icon.js';

export function ZoomableImage({ source, label, onPress }) {
  const [size, setSize] = useState(null);
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }} onLayout={(e) => setSize(e.nativeEvent.layout)}>
      {size ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ width: size.width, height: size.height }}
          minimumZoomScale={1}
          maximumZoomScale={5}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : 'image'} accessibilityLabel={onPress ? '关闭图片' : label}>
            <Image source={source} resizeMode="contain" accessibilityLabel={label} style={{ width: size.width, height: size.height }} />
          </Pressable>
        </ScrollView>
      ) : null}
    </View>
  );
}

export function ImageViewer({ source, label, visible, onClose }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <ZoomableImage source={source} label={label} onPress={onClose} />
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
