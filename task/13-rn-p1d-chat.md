# 13 · RN P1-D：ChatScreen 只读流 + MessageRow（主窗口完成）

> 状态：✅ 2026-07-23 主窗口完成（滚动锚定/流式/补缺口逻辑最微妙，未外派）。

## 实现要点

- `app/src/screens/ChatScreen.js`：web/ui/screens/chat.js 全逻辑移植。列表 = **inverted FlatList**（数据倒序，最新 index 0）+ `maintainVisibleContentPosition {minIndexForVisible:1, autoscrollToTopThreshold:100}` 原生实现贴底跟随与翻页不跳（web 的 stick/prependRef 机制不再需要）；向上翻页 = onEndReached；pending 气泡与运行中打字点放 ListHeader（inverted 的视觉底部）；「加载更早消息」/空态/错误放 ListFooter（视觉顶部）。
- 保留 web 全部微妙行为：新会话落盘竞态重试 8×250ms、ws:message 微任务合并、addMsgs 追加快路径、resync 清空重拉、ws-open 无重叠向前补最多 3 页、run started 帧带 permissionMode 才更新本地模式记忆、pending 与回显去重。
- `app/src/components/MessageRow.js`：meta/thinking/tool_use/tool_result/text 五 kind；折叠块（web `<details>` 对应物）共用 Block 组件；tool 输入/结果等宽横向滚动;user 气泡 bubble 底、assistant 走 MarkdownView。
- `keyboardDismissMode="interactive"` 已挂（P3 键盘验收硬门槛之一）。
- Composer 位挂 `components/composer/ChatComposer.js`，暂为桩，P2-E 按契约替换：props `{ sessionId, status, isRunning, activeRunId, mode, onModeChange, onSent, onStopped }`。
