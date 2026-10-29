import { useImperativeHandle, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { ALL_PROJECTS, UNCLASSIFIED, pathTail, projectTitles, shortPath } from '../lib/projects.js';
import { GlassMenu } from './GlassMenu.js';
import { useTheme } from '../theme.js';

// 项目选择液态玻璃下拉菜单：
// variant="filter"：抽屉浏览筛选（全部 / 未归类 / 项目），value 为 projectId。
// variant="target"：Home 新建目标，只列出项目里真实出现过的 cwd（多个 worktree 分行），value 为 cwd。
export function ProjectPicker({ sheetRef, anchor: propAnchor, variant, catalog, value, onPick, loaded, error, onRetry }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [dynAnchor, setDynAnchor] = useState(null);
  const titles = projectTitles(catalog.projects);

  useImperativeHandle(sheetRef, () => ({
    present: (customAnchor) => {
      if (customAnchor && typeof customAnchor.x === 'number') setDynAnchor(customAnchor);
      setOpen(true);
    },
    dismiss: () => setOpen(false),
  }), []);

  const row = (key, { title, sub, count, selected, onPress, indent = false, badge, testID }) => ({
    key,
    label: title,
    detail: sub,
    count,
    selected: !!selected,
    indent,
    badge,
    testID,
    accessibilityRole: 'button',
    onPress,
  });

  const filterItems = () => [
    row('all', {
      title: '全部对话',
      count: catalog.totalSessions,
      selected: value === ALL_PROJECTS,
      onPress: () => onPick(ALL_PROJECTS),
      testID: 'project-option-all',
    }),
    ...(catalog.unclassifiedCount > 0 || value === UNCLASSIFIED
      ? [row('unclassified', {
        title: '未归类',
        sub: '缺少工作目录的旧会话',
        count: catalog.unclassifiedCount,
        selected: value === UNCLASSIFIED,
        onPress: () => onPick(UNCLASSIFIED),
        testID: 'project-option-unclassified',
      })]
      : []),
    ...catalog.projects.map((p) => row(p.id, {
      title: titles.get(p.id),
      sub: shortPath(p.id),
      count: p.sessionCount,
      selected: value === p.id,
      onPress: () => onPick(p.id),
      testID: `project-option-${p.id}`,
    })),
  ];

  const homeProject = catalog.projects.find((p) => p.id === catalog.homeCwd);
  const targetItems = () => [
    ...(catalog.homeCwd ? [row('home', {
      title: '主目录 (~)',
      sub: shortPath(catalog.homeCwd),
      count: homeProject?.sessionCount,
      selected: value === catalog.homeCwd,
      onPress: () => onPick(catalog.homeCwd),
      testID: 'workspace-option-home',
    })] : []),
    ...catalog.projects.filter((p) => p.id !== catalog.homeCwd).flatMap((p) => {
      if (p.cwds.length <= 1) {
        const cwd = p.cwds[0] || p.cwd;
        return cwd ? [row(p.id, {
          title: titles.get(p.id),
          sub: shortPath(cwd),
          count: p.sessionCount,
          selected: value === cwd,
          onPress: () => onPick(cwd),
          testID: `workspace-option-${cwd}`,
        })] : [];
      }
      return [
        {
          key: `${p.id}:h`,
          type: 'section',
          label: `${titles.get(p.id)} · ${p.cwds.length} 个工作目录`,
          count: p.sessionCount,
        },
        ...p.cwds.map((cwd) => row(`${p.id}:${cwd}`, {
          title: pathTail(cwd, 1),
          sub: shortPath(cwd),
          indent: true,
          badge: cwd === p.cwd ? '最近' : '',
          selected: value === cwd,
          onPress: () => onPick(cwd),
          testID: `workspace-option-${cwd}`,
        })),
      ];
    }),
  ];

  const items = variant === 'filter' ? filterItems() : targetItems();
  const empty = variant === 'target' && items.length === 0;

  return (
    <GlassMenu
      visible={open}
      anchor={dynAnchor || propAnchor}
      title={variant === 'filter' ? '浏览项目' : '新对话的工作目录'}
      items={items}
      width={284}
      testID={`project-picker-${variant}`}
      onClose={() => setOpen(false)}
    >
      {error ? (
        <TouchableOpacity
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={`${error}，重试`}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 }}
        >
          <Text style={{ color: colors.danger, fontSize: 13, textAlign: 'center' }}>{error} · 点击重试</Text>
        </TouchableOpacity>
      ) : null}
      {!loaded && !error ? <ActivityIndicator style={{ marginVertical: 12 }} color={colors.ink2} /> : null}
      {loaded && empty ? (
        <Text style={{ padding: 16, color: colors.ink3, fontSize: 13, textAlign: 'center' }}>
          还没有可用的工作目录。先在 Mac 上用 Claude Code 打开一个项目。
        </Text>
      ) : null}
    </GlassMenu>
  );
}
