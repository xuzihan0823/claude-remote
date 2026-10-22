// 纯文本里的链接可点：切片后链接段渲染为嵌套 <Text onPress>，父级 Text 的样式/selectable 原样保留
import { useMemo } from 'react';
import { Text } from 'react-native';
import { splitLinks } from '../../../web/core/linkify.js';
import { openLink, shareLink } from '../lib/links.js';
import { useTheme } from '../theme.js';

export function LinkText({ text, style, ...rest }) {
  const { colors } = useTheme();
  const segs = useMemo(() => splitLinks(text), [text]);
  if (segs.length === 1 && !segs[0].href) return <Text style={style} {...rest}>{text}</Text>;
  return (
    <Text style={style} {...rest}>
      {segs.map((s, i) => (s.href ? (
        <Text
          key={i}
          accessibilityRole="link"
          onPress={() => openLink(s.href)}
          onLongPress={() => shareLink(s.href)}
          style={{ color: colors.accent, textDecorationLine: 'underline' }}
        >{s.text}</Text>
      ) : s.text))}
    </Text>
  );
}
