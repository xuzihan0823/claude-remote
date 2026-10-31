// RN 端 Markdown 渲染器：与 web/ui/components/markdown.js 输出对齐，流式增量友好。
// 用 vendored marked 的 lexer 产 token 树，再 token -> RN 组件递归渲染。
// 纯函数式：同一 text 重渲染稳定（列表 key 用索引即可）。
import { useMemo, useState } from 'react';
import { Dimensions, ScrollView, Text, View } from 'react-native';
import { marked } from '../../../../web/vendor/marked.esm.min.js';
import { codeFilePath, collectFilePaths, installLinkify, localFilePath, wholeUrl } from '../../../../web/core/linkify.js';
import { installMath } from '../../../../web/core/md-math.js';
import { openLink, shareLink } from '../../lib/links.js';
import { useTheme } from '../../theme.js';
import { usePref } from '../../lib/prefs.js';
import { fitColumnWidths, naturalColumnWidths } from '../../lib/table-layout.js';
import { highlightCode } from './highlight.js';
import { MathView } from './MathView.js';
import { MdImage } from './MdImage.js';

installLinkify(marked);
installMath(marked);
// 基准字号 / 行高（规格约定）
const BASE_FS = 17;
const BASE_LH = 28;

// marked 的 text token 保留原始 HTML 实体（&amp; 等）；web 端靠浏览器解析 innerHTML 解码，
// RN Text 不会解码，故这里手动解码以对齐 web 输出。原始 < > & 等已是裸字符，无需处理。
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (m, dec, hex, name) => {
    if (dec != null) return Number.isFinite(+dec) ? String.fromCodePoint(+dec) : m;
    if (hex != null) return String.fromCodePoint(parseInt(hex, 16));
    return NAMED_ENTITIES[name] != null ? NAMED_ENTITIES[name] : m;
  });
}

// 各级标题字号递减；h1/h2 用衬线（与 web .md h1/h2 的 var(--serif) 对应）
const HEADING_FS = { 1: 20, 2: 18, 3: 16, 4: 15, 5: 14, 6: 13 };

// 内联 token -> <Text> 子节点数组（递归）。父级必须是 <Text>。
// keyPrefix 用于给嵌套层生成唯一 key，避免兄弟数组 key 撞车。
function renderInline(tokens, ctx, keyPrefix) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const key = `${keyPrefix}${i}`;
    switch (tok.type) {
      case 'text':
        // text.text 可能含 \n（breaks:true 下段落内换行）；RN Text 原样保留 \n 渲染换行
        out.push(decodeEntities(tok.text || ''));
        break;
      case 'escape':
        // escape token 已解析为裸字符（如 \* -> *），无需实体解码
        out.push(tok.text || '');
        break;
      case 'strong':
        out.push(
          <Text key={key} style={{ fontWeight: '700' }}>
            {renderInline(tok.tokens, ctx, `${key}-`)}
          </Text>,
        );
        break;
      case 'em':
        out.push(
          <Text key={key} style={{ fontStyle: 'italic' }}>
            {renderInline(tok.tokens, ctx, `${key}-`)}
          </Text>,
        );
        break;
      case 'del':
        out.push(
          <Text key={key} style={{ textDecorationLine: 'line-through', opacity: 0.7 }}>
            {renderInline(tok.tokens, ctx, `${key}-`)}
          </Text>,
        );
        break;
      case 'codespan': {
        // 反引号里整段是链接（Claude 常写 `http://localhost:3000`）也可点
        const codeHref = wholeUrl(tok.text);
        const codePath = ctx.onOpenFile ? codeFilePath(tok.text) : null;
        const tappable = Boolean(codeHref || codePath);
        out.push(
          <Text
            key={key}
            onPress={tappable ? () => (codePath ? ctx.onOpenFile(codePath) : openLink(codeHref)) : undefined}
            onLongPress={codeHref ? () => shareLink(codeHref) : undefined}
            style={{
              fontFamily: ctx.fonts.mono,
              fontSize: ctx.fs * 0.86,
              color: ctx.colors.code,
              ...(tappable ? { textDecorationLine: 'underline', color: ctx.colors.accent } : null),
            }}
          >
            {tok.text || ''}
          </Text>,
        );
        break;
      }
      case 'math':
        out.push(<MathView key={key} tex={tok.text} display={false} ctx={ctx} fontSize={ctx.fs} />);
        break;
      case 'image':
        out.push(<MdImage key={key} href={tok.href} alt={tok.text} sessionId={ctx.sessionId} ctx={ctx} inline />);
        break;
      case 'link': {
        const href = tok.href || '';
        const linkPath = ctx.onOpenFile ? localFilePath(href) : null;
        const kids = tok.tokens
          ? renderInline(tok.tokens, ctx, `${key}-`)
          : tok.text || '';
        out.push(
          <Text
            key={key}
            accessibilityRole="link"
            onPress={() => (linkPath ? ctx.onOpenFile(linkPath) : openLink(href))}
            onLongPress={() => shareLink(href)}
            style={{ color: ctx.colors.accent, textDecorationLine: 'underline' }}
          >
            {kids}
          </Text>,
        );
        break;
      }
      case 'br':
        out.push('\n');
        break;
      case 'html':
        // 与 web renderer.html 的 escapeHtml 后等价：浏览器把 &lt; 渲为 <，
        // RN 无 HTML 解析，直接展示原始标签文本即可达到同样视觉效果。
        out.push(tok.text || '');
        break;
      default:
        if (tok.text) out.push(tok.text);
        break;
    }
  }
  return out;
}

