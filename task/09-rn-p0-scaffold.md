# 09 · RN 迁移 P0：脚手架 + 连接链路骨架（主窗口完成）

> 状态：✅ 2026-07-23 主窗口完成。本卡为执行记录（agent team 模式，未分发外部窗口）。

## 完成内容

- 基线 commit 82773cd（07-22 未提交改动 + RN 迁移规划文档）。
- `app/` Expo 工程（SDK 57 / RN 0.86 / React 19.2.3，blank 模板，独立 npm 不进 pnpm workspace）。
- 依赖：react-native-keyboard-controller 1.21.9 / reanimated 4.5 / gesture-handler / screens / safe-area-context / svg / mmkv 4.3 / @react-navigation v7 (native+native-stack+drawer) / @gorhom/bottom-sheet 5.2 / expo-image-picker / expo-document-picker / expo-linking / expo-file-system / expo-splash-screen / expo-dev-client。
- `metro.config.js`：watchFolders 加 `../web`（core 状态层 + vendored marked 直接 import，不复制）；`resolveRequest` 把 `web/vendor/preact-htm-standalone.module.js` 重定向到 `src/shims/preact-htm.js`（core/bus.js 的 useBus 需要 useEffect，RN 端由 react 提供）——计划外发现，比改 web 源码更安全。
- `src/lib/storage.js`：MMKV 同步 localStorage shim，`index.js` 第一行 import（core/api.js 模块加载期读 localStorage）。
- `web/core/api.js`：connHost/wsEndpoint 加 `typeof location` guard（web 行为不变，node --check 过，daemon 静态页照常）。
- `app.json`：name "Claude Remote"、scheme `claude-remote`、bundleId `cc.anyyu.clauderemote.rn`（与旧 Capacitor 壳区分，可并存对比；上 TestFlight 前再换正式 id）、ATS 豁免（http daemon 必需）、userInterfaceStyle automatic、splash 明暗底色。
- `src/theme.js`：style.css :root 明暗两套 token 一一对应移植 + fonts（Georgia/Songti SC/Menlo）+ radius/dur/spring。
- `src/App.js`：鉴权门（token→checking→ok / need）、tryConnect/tryConnectBases（多候选探测）、unauthorized/logout 总线、AppState 回前台 reconnectNow、expo-linking 深链→PairConfirm、Drawer(自定义内容)+native-stack(Home/Chat/Settings，Chat 按 sessionId getId) 导航壳、全局 ApprovalLayer/ToastLayer 挂载位。
- 屏幕/组件桩：ConnectScreen、SettingsScreen、ChatScreen、DrawerContent、PairConfirm、ApprovalLayer、Toast —— 桩文件边界即后续任务卡的文件所有权边界。

## 验收

expo prebuild + xcodebuild 模拟器构建启动成功（见 PROGRESS.md 当日小节）。
