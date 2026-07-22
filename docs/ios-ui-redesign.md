# iOS 端 UI 重构规划（参照 Claude 官方 iOS App 设计）

> 2026-07-22 定稿。目标：把现有 web UI（Capacitor 壳内）重构成接近 Claude 官方 iOS app 的观感与质感，同时完成状态/视图分层，为将来可能的 RN 迁移留出接口。清空上下文后从本文档恢复。

## 0. 已拍板的前提（勿回头重议）

- **架构不动**：继续 Capacitor + web UI。理由：聊天流/markdown/代码高亮是 HTML 强项；同一份代码服务浏览器直连场景；Android 版将来 `cap add android` 低成本跟进。RN/Flutter 重写仅在产品验证成功且质感仍是瓶颈时再评估。
- **分层为迁移留路**：本次重构把「状态层」（连接、WS、会话、审批、模式）从 DOM/组件中剥离成纯 TS 模块。将来迁 RN 时状态层直接搬走，只重写视图。
- 不做：语音输入、incognito chat。保留：模型选择、附件上传、设置页。新增：权限模式选择（见 §6）。

## 1. 参照设计拆解（对照用户提供的官方 app 截图）

| 元素 | 官方设计 | 我们的对应 |
|---|---|---|
| 底色 | 奶油白 #F5F4EF 类（非纯白），整体暖灰 | 全局换暖色 token，暗色模式对应深暖灰 |
| 顶部 | 左右两个悬浮圆形按钮（汉堡=抽屉、右上功能钮） | 左=会话抽屉（现有 Sidebar），右上改为「连接状态点」入口（点开=设置页） |
| 主屏中央 | 橙红色星形 logo + 大号衬线问候语 "Back at it, 小鱼" | 星形换我们的标识；问候语随时段变化（早/午/晚），衬线字体（中文配霞鹜/思源宋，英文 serif） |
| 底部 composer | 大圆角浮岛卡片：占位文案 + 左下「+」+ 模型 pill "Sonnet 5 Medium" | 同布局：+ = 附件；模型 pill 点开弹层；**新增模式 pill**（§6）；右下发送圆钮（替代语音钮位置） |
| 键盘弹出 | composer 平滑上移 | 沿用现有 --vvh 机制 + transition |

## 2. 现状盘点（重构范围）

- `web/app.js` 1581 行单文件（htm/preact），组件已清点：工具函数、api/ws/bus、Markdown、ConnBar、ModelPicker、ProjectPicker、SetupGate、SettingsPage、PairPage、Sidebar、NewChatComposer、StartScreen、MessageRow、Chat、Countdown、ApprovalCard/Layer、useVVH、PairConfirm、App(路由)。
- `web/style.css` 601 行；`index.html` 22 行。无构建器，浏览器原生 ES module。
- daemon 侧：`permissionMode` 目前硬编码 `"default"`（packages/agent-bridge/src/sdk-bridge.ts:62）；消息接口已支持 per-turn `model`。

## 3. 目标文件结构（拆分单文件）

```
web/
  index.html
  core/            ← 状态层：纯 TS/JS，零 DOM，可迁 RN
    api.js         （api()/超时/多 base 探测，自 app.js 抽出）
    ws.js          （WS 连接机/重连）
    bus.js         （事件总线）
    store.js       （会话缓存、模型目录、连接配置持久化）
    modes.js       （新增：权限模式定义与持久化）
  ui/
    app.js         （路由 + App 壳）
    theme.css      （design tokens：色板/字体/圆角/阴影/动效时长）
    screens/       home.js chat.js settings.js pair.js setup.js
    components/    composer.js model-sheet.js mode-sheet.js drawer.js
                   message.js approval.js markdown.js toast.js
```

保持无构建器（原生 ES module import），daemon 静态托管不变；Capacitor `cap sync` 流程不变。

## 4. 视觉系统（theme.css design tokens）

- 色板：`--bg` 奶油白/深暖灰、`--accent` 陶土橙（官方星形色 ~#D97757）、`--ink` 暖黑、卡片 `--card` 微白浮层 + 大圆角(24px) + 极浅阴影。明暗两套，`prefers-color-scheme` 自动。
- 字体：问候语/标题 serif（`Georgia, 'Songti SC'` 起步，够用再引子集化 webfont）；正文系统 sans；代码 SF Mono。
- 动效 tokens：`--dur-fast 150ms / --dur 250ms / --dur-slow 400ms`，缓动 `cubic-bezier(0.32,0.72,0,1)`（iOS 弹簧近似）。

