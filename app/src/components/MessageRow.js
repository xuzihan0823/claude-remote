import { useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { MarkdownView } from './markdown/MarkdownView.js';
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

export function MessageRow({ m }) {
  const { colors, fonts, radius } = useTheme();

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
  // kind === 'text'
  if (m.role === 'user') {
    return (
      <View style={{ flexDirection: 'row', marginVertical: 6, gap: 8 }}>
        <View
          style={{
            width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bubble,
            alignItems: 'center', justifyContent: 'center', marginTop: 2,
          }}
        >
          <Text style={{ fontSize: 11, color: colors.ink }}>我</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View
            style={{
              backgroundColor: colors.bubble, borderRadius: radius.md, borderTopLeftRadius: radius.xs,
              paddingHorizontal: 12, paddingVertical: 8, alignSelf: 'flex-start', maxWidth: '100%',
            }}
          >
            <Text style={{ color: colors.inkStrong, fontSize: 15, lineHeight: 22 }} selectable>{m.text}</Text>
          </View>
          {m.timestamp ? (
            <Text style={{ color: colors.ink3, fontSize: 11, marginTop: 2 }}>{fmtClock(m.timestamp)}</Text>
          ) : null}
        </View>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: 'row', marginVertical: 6, gap: 8 }}>
      <View style={{ width: 26, alignItems: 'center', marginTop: 4 }}>
        <Spark size={16} />
      </View>
      <View style={{ flex: 1 }}>
        <MarkdownView text={m.text} />
        {m.timestamp ? (
          <Text style={{ color: colors.ink3, fontSize: 11, marginTop: 2 }}>{fmtClock(m.timestamp)}</Text>
        ) : null}
      </View>
    </View>
  );
}
