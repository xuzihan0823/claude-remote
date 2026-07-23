# RN 迁移规划（iOS 端由 Capacitor 壳 → React Native）

> 2026-07-23 定稿。用户在真机验证 Plan B 键盘方案（resize:none + --kb 提前驱动，见 PROGRESS 2026-07-23 小节）后仍不满意，拍板启动 RN 迁移。本文档为新会话零上下文开工的执行依据。**本决策取代 docs/ios-ui-redesign.md §0 的「架构不动」前提；该文档的视觉系统（§1/§4/§5）与权限模式产品定义（§6）继续有效，作为 RN 实现的设计规格。**

## 0. 为什么迁、迁到哪

- **主因＝键盘质感**：WKWebView 键盘适配已做到天花板（keyboardWillShow 提前信号 + 自绘 250ms 过渡），但 webview 永远拿不到键盘的逐帧位置（尤其交互式拖拽收起），跟手感与原生有本质差距。用户已真机否决。
- **目标＝React Native + Expo（prebuild/dev client 模式，非 Expo Go）**。理由：
  1. `web/core/` 状态层是纯 JS 零 DOM（当初分层就是为此），RN 直接复用；SwiftUI 则要全部重写；
  2. 键盘用 `react-native-keyboard-controller`（原生层逐帧同步，支持交互式拖拽收起）——迁移动机的直接答案；
  3. 将来 Android 近乎免费；
  4. Expo prebuild 生成 ios/ 原生工程，延续用户现有 Xcode 签名/装机流程。
- **迁移范围＝仅手机 App 视图层**。daemon、agent-bridge、API 契约、`web/`（浏览器直连场景继续由 daemon 静态托管）、Mac 菜单栏 App 全部不动。旧 Capacitor 壳（ios/ 目录）保留到 RN 版真机验收通过后再删。

## 1. 仓库布局与 core 复用机制

```
claude-remote/
  app/                    ← 新：Expo RN 工程（独立 package.json，用 npm/bunx 管理，
                             不进 pnpm workspace——避免 metro 与 pnpm 符号链接摩擦）
    app.json / app/ 或 src/（expo-router 或手动导航，见 §3）
    metro.config.js       ← watchFolders 加 ../web/core，直接 import 状态层源文件
    src/lib/storage.js    ← MMKV 同步 shim：启动时挂 global.localStorage（get/set/removeItem）
                             必须在任何 core 模块 import 之前执行（入口文件第一行 import）
  web/core/               ← 状态层唯一真相（web 与 RN 共用，不复制）
```

### core 复用前的两处小改（改 web/core/，web 端行为不变，需回归浏览器）

1. `api.js`：`connHost()`/`wsEndpoint()` 内对 `location` 的读取加 `typeof location !== 'undefined'` guard（RN 无 location；这两个分支只在 baseUrl 为空的同源场景走，RN 恒有显式 baseUrl，guard 后返回值兜底空串/由 baseUrl 推导 ws 地址）。
2. `api.js` 顶部的 `localStorage.getItem` 是模块加载期执行 → RN 端靠 storage shim 先挂载即可，core 不用改；但 shim 必须同步（选 `react-native-mmkv`，同步 API，正好对齐 localStorage 语义；AsyncStorage 不行）。

其余（ws.js 的 `WebSocket`、api.js 的 `fetch`/`AbortController`、bus.js、modes.js、store.js）RN 原生可用，零改动。

## 2. 与 daemon 的契约（已全部就绪，RN 端只是换个消费者）

- REST：`/api/health`、`/api/sessions`（GET 列表 / POST 新建含 `permissionMode`）、`/api/sessions/:id/messages`（GET 分页 beforeSeq / POST 继续含 `model`+`permissionMode`）、`/api/sessions/:id/abort`、`/api/sessions/:id/upload` 与 `/api/upload`（二进制 body + filename query）、`/api/models`、`/api/pair-info`（loopback-only，手机不调）。Bearer token 鉴权，401 语义=token 错。
- WS：订阅制（subscribe/unsubscribe per sessionId），帧类型 `message`/`status`/`run`（started 可携 `permissionMode`）/`resync`/审批相关。心跳 30s。
- 配对深链：`claude-remote://setup?v=1&token=…&bases=…`（多候选逗号分隔）→ RN 用 `Linking` 接（app.json 注册 scheme），复用 web/ui/app.js 的 `parseSetupLink` 逻辑（纯函数，可搬进 core 或复制）。
- 多候选探测：core/api.js `probeBases`（401 立即终态、超时走 AbortController）原样复用。

## 3. 技术选型（执行会话以当时最新稳定版为准）

| 事项 | 选型 | 一行理由 |
|---|---|---|
| 框架 | Expo（≥SDK 54，新架构默认开） | prebuild 出原生工程，走用户现有 Xcode 流程 |
| 键盘 | react-native-keyboard-controller | 原生逐帧同步+交互式拖拽收起，迁移主因的答案 |
| 导航 | @react-navigation native-stack + drawer | 会话抽屉=drawer；页面少，不必 expo-router |
| 列表 | FlatList inverted + maintainVisibleContentPosition | 聊天流标准做法；向上翻页锚点不跳（性能不够再上 FlashList） |
| 底部 sheet | @gorhom/bottom-sheet | 模型/模式选择弹层，手势下滑关 |
| 动画 | react-native-reanimated | keyboard-controller/bottom-sheet 的依赖，顺带做进出场 |
| Markdown | 复用 vendored marked 的 lexer 产 token 树 + 自写 token→RN 组件渲染器 | 与 web 输出一致、流式增量友好；备选 react-native-markdown-display |
| 存储 | react-native-mmkv（+localStorage shim） | 同步 API 对齐 localStorage，core 零改动 |
| 附件 | expo-image-picker + expo-document-picker | 拍照/相册/文件，POST 二进制沿用现有接口 |
| 字体 | iOS 系统 serif（New York）+ Songti SC；正文 system sans | 对齐 ios-ui-redesign §4，零字体文件 |
| 主题 | theme.ts 移植 style.css 的 token（明暗两套，useColorScheme） | token 名一一对应，方便对照 |

