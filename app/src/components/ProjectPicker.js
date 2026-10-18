import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { ALL_PROJECTS, UNCLASSIFIED, pathTail, projectTitles, shortPath } from '../lib/projects.js';
import { useTheme } from '../theme.js';

const renderBackdrop = (props) => (
  <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
);

// 项目底部 sheet，沿用 ModelPicker 的 BottomSheetModal 外观。
// variant="filter"：抽屉浏览筛选（全部 / 未归类 / 项目），value 为 projectId。
// variant="target"：Home 新建目标，只列出项目里真实出现过的 cwd（多个 worktree 分行），value 为 cwd。
export function ProjectPicker({ sheetRef, variant, catalog, value, onPick, loaded, error, onRetry }) {
  const { colors } = useTheme();
  const titles = projectTitles(catalog.projects);

  const renderHandle = () => (
    <View style={{ alignItems: 'center', paddingVertical: 8 }}>
      <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.ink3 }} />
    </View>
  );

  const pick = (v) => { onPick(v); sheetRef.current?.dismiss(); };

  const row = (key, { title, sub, count, selected, onPress, indent = false, badge, testID }) => (
    <TouchableOpacity
      key={key}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[title, badge, count != null ? `${count} 个对话` : '', sub].filter(Boolean).join('，')}
      accessibilityState={{ selected }}
      style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingVertical: 10, paddingLeft: indent ? 32 : 16, paddingRight: 16 }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.inkStrong, fontSize: 15 }}>{title}</Text>
          {badge ? <Text style={{ color: colors.ink3, fontSize: 11.5 }}>{badge}</Text> : null}
        </View>
        {sub ? <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.ink2, fontSize: 12, marginTop: 2 }}>{sub}</Text> : null}
      </View>
      {count != null ? <Text style={{ color: colors.ink3, fontSize: 12.5, marginLeft: 10, fontVariant: ['tabular-nums'] }}>{count}</Text> : null}
      <Text style={{ width: 22, textAlign: 'right', color: colors.accent, fontSize: 16 }}>{selected ? '✓' : ''}</Text>
    </TouchableOpacity>
  );

  const filterRows = () => [
    row('all', { title: '全部对话', count: catalog.totalSessions, selected: value === ALL_PROJECTS, onPress: () => pick(ALL_PROJECTS), testID: 'project-option-all' }),
    ...(catalog.unclassifiedCount > 0 || value === UNCLASSIFIED
      ? [row('unclassified', { title: '未归类', sub: '缺少工作目录的旧会话', count: catalog.unclassifiedCount, selected: value === UNCLASSIFIED, onPress: () => pick(UNCLASSIFIED), testID: 'project-option-unclassified' })]
      : []),
    ...catalog.projects.map((p) => row(p.id, {
      title: titles.get(p.id), sub: shortPath(p.id), count: p.sessionCount,
      selected: value === p.id, onPress: () => pick(p.id), testID: `project-option-${p.id}`,
    })),
  ];

  const targetRows = () => catalog.projects.flatMap((p) => {
    if (p.cwds.length <= 1) {
      const cwd = p.cwds[0] || p.cwd;
      return cwd ? [row(p.id, {
        title: titles.get(p.id), sub: shortPath(cwd), count: p.sessionCount,
        selected: value === cwd, onPress: () => pick(cwd), testID: `workspace-option-${cwd}`,
      })] : [];
    }
    return [
      <View key={`${p.id}:h`} accessible accessibilityRole="header" style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 12, paddingBottom: 2, paddingHorizontal: 16 }}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: 13, fontWeight: '600' }}>
          {titles.get(p.id)} · {p.cwds.length} 个工作目录
        </Text>
        <Text style={{ color: colors.ink3, fontSize: 12.5, marginRight: 22, fontVariant: ['tabular-nums'] }}>{p.sessionCount}</Text>
      </View>,
      ...p.cwds.map((cwd) => row(`${p.id}:${cwd}`, {
        title: pathTail(cwd, 1), sub: shortPath(cwd), indent: true,
        badge: cwd === p.cwd ? '最近' : '', selected: value === cwd,
        onPress: () => pick(cwd), testID: `workspace-option-${cwd}`,
      })),
    ];
  });

  const rows = variant === 'filter' ? filterRows() : targetRows();
  const empty = variant === 'target' && rows.length === 0;

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      maxDynamicContentSize={600}
      backdropComponent={renderBackdrop}
      handleComponent={renderHandle}
      backgroundStyle={{ backgroundColor: colors.card }}
    >
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: 24 }} testID={`project-picker-${variant}`}>
        <View style={{ alignItems: 'center', paddingVertical: 6 }}>
          <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13 }}>
            {variant === 'filter' ? '浏览项目' : '新对话的工作目录'}
          </Text>
        </View>
        {error ? (
          <TouchableOpacity onPress={onRetry} accessibilityRole="button" accessibilityLabel={`${error}，重试`} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 }}>
            <Text style={{ color: colors.danger, fontSize: 13, textAlign: 'center' }}>{error} · 点击重试</Text>
          </TouchableOpacity>
        ) : null}
        {!loaded && !error ? <ActivityIndicator style={{ marginVertical: 12 }} color={colors.ink2} /> : null}
        {loaded && empty ? (
          <Text style={{ padding: 16, color: colors.ink3, fontSize: 13, textAlign: 'center' }}>
            还没有可用的工作目录。先在 Mac 上用 Claude Code 打开一个项目。
          </Text>
        ) : null}
        {rows}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
