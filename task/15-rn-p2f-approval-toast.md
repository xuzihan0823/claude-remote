# 15 · RN P2-F：ApprovalLayer + Toast（可并行）

## 目标

全局审批浮层（乐观更新语义照搬）+ 轻量 toast，都要浮在键盘上方。

## 文件所有权（只写这些）

- `app/src/components/ApprovalLayer.js`（覆盖桩；Countdown/ApprovalCard 子组件放同文件或同目录新文件均可）
- `app/src/components/Toast.js`（覆盖桩，导出 `ToastLayer`）

## 规格（行为逐行对照 web/ui/components/approval.js 与 toast.js）

**ToastLayer**：bus 'toast' 事件 `{id,text,kind}` 入栈，3200ms 自动移除；绝对定位底部居中小胶囊堆叠（kind: info/error 配色）；用 react-native-keyboard-controller 的 `KeyboardStickyView`（或 useKeyboardAnimation)骑在键盘上方；渲染在 App 根最后一个，天然置顶。

**ApprovalLayer**：
- bus `ws:approval` 入队（interactionId 去重）；`ws:approval.resolved` 打 resolved 戳 + scheduleRemoval
- scheduleRemoval：ref Map 幂等 500ms 后移除（本地与 WS 双触发不重置计时）；cancelRemoval 配对
- 只渲染 items[0]，多余显示「还有 N 个待处理」小条
- ApprovalCard：头部 = kind 图标（🔐 审批/❓ 提问）+ toolName + Countdown（每秒 tick，剩 ≤20s 变 warn 色，resolved 后停表，过期显示「已超时」）；会话行 = sessionCache 取 title 截 24 或 id 前 8；prompt 文本
- approval kind：input JSON 折叠块（摘要 = JSON 截 80 等宽，展开 pretty JSON 等宽横向滚动）+ 拒绝理由输入框（可选）+ 按钮 拒绝/允许一次
- question kind：questions 数组渲染（header chip、question 文本、multiSelect 标注、options 按钮组 on 高亮多选/单选切换、自由输入框兜底）；全部作答才可「提交回答」；answers 结构 `{[question]: free || sel.join(', ')}`
- decide 乐观更新（照抄 web）：点击立即打戳（deny→denied/answer→answered/allow→allowed），HTTP 后台 POST `/api/interactions/:id/decision`；200 用响应 status 校正；**409 → toast '该审批已在别处处理'、404 → toast '审批已不存在'（都不回滚）**；其它失败回滚（清戳+取消移除计时）+ toast；resolved 后按钮禁用防双击
- resolved 戳视觉：卡片右上角标签（已允许/已拒绝/已作答/已超时）+ 卡片降透明
- 定位：屏幕底部浮层（全宽卡片、圆角 island 24、阴影），键盘弹出时用 KeyboardStickyView 骑上去；zIndex 在 sheet 之上 toast 之下（App 根渲染顺序已保证）

## 参考（只读）

web/ui/components/approval.js、web/ui/components/toast.js、docs/api-contract.md 的 approval WS 帧与 decision 端点、web/core/{api,bus}.js、app/src/lib/format.js（truncate）、app/src/theme.js、app/src/App.js（挂载位置）。

## 约束

- core 从 `../../../web/core/*.js` import；不新增依赖；JS；文案照抄 web；不要运行 expo/metro/xcodebuild；不改所有权外文件。

## 交付

文件清单 + 关键决策 + 未决问题。