## 4. 屏幕/组件映射（web → RN，设计规格一律对照 docs/ios-ui-redesign.md）

| web 现存 | RN 对应 | 备注 |
|---|---|---|
| ui/app.js（路由+壳） | navigation 容器 + AppState 前台时 ws.reconnectNow() | RN 后台会挂起 timer，回前台必须主动重连 |
| screens/setup.js SetupGate | ConnectScreen | token/地址表单 + probeBases + 深链确认卡 |
| screens/home.js | HomeScreen | 居中问候 + 底部 composer（KeyboardStickyView） |
| screens/chat.js | ChatScreen | inverted FlatList + 流式追加 + 乐观 pending + resync 全量重拉 |
| screens/settings.js | SettingsScreen | 连接信息/断开/健康状态 |
| screens/pair.js | 不迁 | 那是 Mac 侧网页 |
| components/composer.js | Composer（Home/Chat 共用，RN 版直接做成一个） | 附件 chips/模型 pill/模式 pill/发送-停止 |
| model-picker / mode-sheet | 两个 bottom-sheet + bypass 确认 Alert 或自绘卡 | 逻辑照抄，含每会话模式记忆 |
| components/approval.js | ApprovalLayer（全局浮层，键盘上方） | 乐观更新/500ms 收起/倒计时逻辑照搬 |
| components/markdown.js | MarkdownView（marked lexer + 组件映射） | 链接拦截 javascript:、外链 Linking.openURL |
| components/sidebar.js | Drawer 内容 | 最近对话/新对话/设置/连接状态 |
| toast.js | 轻量自绘 toast（reanimated） | 骑在键盘上方 |

## 5. 分阶段任务卡草案（新会话确认后生成 task/09-xx 起的卡）

- **P0 脚手架 + 连接链路**（1-2 个会话，单窗口）：Expo 工程初始化（app/，独立 npm）、metro watchFolders 指向 ../web/core、MMKV localStorage shim、theme.ts token 移植、导航壳、ConnectScreen（表单+probeBases）、`claude-remote://` 深链接线、core 的 location guard 小改 + 浏览器回归。验收：真机装上、扫码/手填都能连上 daemon 并列出会话。
- **P1 聊天只读流**（1-2 个会话）：会话抽屉列表（WS status 实时戳）、ChatScreen 只读（分页/流式/resync/滚动锚定）、MarkdownView（含代码块等宽+工具卡折叠）。验收：Mac 终端驾驶时手机实时旁观不丢帧不跳滚。
- **P2 交互全量**（2-3 个会话）：Composer（发送/停止/附件先传后发/模型 pill/模式 pill+bypass 确认徽标/每会话记忆）、审批浮层（乐观更新语义照搬）、新建会话。验收：ios-ui-redesign §8 的功能清单在 RN 端全过。
- **P3 键盘与质感收尾**（1 个会话 + 真机迭代）：keyboard-controller 全接入（含 interactive dismiss）、动效、暗色、图标/启动屏（复用 icons/ 芒星）、TestFlight/签名。验收见 §6。
- P0→P1→P2 串行为主（同吃 app/ 目录，多窗口并行收益低、冲突高）；P2 里审批浮层与 Composer 可拆两窗口并行（文件不重叠）。

## 6. 键盘验收标准（迁移的存在理由，P3 硬门槛）

1. 聚焦输入框：composer 与键盘**同帧**上浮，无滞后无跳变；
2. 列表 keyboardDismissMode="interactive"：拖拽收键盘时 composer 逐帧跟随手指；
3. 键盘开着时打开模型/模式 sheet、弹审批卡：浮层位于键盘上方；
4. 旋转/表情面板切换高度变化平滑；
5. 对照官方 Claude iOS App 并排录屏，键盘行为无肉眼差距。

## 7. 风险与规避

- **metro×monorepo**：app/ 独立 npm + watchFolders 白名单只加 web/core，不碰 pnpm 根；
- **marked 在 Hermes 下的兼容**：vendored ESM 是纯 JS，预期无碍；万一有问题退 react-native-markdown-display；
- **RN 后台 WS 假死**：AppState active 时 reconnectNow + 拉尾页补缺口（web 端 ws-open 补缺逻辑照搬）；
- **新架构库兼容**：keyboard-controller / bottom-sheet / reanimated 均已支持 Fabric，锁最新稳定；
- **上传二进制**：RN fetch 传 Blob/uri——用 `fetch(uri)` 取 blob 或 expo-file-system uploadAsync，对齐现有 `Content-Type: application/octet-stream` 接口；
- **审批时效**：推送不在本期（现状也没有），依赖 App 前台 WS。

## 8. 新会话开工指引

1. 先读本文档 → `PROGRESS.md` 尾部三节 → `docs/ios-ui-redesign.md`（§1/§4/§5/§6 设计规格）→ `docs/api-contract.md` → `web/core/*.js` 与 `web/ui/screens/chat.js`（行为参考实现）。
2. 与用户确认后把 §5 生成 task/09 起的任务卡再动手。
3. 第一步命令参考：`cd ~/Desktop/claude-remote && npx create-expo-app@latest app --template blank` 后按 §1 配 metro/shim；prebuild 后用 Xcode 打开 `app/ios` 装机（签名流程与旧壳相同）。
4. daemon 照常 `pnpm dev`（或菜单栏 App 管理）；RN 开发期直接连 `http://<Mac IP>:8788`。
