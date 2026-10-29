import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../theme.js';
import { fmtBytes, truncate } from '../../lib/format.js';
import { Icon } from '../Icon.js';

const THUMB = 112;
const hitSlop = { top: 6, bottom: 6, left: 6, right: 6 };

// 附件列表：图片显示为大缩略图（右上角圆形 ✕），其他文件为名称 + 大小的 chip。横向滚动。
export function AttachmentChips({ files, onRemove }) {
  const { colors, fonts } = useTheme();
  if (!files || files.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginTop: 4, marginBottom: 6 }}
      contentContainerStyle={{ gap: 8, paddingRight: 4, alignItems: 'flex-end' }}
    >
      {files.map((f, i) => (f.isImage && f.uri ? (
        <View key={`${f.name}:${i}`} style={{ width: THUMB, height: THUMB }}>
          <Image
            source={{ uri: f.uri }}
            resizeMode="cover"
            accessibilityLabel={f.name}
            style={{ width: THUMB, height: THUMB, borderRadius: 18, borderCurve: 'continuous', backgroundColor: colors.bubble }}
          />
          <TouchableOpacity
            onPress={() => onRemove(i)}
            hitSlop={hitSlop}
            accessibilityLabel="移除附件"
            style={{
              position: 'absolute', top: 6, right: 6, width: 26, height: 26, borderRadius: 13,
              backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon name="close" size={14} color="#FFFFFF" strokeWidth={2.4} />
          </TouchableOpacity>
        </View>
      ) : (
        <View
          key={`${f.name}:${i}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.bubble,
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 4,
          }}
        >
          <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 12, maxWidth: 120 }}>
            {truncate(f.name, 24)}
          </Text>
          <Text style={{ color: colors.ink2, fontSize: 11, marginLeft: 6, fontFamily: fonts.mono }}>
            {f.size ? fmtBytes(f.size) : ''}
          </Text>
          <TouchableOpacity
            onPress={() => onRemove(i)}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            accessibilityLabel="移除附件"
            style={{ marginLeft: 6 }}
          >
            <Text style={{ color: colors.ink2, fontSize: 12 }}>✕</Text>
          </TouchableOpacity>
        </View>
      )))}
    </ScrollView>
  );
}
