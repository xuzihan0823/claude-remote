import { useState } from 'react';
import { ScrollView, Share, Text, TouchableOpacity, View } from 'react-native';
import { MarkdownView } from './markdown/MarkdownView.js';
import { Icon } from './Icon.js';
import { Spark } from './Spark.js';
import { fmtClock, toolSummary } from '../lib/format.js';
import { useTheme } from '../theme.js';

// 折叠块：thinking / tool_use / tool_result 共用（web 的 <details> 对应物）
function Block({ icon, title, sub, err, children }) {
  const { colors, fonts, radius } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: err ? colors.danger : colors.line,
        marginVertical: 4,
        overflow: 'hidden',
      }}
    >
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)}
        style={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 6 }}
      >
        {icon}
        <Text style={{ color: colors.ink, fontWeight: '600', fontSize: 13 }}>{title}</Text>
        {sub ? (
          <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontFamily: fonts.mono, fontSize: 12 }}>
            {sub}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Text style={{ color: colors.ink3, fontSize: 12 }}>{open ? '⌃' : '⌄'}</Text>
      </TouchableOpacity>
      {open ? <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>{children}</View> : null}
    </View>
  );
}

function MonoBody({ text, err }) {
  const { colors, fonts } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Text style={{ color: err ? colors.danger : colors.ink, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 }} selectable>
        {text}
      </Text>
    </ScrollView>
  );
}

export function MessageRow({ m, sessionId }) {
  const { colors } = useTheme();

  if (m.kind === 'meta') {
    return (
      <Text style={{ textAlign: 'center', color: colors.ink3, fontSize: 12, marginVertical: 6 }}>
        · {m.rawType || 'meta'} ·
      </Text>
    );
  }
  if (m.kind === 'thinking') {
    return (
      <Block icon={<Spark size={13} />} title="思考过程">
        <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 20 }} selectable>{m.text}</Text>
      </Block>
    );
  }
  if (m.kind === 'tool_use') {
    return (
      <Block icon={<Text style={{ fontSize: 12 }}>⚒</Text>} title={m.toolName || '工具'} sub={toolSummary(m)}>
        <MonoBody text={JSON.stringify(m.toolInput ?? {}, null, 2)} />
      </Block>
    );
  }
  if (m.kind === 'tool_result') {
    const chars = (m.text || '').length;
    return (
      <Block
        icon={<Text style={{ fontSize: 12, color: m.isError ? colors.danger : colors.ok }}>{m.isError ? '✕' : '✓'}</Text>}
        title={m.isError ? '工具出错' : '工具结果'}
        sub={`${chars} 字符`}
        err={m.isError}
      >
        <MonoBody text={m.text || ''} err={m.isError} />
      </Block>
    );
  }
  if (m.role === 'user') {
    return (
      <View style={{ alignItems: 'flex-end', marginTop: 12, marginBottom: 20 }}>
        <View style={{ backgroundColor: colors.bubble, borderRadius: 26, borderCurve: 'continuous',
          paddingHorizontal: 18, paddingVertical: 12, maxWidth: '88%' }}>
          <Text style={{ color: colors.inkStrong, fontSize: 17, lineHeight: 26 }} selectable>{m.text}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={{ marginTop: 8, marginBottom: 20 }}>
      <MarkdownView text={m.text} sessionId={sessionId} />
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="分享回复"
          onPress={() => Share.share({ message: m.text || '' }).catch(() => {})}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -10 }}>
          <Icon name="share" size={20} color={colors.ink2} />
        </TouchableOpacity>
        {m.timestamp ? <Text style={{ color: colors.ink3, fontSize: 12 }}>{fmtClock(m.timestamp)}</Text> : null}
      </View>
    </View>
  );
}