function renderHeading(tok, ctx, key) {
  const fs = (HEADING_FS[tok.depth] || BASE_FS) * ctx.scale;
  const serif = tok.depth <= 2;
  return (
    <Text
      key={key}
      style={{
        color: ctx.colors.inkStrong,
        fontSize: fs,
        lineHeight: Math.round(fs * 1.35),
        fontFamily: serif ? ctx.fonts.serif : undefined,
        fontWeight: '700',
        marginTop: 12,
        marginBottom: 5,
      }}
    >
      {renderInline(tok.tokens, ctx, `${key}-`)}
    </Text>
  );
}

function renderCode(tok, ctx, key) {
  return (
    <View
      key={key}
      style={{
        backgroundColor: ctx.colors.card,
        borderWidth: 1,
        borderColor: ctx.colors.line,
        borderRadius: ctx.radius.sm,
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginVertical: 8,
      }}
    >
      {(() => {
        const segments = highlightCode(tok.text || '', tok.lang);
        const code = (
          <Text
            selectable
            style={{
              fontFamily: ctx.fonts.mono,
              fontSize: ctx.fs * 0.84,
              lineHeight: Math.round(ctx.lh * 0.92),
              color: ctx.colors.ink,
            }}
          >
            {segments
              ? segments.map((s, i) =>
                  s.kind ? (
                    <Text
                      key={i}
                      style={{
                        color: ctx.colors.syntax[s.kind],
                        ...(s.kind === 'comment' ? { fontStyle: 'italic' } : null),
                      }}
                    >
                      {s.text}
                    </Text>
                  ) : (
                    s.text
                  ),
                )
              : tok.text || ''}
          </Text>
        );
        // 设置里开了「代码自动换行」就折行显示，否则横向滚动
        return ctx.codeWrap ? code : <ScrollView horizontal showsHorizontalScrollIndicator={false}>{code}</ScrollView>;
      })()}
    </View>
  );
}

// 段落只有图片（常见的 ![](x) 独占一行）时按块级显示，宽度撑满
function imageOnly(tokens) {
  if (!Array.isArray(tokens) || !tokens.some((t) => t.type === 'image')) return null;
  const ok = tokens.every((t) => t.type === 'image' || t.type === 'br' || (t.type === 'text' && !String(t.text).trim()));
  return ok ? tokens.filter((t) => t.type === 'image') : null;
}

function renderBlockquote(tok, ctx, key) {
  return (
    <View
      key={key}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: ctx.colors.accent,
        paddingLeft: 12,
        marginVertical: 6,
      }}
    >
      {renderBlocks(tok.tokens, ctx, `${key}-`)}
    </View>
  );
}

const TABLE_CELL_PAD = 10;
const TABLE_MIN_COLUMN = 96;