## 5. 逐屏方案与动画清单

1. **Home（新会话屏）**：中央 logo+问候（进场 fade+上移 400ms）；底部 composer 浮岛。项目选择收进 composer 的「+」弹层或首行 pill。
2. **Composer（复用于 Home 与 Chat）**：+（附件：拍照/相册/文件）、模型 pill、模式 pill、发送钮。pill 点击弹**底部 sheet**（上滑进场 250ms + 遮罩淡入，下滑手势可关）。附件缩略图横向列表，删除有缩放退场。
3. **Chat**：消息进场（assistant 流式块 fade-in 150ms，不做逐字动画防抖动）；工具卡片折叠/展开高度动画；滚到底按钮淡入；顶部会话标题 + 状态点。
4. **抽屉 Drawer**：沿用现有滑出，改按官方样式（全高、圆角右缘、列表项按压反馈），遮罩淡入统一 token。
5. **审批卡 ApprovalCard**:底部弹出样式与 sheet 统一;决策后卡片收起动画(现有 500ms 移除逻辑保留)。
6. **Settings / SetupGate / Pair**：视觉套新 token 即可,逻辑不动（刚修完的多候选探测/扫码链路是基石,勿动）。
7. 全局：按钮按压 scale(0.97)；页面路由切换用 CSS transition（WKWebView 的 View Transitions API 可用性存疑,不依赖）。

## 6. 新功能：权限模式选择

SDK 支持的 permissionMode：`default`（逐项审批）/ `acceptEdits`（自动同意编辑）/ `plan`（只读规划）/ `bypassPermissions`（全自动,危险）。产品命名：**标准 / 自动编辑 / 规划 / Bypass**。

改造链路（由内向外）：
1. `agent-bridge`：`StartQueryOptions` 加 `permissionMode?`，透传给 sdkOptions（默认仍 default）；bypass 时 SDK 不回调 canUseTool,审批层天然静默。
2. `daemon`：POST 新建会话/继续消息的 body 加 `permissionMode` 字段,校验白名单,落到 TurnRunner→startSdkQuery;会话状态里记录当前模式并随 WS 事件广播（前端显示徽标）。
3. 前端：composer 模式 pill + mode-sheet;**每会话记忆**（store 持久化）;选 bypass 弹二次确认（红色警示文案）,聊天页顶部常驻 bypass 徽标。
4. 测试：agent-bridge 透传用例;daemon 白名单校验用例。

## 7. 实施顺序（任务卡草案，经确认后生成 task/ 目录）

1. **T1 状态层抽离**（core/ 五文件 + ui 引用改造,行为零变化,回归现有全部功能）——先行,后续任务的地基,不可并行。
2. **T2 视觉系统 + Home + Composer**（theme.css、问候屏、composer 浮岛、模型/附件迁入）
3. **T3 Chat 消息流改版**（message/工具卡/滚动/动画）——与 T2 并行有限重叠（都碰 composer 挂载点）,串行更稳:T2→T3。
4. **T4 模式选择全链路**（agent-bridge→daemon→前端 pill/sheet）——与 T2/T3 文件不重叠,可与 T2 并行（daemon 侧先行）。
5. **T5 抽屉/审批/设置套新样式 + 全局动效统一 + 真机回归**（收尾集成,主窗口做）。

每步完成:typecheck + daemon 测试 + Chrome 手机视口人肉过一遍 + `cap sync ios` 重建真机验收,更新 PROGRESS.md。

## 8. 验收标准

- 官方截图并排对比,布局/配色/圆角/字级一眼相似;明暗两模式无破相。
- 现有功能零回归:扫码配对、多候选切换、附件先传后发、审批乐观更新、模型选择、resume 可见性。
- 新增:四种模式可选可记忆,bypass 有确认与常驻警示;daemon 白名单校验拒绝非法值。
- 动画在真机 60fps(不掉帧关键项:sheet 弹出、抽屉、键盘跟随)。
