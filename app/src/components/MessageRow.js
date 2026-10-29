import { useState } from 'react';
import { ActivityIndicator, Image, ScrollView, Share, Text, TouchableOpacity, View } from 'react-native';
import { MarkdownView } from './markdown/MarkdownView.js';
import { Icon } from './Icon.js';
import { Spark } from './Spark.js';
import { fmtClock, toolSummary } from '../lib/format.js';
import { toolHeadline } from '../lib/tool-view.js';
import { ToolInputView } from './ToolInputView.js';
import { useTheme } from '../theme.js';
import { LinkText } from './LinkText.js';
import { usePref } from '../lib/prefs.js';
import { isImagePath, parseAttachmentNote, uploadImageSource } from '../lib/attachments.js';

// 折叠块：thinking / tool_use / tool_result 共用（web 的 <details> 对应物）
function Block({ icon, title, sub, err, children, defaultOpen = false }) {
  const { colors, fonts, radius } = useTheme();
  const [open, setOpen] = useState(defaultOpen);
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
  const wrap = usePref('codeWrap');
  const body = <LinkText text={text} style={{ color: err ? colors.danger : colors.ink, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 }} selectable />;
  return wrap ? body : <ScrollView horizontal showsHorizontalScrollIndicator={false}>{body}</ScrollView>;
}

const fileName = (p) => p.split('/').pop().replace(/^\d+-/, '');

function SentImage({ path, single }) {
  const { colors } = useTheme();
  const [ratio, setRatio] = useState(1);
  const [failed, setFailed] = useState(false);
  const source = uploadImageSource(path);
  const width = single ? 220 : 120;
  const height = single ? Math.min(Math.max(width / ratio, 120), 320) : 120;
  const frame = { width, height, borderRadius: 18, borderCurve: 'continuous', backgroundColor: colors.bubble };
  if (failed || !source) {
    return (
      <View style={[frame, { alignItems: 'center', justifyContent: 'center', padding: 8, gap: 6 }]}>
        <Icon name="image" size={24} color={colors.ink3} />
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 11 }}>{fileName(path)}</Text>
      </View>
    );
  }
  return (
    <Image
      source={source}
      resizeMode="cover"
      accessibilityLabel={fileName(path)}
      onLoad={(e) => { const { width: w, height: h } = e.nativeEvent.source || {}; if (w && h) setRatio(w / h); }}
      onError={() => setFailed(true)}
      style={frame}
    />
  );
}

function UserAttachments({ paths }) {
  const { colors, fonts } = useTheme();
  const images = paths.filter(isImagePath);
  const others = paths.filter((p) => !isImagePath(p));
  return (
    <View style={{ alignItems: 'flex-end', gap: 6, maxWidth: '88%' }}>
      {images.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 }}>
          {images.map((p) => <SentImage key={p} path={p} single={images.length === 1} />)}
        </View>
      ) : null}
      {others.map((p) => (
        <View key={p} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.bubble,
          borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Icon name="paperclip" size={16} color={colors.ink2} />
          <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 13, fontFamily: fonts.mono, flexShrink: 1 }}>{fileName(p)}</Text>
        </View>
      ))}
    </View>
  );
}

export function MessageRow({ m, sending = false }) {
  const { colors } = useTheme();
  const scale = usePref('fontScale');
  const showThinking = usePref('showThinking');
  const toolsExpanded = usePref('toolsExpanded');

  if (m.kind === 'meta') {
    return (
      <Text style={{ textAlign: 'center', color: colors.ink3, fontSize: 12, marginVertical: 6 }}>
        · {m.rawType || 'meta'} ·
      </Text>
    );
  }
  if (m.kind === 'thinking') {
    if (!showThinking) return null;
    return (
      <Block icon={<Spark size={13} />} title="思考过程">
        <LinkText text={m.text} style={{ color: colors.ink2, fontSize: 13 * scale, lineHeight: Math.round(20 * scale) }} selectable />
      </Block>
    );
  }
  if (m.kind === 'tool_use') {
    return (
      <Block
        icon={<Text style={{ fontSize: 12 }}>⚒</Text>}
        title={m.toolName || '工具'}
        sub={toolHeadline(m.toolName, m.toolInput) || toolSummary(m)}
        defaultOpen={toolsExpanded}
      >
        <ToolInputView name={m.toolName} input={m.toolInput} />
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
        defaultOpen={toolsExpanded}
      >
        <MonoBody text={m.text || ''} err={m.isError} />
      </Block>
    );
  }
  if (m.role === 'user') {
    const { text, paths } = parseAttachmentNote(m.text);
    return (
      <View style={{ alignItems: 'flex-end', gap: 6, marginTop: 12, marginBottom: 20 }}>
        {paths.length ? <UserAttachments paths={paths} /> : null}
        {text || sending ? (
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' }}>
            {sending ? <ActivityIndicator size="small" color={colors.ink3} style={{ marginRight: 10 }} accessibilityLabel="发送中" /> : null}
            {text ? (
              <View style={{ backgroundColor: colors.bubble, borderRadius: 26, borderCurve: 'continuous',
                paddingHorizontal: 18, paddingVertical: 12, maxWidth: '88%' }}>
                <LinkText text={text} style={{ color: colors.inkStrong, fontSize: 17 * scale, lineHeight: Math.round(26 * scale) }} selectable />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View style={{ marginTop: 8, marginBottom: 20 }}>
      <MarkdownView text={m.text} />
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
