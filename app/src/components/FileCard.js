import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from './Icon.js';
import { useTheme } from '../theme.js';
import { fmtBytes } from '../lib/format.js';
import { fetchFileMeta, fileErrorText } from '../lib/file-preview.js';

const KIND_LABEL = { html: '网页', image: '图片', text: '文本', markdown: 'Markdown', pdf: 'PDF', none: '文件' };
const KIND_ICON = { image: 'image' };

export function FileCard({ sessionId, path, onOpen }) {
  const { colors, fonts } = useTheme();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setMeta(null);
    setError(null);
    fetchFileMeta(sessionId, path)
      .then((m) => { if (alive) setMeta(m); })
      .catch((e) => { if (alive) setError(e.code || 'unknown'); });
    return () => { alive = false; };
  }, [sessionId, path]);

  const name = meta?.name || path.split('/').pop();
  const detail = error ? fileErrorText(error)
    : meta ? `${fmtBytes(meta.sizeBytes)} · ${KIND_LABEL[meta.previewKind] || KIND_LABEL.none}` : '正在读取文件信息';
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`打开文件 ${name}`}
      disabled={Boolean(error)}
      onPress={() => onOpen(path)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: 12, paddingVertical: 8,
        borderRadius: 14, borderCurve: 'continuous', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card }}
    >
      {meta || error
        ? <Icon name={KIND_ICON[meta?.previewKind] || 'paperclip'} size={20} color={error ? colors.ink3 : colors.ink2} />
        : <ActivityIndicator size="small" color={colors.ink3} />}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: error ? colors.ink2 : colors.ink, fontSize: 14, fontFamily: fonts.mono }}>{name}</Text>
        <Text numberOfLines={1} style={{ color: error ? colors.danger : colors.ink2, fontSize: 12, marginTop: 2 }}>{detail}</Text>
      </View>
    </TouchableOpacity>
  );
}
