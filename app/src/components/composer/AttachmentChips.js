import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../theme.js';
import { fmtBytes, truncate } from '../../lib/format.js';

// 附件 chip 列表：名称截断 24 + fmtBytes + ✕ 删除。横向滚动。
// 对应 web/style.css .attach-chips .chip（.chip-name/.chip-size/.chip-x）。
export function AttachmentChips({ files, onRemove }) {
  const { colors, fonts } = useTheme();
  if (!files || files.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginVertical: 2 }}
      contentContainerStyle={{ gap: 6, paddingRight: 4 }}
    >
      {files.map((f, i) => (
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
            {fmtBytes(f.size)}
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
      ))}
    </ScrollView>
  );
}
