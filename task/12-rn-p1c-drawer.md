# 12 · RN P1-C：抽屉会话列表 + 状态徽标 + 格式化工具（可并行，无依赖）

## 目标

Drawer 内容（最近对话/新对话/设置/连接状态，WS 实时状态点）+ 会话状态徽标 + utils 移植。

## 文件所有权（只写这些）

- `app/src/components/DrawerContent.js`（覆盖现有桩）
- `app/src/components/StatusBadge.js`（新建）
- `app/src/lib/format.js`（新建）

## 规格

**format.js**：从 `web/ui/utils.js` 移植 `STATUS_LABEL、relTime、fmtClock、fmtBytes、cwdTail、truncate、toolSummary、msgKey、cmpMsg`（原样纯函数）。另加 `statusColor(colors, status)`：查 `web/style.css` 里 `.dot-idle/.dot-term/.dot-run` 的实际配色语义（grep "dot-"），映射到 theme token（大致 idle→ok、terminal-driving→warn、daemon-driving→info，以 css 实际为准）。

**StatusBadge** `{ status }`：无 status 渲染 null；胶囊（小圆点 + STATUS_LABEL 文案，12px，bubble 底）。ChatScreen 顶栏会用。

**DrawerContent**（drawer 标准 props，含 navigation）：移植 `web/ui/components/sidebar.js`：
- 数据：mount 时 `fetchSessions(100)`（core api.js）+ 每 30s 静默刷新 + bus `ws-open` 刷新 + AppState 回 active 刷新（对应 web 的 visibilitychange）；bus `ws:status` 单条更新对应会话 status。按 lastActiveAt 降序。
- 头部：品牌行（Spark：`import { Spark } from './Spark.js'`，别的代理在写，直接 import）+ 「Claude Remote」衬线 + 右侧 ⟳ 刷新按钮。
- 导航项：「＋ 新对话」→ `navigation.navigate('Main', { screen: 'Home' })`；「⚙ 设置」→ `navigation.navigate('Main', { screen: 'Settings' })`；点会话 → `navigation.navigate('Main', { screen: 'Chat', params: { sessionId } })`。跳转后 `navigation.closeDrawer()`。
- 列表（FlatList）：行 = title（单行 ellipsizeMode tail）+ 右侧状态点（statusColor）；副行 = cwdTail(cwd) · relTime(lastActiveAt)。空态「没有会话」、错误态「…点击重试」。total > 已显示时脚注「已显示 x / y 个会话」。
- 脚注：连接点（ws.state.phase：open→ok / connecting→warn / closed→danger，bus `ws-state` 实时）+ `connHost()` 等宽。
- 30s 计时器同时驱动 relTime 重渲染（web 同款 tick）。

## 参考（只读）

`web/ui/components/sidebar.js`、`web/ui/components/conn-bar.js`、`web/ui/utils.js`、`web/core/api.js`、`web/core/ws.js`、`web/core/bus.js`（useBus）、`app/src/theme.js`、`app/src/App.js`（导航结构：Drawer→Main→Stack[Home/Chat/Settings]）。

## 约束

- core 从 `../../../web/core/*.js` import；不新增依赖；不改所有权外文件（Spark.js 归 P1-A，只 import）；JS；文案简体中文照抄 web。
- 不要运行 expo/metro/xcodebuild。

## 交付

文件清单 + 关键实现决策 + 未决问题。