function renderTableRow(cells, tok, widths, ctx, key, isHeader) {
  return (
    <View
      key={key}
      style={{
        flexDirection: 'row',
        backgroundColor: isHeader ? ctx.colors.card : undefined,
        borderTopWidth: isHeader ? 0 : 1,
        borderTopColor: ctx.colors.line,
      }}
    >
      {cells.map((cell, col) => (
        <View
          key={col}
          style={{
            width: widths[col],
            flexGrow: widths[col],
            paddingHorizontal: TABLE_CELL_PAD,
            paddingVertical: 7,
            borderLeftWidth: col === 0 ? 0 : 1,
            borderLeftColor: ctx.colors.line,
          }}
        >
          <Text
            style={{
              color: isHeader ? ctx.colors.inkStrong : ctx.colors.ink,
              fontSize: ctx.fs * 0.88,
              lineHeight: Math.round(ctx.lh * 0.84),
              fontWeight: isHeader ? '700' : undefined,
              textAlign: tok.align?.[col] || 'left',
            }}
          >
            {renderInline(cell.tokens, ctx, `${key}-${col}-`)}
          </Text>
        </View>
      ))}
    </View>
  );
}

// RN 没有表格布局，各行靠相同的固定列宽对齐；横向 ScrollView 里 flexBasis 不生效，必须用 width。
// 首帧按聊天页宽度估算（两侧各 20），避免 onLayout 校正时表格跳动。
function MarkdownTable({ tok, ctx }) {
  const [available, setAvailable] = useState(() => Dimensions.get('window').width - 42);
  const widths = fitColumnWidths(
    naturalColumnWidths(tok, ctx.fs * 0.88, TABLE_CELL_PAD),
    available,
    TABLE_MIN_COLUMN * ctx.scale,
  );
  return (
    <View
      onLayout={(e) => setAvailable(e.nativeEvent.layout.width - 2)}
      style={{
        marginVertical: 8,
        borderWidth: 1,
        borderColor: ctx.colors.line,
        borderRadius: ctx.radius.sm,
        overflow: 'hidden',
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ flexGrow: 1, flexDirection: 'column' }}
      >
        {renderTableRow(tok.header, tok, widths, ctx, 'h', true)}
        {tok.rows.map((row, i) => renderTableRow(row, tok, widths, ctx, `r${i}`, false))}
      </ScrollView>
    </View>
  );
}

// list_item 的内容列里若再嵌套 list，会因处在内容列（已被 bullet 列右移）而自然缩进，
// 故此处不再额外传 depth。
function renderList(tok, ctx, key) {
  const ordered = !!tok.ordered;
  const start = tok.start || 1;
  const items = tok.items || [];
  return (
    <View key={key} style={{ marginVertical: 4 }}>
      {items.map((item, i) => renderListItem(item, ctx, `${key}-i${i}`, i, ordered, start))}
    </View>
  );
}

function renderListItem(item, ctx, key, index, ordered, start) {
  // bullet：有序用 "n."；无序任务项用 ☑/☐；普通无序用 •
  const bullet = ordered
    ? `${start + index}.`
    : item.task
      ? item.checked
        ? '☑'
        : '☐'
      : '•';

  const parts = [];
  if (Array.isArray(item.tokens)) {
    for (let i = 0; i < item.tokens.length; i++) {
      const t = item.tokens[i];
      if (t.type === 'list') {
        // 嵌套列表：放进内容列自然缩进
        parts.push(renderList(t, ctx, `${key}-l${i}`));
      } else if (t.type === 'text') {
        // 紧凑列表的 text token 包裹内联内容
        const kids = t.tokens
          ? renderInline(t.tokens, ctx, `${key}-t${i}-`)
          : decodeEntities(t.text || '');
        parts.push(
          <Text
            key={`t${i}`}
            style={{ color: ctx.colors.ink, fontSize: ctx.fs, lineHeight: ctx.lh }}
          >
            {kids}
          </Text>,
        );
      } else if (t.type === 'checkbox') {
        // checkbox token 已通过 bullet 体现，跳过
      } else {
        // 其他块级（paragraph / code / blockquote / heading 等）复用块渲染
        const blk = renderBlock(t, ctx, `${key}-b${i}`);
        if (blk !== null && blk !== undefined) parts.push(blk);
      }
    }
  }

  return (
    <View key={key} style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: index === 0 ? 0 : 3 }}>
      <Text
        style={{
          width: 24,
          color: ctx.colors.ink2,
          fontSize: ctx.fs,
          lineHeight: ctx.lh,
        }}
      >
        {bullet}
      </Text>
      <View style={{ flex: 1 }}>{parts}</View>
    </View>
  );
}

