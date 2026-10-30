import { useMemo, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { cwdTail } from '../lib/format.js';
import { toolView } from '../lib/tool-view.js';
import { useTheme } from '../theme.js';

// 工具参数的可读展示：Edit/Write 显示红绿 diff，Bash 显示命令，TodoWrite 显示清单，其它显示关键字段。
// 消息流的 tool_use 折叠块和审批卡片共用。maxHeight 给审批卡片用（diff 很长时内部滚动）。

function DiffRows({ rows }) {
  const { colors, fonts } = useTheme();
  const bg = { '+': colors.diffAdd, '-': colors.diffDel };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ minWidth: '100%' }}>
        {rows.map((r, idx) => {
          if (r.op === '…') {
            return r.count === 0 ? (
              <View key={idx} style={{ height: 1, backgroundColor: colors.line, marginVertical: 6 }} />
            ) : (
              <Text key={idx} style={{ fontFamily: fonts.mono, fontSize: 11.5, color: colors.ink3, paddingVertical: 2, paddingHorizontal: 6 }}>
                ⋯ {r.count} 行未改动
              </Text>
            );
          }
          const color = r.op === '+' ? colors.ok : r.op === '-' ? colors.danger : colors.ink2;
          return (
            <Text
              key={idx}
              selectable
              style={{
                fontFamily: fonts.mono,
                fontSize: 12,
                lineHeight: 18,
                color: r.op === ' ' ? colors.ink2 : colors.inkStrong,
                backgroundColor: bg[r.op] || 'transparent',
                paddingHorizontal: 6,
              }}
            >
              <Text style={{ color }}>{r.op === ' ' ? ' ' : r.op} </Text>
              {r.text || ' '}
            </Text>
          );
        })}
      </View>
    </ScrollView>
  );
}

function Mono({ children, color }) {
  const { colors, fonts } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Text selectable style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, color: color || colors.ink }}>
        {children}
      </Text>
    </ScrollView>
  );
}

const TODO_MARK = { completed: '☑', in_progress: '◐', pending: '☐' };

export function ToolInputView({ name, input, maxHeight }) {
  const { colors, fonts, radius } = useTheme();
  const view = useMemo(() => toolView(name, input), [name, input]);
  const [raw, setRaw] = useState(false);

  let body;
  if (raw || view.kind === 'json') {
    body = <Mono>{JSON.stringify(input ?? {}, null, 2)}</Mono>;
  } else if (view.kind === 'diff') {
    body = (
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, color: colors.ink }}>
            {cwdTail(view.file, 3) || view.file}
          </Text>
          {view.added ? <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.ok }}>+{view.added}</Text> : null}
          {view.removed ? <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.danger }}>−{view.removed}</Text> : null}
        </View>
        {view.note ? <Text style={{ fontSize: 11.5, color: colors.ink3, marginBottom: 4 }}>{view.note}</Text> : null}
        <View style={{ borderRadius: radius.xs, overflow: 'hidden', borderWidth: 1, borderColor: colors.line, paddingVertical: 4 }}>
          <DiffRows rows={view.rows} />
        </View>
      </View>
    );
  } else if (view.kind === 'bash') {
    body = (
      <View>
        {view.description ? <Text style={{ fontSize: 12.5, color: colors.ink2, marginBottom: 6 }}>{view.description}</Text> : null}
        <View style={{ backgroundColor: colors.bg2, borderRadius: radius.xs, padding: 8 }}>
          <Mono color={colors.inkStrong}>
            <Text style={{ color: colors.accent }}>$ </Text>
            {view.command}
          </Mono>
        </View>
      </View>
    );
  } else if (view.kind === 'todos') {
    body = (
      <View style={{ gap: 4 }}>
        {view.todos.map((t, idx) => (
          <Text
            key={idx}
            style={{
              fontSize: 13.5,
              lineHeight: 20,
              color: t.status === 'completed' ? colors.ink3 : colors.ink,
              textDecorationLine: t.status === 'completed' ? 'line-through' : 'none',
            }}
          >
            <Text style={{ color: t.status === 'in_progress' ? colors.accent : colors.ink2 }}>{TODO_MARK[t.status] || '☐'} </Text>
            {t.text}
          </Text>
        ))}
      </View>
    );
  } else {
    body = (
      <View style={{ gap: 4 }}>
        {view.fields.map(([label, value]) => (
          <View key={label} style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={{ width: 56, fontSize: 12, color: colors.ink3 }}>{label}</Text>
            <Text selectable style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, color: colors.ink }}>{value}</Text>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View>
      {maxHeight ? (
        <ScrollView style={{ maxHeight }} nestedScrollEnabled showsVerticalScrollIndicator>
          {body}
        </ScrollView>
      ) : body}
      {view.kind !== 'json' ? (
        <TouchableOpacity onPress={() => setRaw((r) => !r)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} style={{ alignSelf: 'flex-end', marginTop: 6 }}>
          <Text style={{ fontSize: 11.5, color: colors.ink3 }}>{raw ? '可读视图' : '原始参数'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