// 单个块级 token -> 元素（或 null）
function renderBlock(tok, ctx, key) {
  switch (tok.type) {
    case 'space':
      return null;
    case 'hr':
      return (
        <View
          key={key}
          style={{ height: 1, backgroundColor: ctx.colors.line, marginVertical: 10 }}
        />
      );
    case 'heading':
      return renderHeading(tok, ctx, key);
    case 'math':
      return <MathView key={key} tex={tok.text} display ctx={ctx} fontSize={ctx.fs} />;
    case 'paragraph': {
      const imgs = imageOnly(tok.tokens);
      if (imgs) {
        return (
          <View key={key} style={{ marginVertical: 2 }}>
            {imgs.map((t, i) => <MdImage key={i} href={t.href} alt={t.text} sessionId={ctx.sessionId} ctx={ctx} />)}
          </View>
        );
      }
      return (
        <Text
          key={key}
          style={{ color: ctx.colors.ink, fontSize: ctx.fs, lineHeight: ctx.lh, marginVertical: 4 }}
        >
          {renderInline(tok.tokens, ctx, `${key}-`)}
        </Text>
      );
    }
    case 'code':
      return renderCode(tok, ctx, key);
    case 'blockquote':
      return renderBlockquote(tok, ctx, key);
    case 'list':
      return renderList(tok, ctx, key);
    case 'table':
      return <MarkdownTable key={key} tok={tok} ctx={ctx} />;
    case 'html':
      // 块级 html：作为纯文本展示（等宽，弱化色）
      return (
        <Text
          key={key}
          style={{
            color: ctx.colors.ink2,
            fontFamily: ctx.fonts.mono,
            fontSize: ctx.fs * 0.86,
            lineHeight: ctx.lh,
          }}
        >
          {tok.text || ''}
        </Text>
      );
    case 'text':
      // 列表项里的 text token 兜底（正常路径在 renderListItem 内已处理）
      return (
        <Text key={key} style={{ color: ctx.colors.ink, fontSize: ctx.fs, lineHeight: ctx.lh }}>
          {tok.tokens ? renderInline(tok.tokens, ctx, `${key}-`) : decodeEntities(tok.text || '')}
        </Text>
      );
    case 'def':
      // 引用链接定义：不渲染
      return null;
    default:
      return tok.raw ? (
        <Text key={key} style={{ color: ctx.colors.ink2, fontSize: ctx.fs, lineHeight: ctx.lh }}>
          {tok.raw}
        </Text>
      ) : null;
  }
}

function renderBlocks(tokens, ctx, keyPrefix = '') {
  if (!Array.isArray(tokens)) return null;
  return tokens.map((tok, i) => renderBlock(tok, ctx, `${keyPrefix}${i}`));
}

// 必须带上 marked.defaults：只传 {gfm, breaks} 会丢掉 installLinkify / installMath 注册的扩展
const lexMarkdown = (text) => marked.lexer(String(text ?? ''), { ...marked.defaults, gfm: true, breaks: true });

/** 正文里出现的本机文件路径，用于在消息下方渲染文件卡片。 */
export function filePathsIn(text) {
  try { return collectFilePaths(marked, lexMarkdown(text)); } catch { return []; }
}

export function MarkdownView({ text, sessionId, onOpenFile }) {
  const { colors, fonts, radius } = useTheme();
  const scale = usePref('fontScale');
  const codeWrap = usePref('codeWrap');
  const ctx = { colors, fonts, radius, scale, codeWrap, sessionId, onOpenFile, fs: BASE_FS * scale, lh: Math.round(BASE_LH * scale) };

  // lexer 失败退回纯 <Text>；同一 text 稳定（useMemo 仅 memo token 树，渲染每帧用最新 ctx）
  const tokens = useMemo(() => {
    try {
      return lexMarkdown(text);
    } catch {
      return null;
    }
  }, [text]);

  const fallback = (
    <Text style={{ color: colors.ink, fontSize: ctx.fs, lineHeight: ctx.lh }}>
      {String(text ?? '')}
    </Text>
  );

  if (!tokens) return fallback;

  let body;
  try {
    body = renderBlocks(tokens, ctx);
  } catch {
    return fallback;
  }

  return <View>{body}</View>;
}
