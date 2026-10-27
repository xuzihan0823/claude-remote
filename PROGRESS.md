# 进度

> 恢复工作时先读本文件，再按需读 `docs/design.md` 与 `task/INDEX.md`。

## 当前状态（2026-07-18）

- [x] 方案设计完成 → `docs/design.md`
- [x] 关键机制实测完成（见下方"已验证事实"）
- [x] trellis 初始化（--claude --codex 双平台）
- [x] API 契约 v1 → `docs/api-contract.md`
- [x] 任务卡拆分 → `task/01..06`，总览见 `task/INDEX.md`
- [ ] 任务卡分发执行（01 先行，02/04/05 并行，03 随后，06 主窗口收尾）
  - [x] 01 骨架迁移完成（2026-07-18）：`pnpm install/typecheck/test` 全绿，报告见 `reports/01-skeleton-migration.md`；02/04/05 可开工
  - [x] 02 transcript 完成（2026-07-18）：daemon 17 测试全绿，7.88MB readTail(100)=49ms，demo 与真实会话吻合，报告见 `reports/02-transcript.md`；03 可开工（parseTranscriptLine/types.ts 已就绪）
  - [x] 05 Web UI 完成（2026-07-18）：对 mock 全流程自测通过（列表/聊天/翻页/发送/409/审批/断线重连补缺口），零新增依赖，报告见 `reports/05-web.md`（含 5 条契约疑问，06 对表用）
  - [x] 04 run 完成（2026-07-18）：TurnRunner/ApprovalBridge/notifier + 26 测试，daemon 64 测试全绿；ActivityGate 接口与 03 的 ActivityTracker 已对齐（06 一行适配），审批事件 payload 样例见 `reports/04-run.md`
  - [x] 03 watcher 完成（2026-07-18）：SessionWatcher 增量 tail + ActivityTracker 三态机 + 21 测试，真机只读冒烟通过，报告见 `reports/03-watch.md`
  - [x] 06 集成完成（2026-07-18）：config/server/index + 集成测试 8 个，全仓 84 测试全绿；`pnpm dev` 一条命令起完整服务（本机验收用 8788，8787 被占）；报告见 `reports/06-integration.md`。集成期修复两个真 bug：① 05 的 ConnBar 状态订阅空窗（横幅卡"连接中"）；② **04 的 run 永不结束**（SDK 流式输入下 result 后 iterator 不耗尽，已改为以 result 事件为一轮终点）
- [x] M1–M4 真机验收通过（2026-07-18，Chrome 驱动真 daemon，记录见 `reports/06-integration.md`）：M1 列表对照一致；M2 终端聊网页实时滚出+置灰；M3 网页发送→回显→终端 resume 可见（核心闭环）；M4 审批允许/拒绝闭环（Bark 未配置未验）
- [ ] **M5 待验两项**：① 终端写入后 120s 静默回"可接管"（网页观察即可）；② 手机 Safari 经 Tailscale 全流程 + PWA 加主屏（`.env` 的 BRIDGE_HOST 改 Tailscale IP 后重启 daemon）
- [x] **前端 Claude App 风格重构 + iOS 化前置**（2026-07-18 深夜，按用户参考图）：
  - `web/` 重写为浅色 Claude 风格（奶油底/赤陶橙/衬线标题），≥900px 桌面双栏（侧栏+主区），手机保持单页切换；Chrome 真机截图验收通过（手机/桌面/列表/聊天/设置）
  - 设置页：服务器地址 + token 可配置（localStorage `bridge_base`/`bridge_token`，地址留空 = 同源部署不受影响），健康状态展示、快速上手指引、断开清除
  - 附件上传：composer 加 + 按钮 → `POST /api/sessions/:id/upload`（daemon 新端点，存 `~/.claude-remote/uploads/<sessionId>/`，25MB 上限，文件名消毒），路径写进消息文本让 Claude 直接读
  - daemon 加 CORS（`/api/*` 全放开 Origin + OPTIONS 预检免鉴权）——iOS 壳 `capacitor://localhost` 跨域必需
  - 契约已更新（upload 端点 + CORS + `UPLOADS_DIR`）；全仓 typecheck 通过、测试 81 个全绿（daemon 74 + interactions 7，daemon 新增 CORS/upload 用例）
- [x] **阶段二·模拟器验收通过（2026-07-19 凌晨）**：Capacitor 8.4.2 壳已建成并在 iPhone 17 Pro 模拟器（iOS 26.5）真实跑通全链路——连接页填服务器+token → 会话列表（真实会话+活跃状态点）→ 设置页健康状态（daemon v0.1.0 / Claude CLI 2.1.209）。要点：
  - `pnpm add -w -D @capacitor/{core,cli,ios}` → `npx cap init "Claude Remote" cc.anyyu.clauderemote --web-dir web` → `npx cap add ios --packagemanager SPM`（本机无 CocoaPods，SPM 路线可行）→ 前端更新后 `npx cap sync ios`
  - Info.plist 已加 ATS 豁免（NSAllowsArbitraryLoads）+ NSLocalNetworkUsageDescription；AppIcon 用 web/icons/icon-512.png 放大 1024 替换（带 alpha，上架前需去掉）
  - **Xcode 26.5 大坑**：升级后 iOS 平台组件未装 → scheme "supported platforms empty"、模拟器目的地全消失、ibtool 报 "iOS 26.5 Platform Not Installed"；修复 = `xcodebuild -downloadPlatform iOS`（8.52GB）。装完后标准 scheme 构建一次通过
  - 构建：`cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug -destination 'id=<模拟器UDID>' -derivedDataPath /tmp/claude-remote-dd CODE_SIGNING_ALLOWED=NO build`；装载 `xcrun simctl install booted <App.app>` + `xcrun simctl launch booted cc.anyyu.clauderemote`
- [ ] **阶段二·剩余**：装到真机（🐟 的 iPhone）需在 Xcode 登 Apple ID 选签名团队（免费签 7 天 vs TestFlight $99/年，待用户决策）；候选顺滑化：daemon 打印二维码扫码配置（可顺手做 `#setup?base=&token=` URL handler）、launchd 常驻

## 当前运行方式

```bash
cd ~/Desktop/claude-remote && pnpm dev   # 读 .env（token/host/port），缺 BRIDGE_TOKEN 拒启
# 本机验收：http://127.0.0.1:8788（token 见 .env）；claude CLI 2.1.209
```

## 2026-07-19 晚·功能确认 + 图标改版 + iOS 重建

用户提了 5 个诉求，核查后发现 2/3/4 早在 07-19 16:34 的 `web/` 版本已实现，只是**旧 iOS 壳（07-18 23:08 打的 42KB 包）没同步**，手机上看不到。逐条：

1. **手机配置是否跟随本机**：连接配置（地址/token）存手机 localStorage、不跟随 Mac；**模型配置跟随** —— daemon `/api/models` 每次请求实时读 `~/.claude/settings.json`（4 别名 + 默认 model），实测返回用户自定义映射（fable→claude-fable-5[1M]、opus→gpt-5.6-sol[1M]、sonnet→claude-opus-4-7、haiku→glm-5.2[1m]，默认 fable）。不选模型时走"跟随 Mac 默认"。
2. **模型切换** = 已实现：首页 `NewChatComposer` + 聊天页 composer 都有 `ModelPicker`（含"跟随 Mac 默认"选项）。
3. **中断会话** = 已实现：`POST /api/sessions/:id/abort`，聊天页 `isRunning` 时显示"停止"按钮（`app.js:1042`）。
4. **手机新建会话 + Claude 风格首页** = 已实现：`StartScreen`（问候语 + Spark + 项目/模型选择 + 附件 + 最近对话），`POST /api/sessions`。
5. **图标改密集芒星（图3）** = 本次新做：应用内 `Spark` 组件 + `web/icons/icon.svg` + PNG（192/512/apple-touch）+ iOS `AppIcon-512@2x.png` 全部换成 15 芒、角度/长度/线宽微抖动的有机芒星（生成器逻辑：mulberry32 确定性抖动，seed=42）。

本次改动：
- `web/app.js` 的 `Spark` 组件（path → 15 条 line）；
- `web/icons/{icon.svg,icon-192.png,icon-512.png,apple-touch-icon.png}`；
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`（1024 无 alpha，PIL 扁平化）。
- **PNG 光栅化方法**：机器无 rsvg/cairosvg、sips 不吃 SVG → 用无头 Chrome canvas `drawImage(svgBlob)` + `toDataURL` 导出 base64 再落盘（file:// 下 fetch 被拦，SVG 文本需内联进渲染页）。

验证：
- `npx cap sync ios` → iOS 包 42KB→56KB，新功能命中 21 处、icon.svg 已同步；
- **旧 daemon（07-18 22:29 起）早于 `/api/models` 路由，`/api/models` 返回 not_found → 必须重启 daemon**（跑源码 `pnpm dev`，重启即生效）；
- xcodebuild 重建成功、装模拟器（iPhone 17 Pro / <SIM_UDID>）、启动，连接页新芒星 logo 生效；
- Chrome 直连 live daemon 目检：首页问候语 + 新 logo + 模型下拉（跟随默认/fable/opus/sonnet/haiku）+ 项目选择 + 最近对话全对；聊天页模型覆盖选择器（"跟随 Mac 默认"/"仅本轮"）+ 中断按钮条件渲染确认；
- iOS bundle 编译后的 AppIcon 中心像素 = #d97757（赤陶橙芒星中心）。

遗留：真机安装仍需 Apple ID 签名决策（免费签 7 天 vs TestFlight $99/年）。

## 2026-07-19 深夜·模型弹层 + 手机抽屉侧栏 + 会话同步实测

用户四项诉求，纯前端改 `web/app.js` + `web/style.css`（后端零改动），完成后 cap sync + 重建：

1. **模型选择直读 Mac JSON + 显映射名**：`ModelPicker` 从原生 select 换成自定义弹层（图4 风格）。新增 `modelMainName`(取真实 id)/`findModel`/`resolveDefaultName`(把默认别名解析为真实映射名)。每项**主行=真实映射名**（claude-fable-5[1M] / gpt-5.6-sol[1M] / claude-opus-4-7 / glm-5.2[1m]）、**副行=别名**（fable/opus/sonnet/haiku）、选中打✓；首项"跟随 Mac 默认（当前 <默认映射名>）"。桌面浮层、**手机底部弹层**（bottom sheet + 遮罩）。取值语义不变（alias||id 或 ''），后端不改。
2. **Effort 行**：本次**不做**（SDK 顶层 `effort: low|medium|high|xhigh|max` 支持，但要改 runner/sdk-bridge/server 透传+校验，且自定义映射模型未必支持、会被 SDK 静默降级）。留待后续。
3. **手机新建会话双向同步 = 天然可用（已实测）**：手机 `POST /api/sessions` 建的会话直接写 `~/.claude/projects/<enc>/<id>.jsonl`（标准 Claude Code 会话）。实测：建 300a4238… → 3.5s 落盘、结构完整（cwd/user/assistant 齐全）→ Mac 终端 `claude -p --resume 300a4238… "..."` 成功接上、回 RESUME_FROM_MAC_OK、文件 8→14 行追加同一文件。反向（Mac 建→手机列表）本来就能看到。
4. **最近对话进侧栏 + 手机抽屉**：`Sidebar` 手机端改**左滑抽屉**（`transform: translateX(-100%)`→`.open`，遮罩层 `.sidebar-backdrop`），`bus.emit('drawer',…)` 开合、路由变化自动关、点会话即跳转+关抽屉。首页 `home-topbar` 左加 ☰。**首页去掉内联 `home-recent`**：最近对话统一归侧栏（桌面固定列 / 手机抽屉），首页只剩问候语+输入框，更贴近 Claude App。

验证（Chrome 430px 手机视口直连 live daemon，无 console 报错）：模型弹层主/副行 + ✓ 正确；抽屉滑出（新对话/设置/最近对话/连接状态）+ 遮罩变暗正确；首页精简正确。`cap sync ios` → 重建 BUILD SUCCEEDED → 装模拟器启动无崩溃，bundle 含新标识 9 处。**注意：daemon 若是旧进程需重启才有最新代码**（本次沿用 07-19 晚重启的源码 daemon）。

agent team：本次未开——两项改动都落在同一 app.js/style.css，并行必冲突（符合 CLAUDE.md 单文件不并行规则），主模型串行完成。

## 2026-07-20·三项体验修复(橡皮筋 / resume 可见性 / 审批卡顿)+ iOS 重建

agent team 模式:fable 规划,coder-glm 实施(coder-gpt 因模型不可用失败一次,按规则未重试改派 glm),主窗口逐 diff 复核 + 集成验证。三项互不重叠并行。

1. **iOS 橡皮筋滚动根治**:`capacitor.config.ts` 加 `ios: { scrollEnabled: false, contentInset: 'never' }`(原生 WKWebView 层禁整页拖动);`web/style.css` 的 html/body 加 `position:fixed; inset:0; overflow:hidden; overscroll-behavior:none`,`.side-scroll`/`.scroll`/`.blk-body` 加 `overscroll-behavior:contain` 断滚动链。注意:改 config 后必须 `cap sync ios` + 重建。**待真机/模拟器重点回归:键盘弹出时 composer 可视性(现在完全依赖 --vvh 机制)**。
2. **手机会话 Mac /resume 不可见 = CLI 按 entrypoint 过滤**(从 claude.exe 二进制取证):`/resume` 隐藏 entrypoint ∈ {sdk-cli, sdk-ts, sdk-py} 的会话,daemon 走 Agent SDK 落盘的正是 sdk-cli。CLI 对 env 预设的 entrypoint 除 "cli"(SDK 模式下强改回 sdk-cli)和 "local_agent" 外**原样保留**。修复:`sdk-bridge.ts` 的 sdkOptions 加 `env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "claude-remote" }`(SDK options.env 整体替换子进程环境,必须自带 process.env)。历史会话用 `scripts/unhide-sdk-sessions.mjs` 等长字节改写 `"sdk-cli"`→`"cli-sdk"`(7字节等长,watcher 无感;已 --apply,17 文件 109 处,含 15 分钟内活跃文件跳过保护)。E2E 实证:daemon 新建会话落盘 4 处 `entrypoint:"claude-remote"`。
3. **审批点击卡顿**:`web/app.js` ① decide 乐观更新(点击即打戳,HTTP 后台,200 用响应 status 校正,409/404 视为别处已决保持,其它失败回滚+toast);② 移除延迟 1800ms→500ms,scheduleRemoval 用 ref Map 幂等(本地与 WS resolved 双触发不重置计时);③ addMsgs 追加快路径(fresh 排序后整体 ≥ 尾部则 concat,跳过全量 sort)+ 同 tick ws:message 微任务合并;④ Countdown resolved 后停表;⑤ resolved 后按钮禁用防双击。

验证:全仓 typecheck + 97 测试全绿(daemon 80 + agent-bridge 10 + interactions 7);`node --check app.js` 过;cap sync 后壳内三项改动均确认;xcodebuild BUILD SUCCEEDED(iPhone 17 Pro 模拟器);daemon E2E 建会话回复正常。

遗留:真机安装仍需 Apple ID 签名决策;模拟器键盘场景回归由用户手动验收。

## 2026-07-20 深夜·真机两问题诊断 + Tailscale 修复 + 扫码配对方案定稿

用户 Xcode 编译装上真机后报两问题，均已定位（**方案文档：`docs/pairing-plan.md`，明日实施，今晚不动代码**）：

1. **「一直连接中」**：截图实为 SetupGate 连接页，「连接中…」是提交按钮 busy 态。根因 A（环境）= **Mac 端 Tailscale 处于 stopped**，100.64.0.10 黑洞；已 `Tailscale up` 修复，实测 mac/iphone183 在网、ping 手机 88ms、Tailscale IP 与 LAN IP（192.168.1.5）的 /api/health 均 200，**手机原样重试即可连上**。根因 B（代码）= `api()` fetch 无超时，黑洞地址挂 60s+ 无报错。排除：daemon WS loopback 实测正常。
2. **「拉起键盘整页上顶」**：未装 `@capacitor/keyboard`，WKWebView 默认 scroll-to-reveal 把 fixed 布局顶出屏（截图状态栏压输入框+底部黑条）；`scrollEnabled:false` 后用户无法手动滚回，卡死在偏移位。修复 = 装 Keyboard 插件 + `resize:'native'`（Plan B：`resize:'none'` + --kb 变量）。
3. **扫码配对方案已定稿**（用户拍板方向：Mac 端装"同样的 app"显示二维码，手机扫码即连）：QR 载荷 `claude-remote://setup?v=1&token=…&bases=Tailscale,LAN,mDNS`（自包含多候选）；手机注册 URL scheme + `appUrlOpen`；Mac 阶段 A = daemon 终端二维码 + `#/pair` 页 + loopback-only `/api/pair-info`；阶段 B = SwiftUI 菜单栏 App（守护管理+二维码，界面复用 web）。多候选自动切换顺带自愈"Tailscale 停摆"这类故障。明日执行顺序见方案 §4。
4. 运维：Tailscale 建议设为登录自启，防复发；仓库仍零 commit，明日动手前建议先存底。

## 已验证事实（设计的两块基石）

1. **JSONL 实时落盘**：`~/.claude/projects/<编码路径>/<sessionId>.jsonl` 随对话逐行追加，可 tail 实现只读实时镜像。
2. **resume 同文件追加**（Claude Code 2.1.209 实测）：`claude -p --resume <id>` 返回同一 session_id、追加原文件、parentUuid 正确衔接；`--fork-session` 才会新建文件（全量复制历史、sessionId 重写、与原会话无链接）。

## 复用来源

`/Users/mac/Desktop/qq-claude-bridge/`（已审查，测试 88 个全绿）：
- `packages/interactions/` → 审批状态机（manager/store/types/sdk-contract；QQ 专属的 dispatcher/bypass/commands 不复制）
- `packages/mac-worker/src/` → sdk-bridge / permission-adapter / event-adapter / types（裁剪）

## 方法备忘

- 大文件读取走尾部块读 + 懒加载，不全量 parse。
- 消息渲染按 parentUuid 从最后一条回溯出活跃链，链外行默认隐藏。
- 驾驶互斥：idle / terminal-driving / daemon-driving 三态，外部写入判 terminal-driving，静默 120s 回 idle。

## 2026-07-21 配对方案实施（docs/pairing-plan.md §4 代码侧全部完成）

三路并行完成，主窗口已 review + 全量验证：

1. **iOS 壳**：`@capacitor/keyboard` + `@capacitor/app` 已装并被识别；`capacitor.config.ts` 加 `Keyboard.resize:'native'`；`Info.plist` 注册 `claude-remote` scheme（plutil OK）；`npx cap sync ios` 已执行。
2. **daemon**（新增 `src/pair.ts`）：`GET /api/pair-info` 与 `GET /api/pair-qr.svg` loopback-only（127.0.0.1/::1/::ffff:127.0.0.1，否则 403），在 Bearer 校验前显式放行；地址枚举 Tailscale(100.64/10)→en0→hostname.local；启动终端打印候选地址+ASCII 二维码+`#/pair` 提示。
3. **前端 web/app.js**：api() AbortController 超时（health 8s/普通 20s/上传 60s，`network_timeout`）；错误文案区分超时 vs token 错；`bridge_bases` 多候选顺序探测（401 立即终态）；`appUrlOpen` 深链→确认卡（覆盖警告）→探测连接；`#/pair` 页（鉴权前独立渲染）；SetupGate 扫码引导。

**验证**：typecheck 全绿、`node --check` 通过、daemon 实跑冒烟通过（loopback pair-info 200 / LAN 访问 403 loopback_only / 错 token 401 / SVG 正常 / 终端二维码正常）。daemon 已在 8788 用新代码重启。

**待办（需真机/Xcode，用户执行）**：Xcode 重建装机 → §1 键盘验收 → §3.3.4 相机扫码横幅验证（决定主案/B 案）→ §4.6 全链路验收（含关 Tailscale 走局域网自动切换）。改动未 commit。

## 2026-07-21 追加

- 扫码配对真机实测连通（scheme 主案成立，无需 B 案落地页）。
- 修复附件时序 bug：daemon 新增 `POST /api/upload`（Bearer，落盘 uploads/new/），新建会话改为先传附件、路径并入首条消息；删除「本轮结束后补发」排队逻辑。typecheck/冒烟通过，cap sync 已跑，待 Xcode 重建生效。
- Mac 端阶段 B 规划定稿 → **docs/mac-app-plan.md**（产品定位：iOS 收费 + Mac 免费菜单栏助手 DMG 分发、双仓库发布结构、消费级化三件事、实施顺序）。下次做 Mac 端从该文档开始。

## 2026-07-21 晚·Mac 端阶段 B 启动（mac-app-plan §5.1+§5.2+§5.3 完成）

agent team：coder-gpt 完成 SwiftUI 壳；coder-glm 领 CLAUDE_BIN 小改但 API 超时失败，按规则未重试，主模型直接实现；主窗口逐文件复核 + 修一处退出竞态 + 全量验证。

1. **daemon 支持 CLAUDE_BIN**（`packages/agent-bridge/src/sdk-bridge.ts`）：`process.env.CLAUDE_BIN` 非空时向 SDK 注入 `pathToClaudeCodeExecutable`（字段名已对照 sdk.d.ts:1691 确认），未设时行为不变。新增测试 1 例（设/不设两分支，env 清理），`.env.example` 加可选说明。
2. **SwiftUI 菜单栏壳**（全新 `mac/` 目录，Swift Package 可执行，macOS 14+，`swift build` 通过）：MenuBarExtra + 状态灯（轮询 /api/health 校验 `ok:true`，区分运行/停止/端口冲突）；daemon 子进程守护（zsh -lc exec + setpgid 独立进程组，SIGTERM 8s→SIGKILL，崩溃指数退避 1..60s 上限）；二维码窗口（WKWebView 加载 `#/pair`）；浏览器打开入口；BRIDGE_TOKEN 首启生成 32 字节 hex 存 Keychain（service "claude-remote"）注入子进程；claude 按 `~/.local/bin`→`/opt/homebrew/bin`→`/usr/local/bin` 探测、缺失时 NSOpenPanel 手选存 UserDefaults、注入 CLAUDE_BIN；开机自启（SMAppService，失败仅提示）；启动命令/端口 UserDefaults 可配（默认 pnpm dev）。
3. **主窗口修复退出竞态**：原 quit 走异步 stop()，app 可能先退导致 daemon 孤儿；新增同步 `stopSynchronouslyForTermination()`（SIGTERM→3s→SIGKILL），`applicationShouldTerminate` 内 MainActor.assumeIsolated 调用。

验证：全仓 typecheck 绿；agent-bridge 11 测试全过（含新用例）；`swift build` 通过（含修改后复建）。

遗留（下一步）：GUI 实跑验收（swift run 图形会话：菜单/二维码窗/daemon 生命周期）；SMAppService 需打成 .app 才能真正注册；§5.4 Node 运行时打包（SEA/bun 调研 node:sqlite）；§5.5 签名/公证/DMG + releases 仓库 + Sparkle。改动未 commit。

## 2026-07-22 凌晨·Mac 壳实跑调试五连修 + iOS UI 重构规划定稿

Mac 菜单栏 app 实跑暴露并修复：①setpgid 需子进程 exec 前自调（改 perl trampoline `setpgrp+exec`），父进程调用必 EACCES；②默认启动命令改根目录 `pnpm --dir <repo> dev`（--filter daemon 无 dev 脚本）；③StateObject 装载前取 wrappedValue 得孤儿副本,健康轮询跑在假实例上——引导逻辑必须用局部实例；④裸 SPM 可执行 + MenuBarExtra 下 SwiftUI Window/SettingsLink scene 路由全部静默失效——二维码改内嵌面板（.window 样式 + /api/pair-info + CIQRCodeGenerator 本地生成,开面板自刷新）,设置页整个移除;⑤停止/重启支持外部 daemon（lsof 按端口找 pid 发 SIGTERM）;开机自启在非 .app 形态隐藏。健康检查带 Bearer,401 视为「存活的外部实例」并接管不撞端口。实测:面板/二维码/浏览器入口/退出全部正常。

iOS UI 重构规划定稿 → **docs/ios-ui-redesign.md**（参照官方 app 截图;前提:Capacitor 不动+状态/视图分层为 RN 迁移留路;含权限模式选择新功能全链路与 T1-T5 任务卡草案）。下一步:确认后生成 task/ 任务卡,从 T1 状态层抽离开始。

## 2026-07-22 下午·iOS UI 重构 T1–T5 收尾 + 权限模式全链路完成

agent team：explorer-opus47 审计完成度正常；**coder-glm（glm-5.2[1m]）与 coder-gpt（gpt-5.6-sol[1M]）先后因模型 API 不可访问开工即死**（gpt 死前仅留下合规的 core/modes.js，保留），按路由规则主窗口接管实施。

**接手时状态**（上一段会话已完成、未记录）：T1 状态层抽离全部完成（app.js→1 行 shim，core/ 五文件 + ui/ 屏幕组件全拆）；T4 后端透传+白名单+测试完成；T5 全屏套新 token 完成；style.css 已有完整 design tokens 明暗两套。

**本次补齐**：
1. **T4 后端广播**（runner.ts/server.ts）：started 事件携带 permissionMode（显式指定才带，缺席≠default），server 转发进 WS run 帧；新增 runner 测试 1 例。
2. **T4 前端全链路**（modes.js/mode-sheet.js/composer.js/chat.js，即 task/08 卡）：四模式可选、每会话记忆（localStorage `session_mode:<id>`）+ 新会话记忆上次选择（`session_mode`）、POST 新建/继续均带 permissionMode（default 省略，兼容旧 daemon）、bypass 二次确认（红色警示、已 bypass 不重复确认）、聊天页顶部 bypass 常驻徽标、ws:run 跨端同步。
3. **视觉补齐**（style.css/home.js，主窗口自做避免与 coder 撞文件）：composer/sheet 圆角 24px（对齐文档）；消息块 fade-in 150ms + 工具卡展开动画（opacity/translate 近似，WKWebView 安全）；**Home 改官方版式**——问候语垂直居中、composer 底部浮岛停靠（flex 布局，键盘跟随沿用 Keyboard resize native）；bypass 徽标/确认弹窗样式（z-index 80/81 叠 sheet 之上）。
4. **明确不做**：chat 内联 composer 与 NewChatComposer 合并复用（两者逻辑差异大，无构建器下抽象成本>收益，视觉一致性已由共享 CSS 类保证）——文档 §5.2 的偏离，记录在案。

**验证**：typecheck 全绿；101 测试全过（daemon 81 含新用例 + agent-bridge 13 + interactions 7）；node --check 全过；daemon 重启后 E2E 实证非法 permissionMode → 400 invalid_permission_mode；Chrome 430px 深色目检：home 新版式（居中问候+底部浮岛）、模式 sheet 四选项、bypass 确认弹窗全部正常；cap sync ios 后 bundle 已含新代码（permissionMode×2 文件、confirm-card/home-dock 样式命中）。

**daemon 运行方式变更**：旧 pnpm dev 进程已被替换，现为 nohup 后台进程（日志 `/tmp/claude-remote-daemon.log`），端口 8788。如需自己终端管理：`lsof -ti :8788 | xargs kill` 后重新 `pnpm dev`。

**待办（用户执行）**：Xcode 重建装机（web 改动已 cap sync，无原生变更，直接 build）→ 真机验收：① home 新版式与键盘跟随 ② 四模式选择/记忆 ③ bypass 确认+徽标 ④ 浅色模式无破相 ⑤ 现有功能回归（扫码/附件/审批/模型/中断）。

## 2026-07-22 晚·菜单栏 App 启动 + pair 候选地址修复

1. **菜单栏 App 已启动**（`mac/.build/debug/ClaudeRemoteMac`，nohup 后台，日志 /tmp/claude-remote-menubar.log）：正确识别外部 daemon 不撞端口，二维码面板每次打开现拉 pair-info。
2. **发现 Tailscale 又停了**（复发，`Tailscale up` 已拉起；手机端 iphone183 10h 前离线，打开手机 Tailscale 即回）。**强烈建议把 Mac 端 Tailscale 设为登录自启**。
3. **修复 pair 候选地址启动时缓存 bug**（server.ts）：原 `#pairInfo` 在构造/listen 时算一次就缓存——daemon 比 Tailscale 先起就永远缺 Tailscale 地址（本次实测踩中）。改为 `get pairInfo()` 每次现查（`#pairPort` 只记端口），/api/pair-info、/api/pair-qr.svg、终端二维码全部受益。typecheck + 81 测试全绿。
4. daemon 已再次重启生效，pair-info 实测返回三候选：Tailscale 100.64.0.10 / LAN 192.168.1.3（注意 LAN IP 从 .5 漂到 .3，旧扫码存的地址已过期，**建议重扫一次二维码**）/ mac.local。

## 2026-07-23 上午·菜单栏图标不显示根治

现象：App 进程活着但菜单栏无图标。根因（AX 取证）：**裸 SPM 可执行以 nohup/后台方式启动时 activation policy 落在 .regular**——注册了一套 0 尺寸的常规 App 菜单（Apple/Edit/View/Window/Help），MenuBarExtra 状态项不渲染；此前 swift run 前台启动碰巧正常，属于启动方式依赖的隐性 bug。

修复（ClaudeRemoteMacApp.swift）：① bootstrap 里显式 `NSApp.setActivationPolicy(.accessory)`（菜单栏助手形态，任何启动方式都稳定渲染状态项）；② 图标从无辨识度的 `circle.fill` 白点换成品牌一致的 `sparkle`（✳）；conflict=exclamationmark.triangle.fill、停止=circle.dotted 不变。AX 验证状态项注册（981,4 / 34×24），全屏截图确认 ✳ 可见于状态图标区最左。

运行状态：菜单栏 App nohup 后台（日志 /tmp/claude-remote-menubar.log）；daemon 8788 健康；Tailscale up。另观察到用户 VS Code 里 MSD 项目对 panel.example.com 的 gpt-5.6-terra 连续 504——与昨日 coder-glm/coder-gpt subagent 模型不可访问同源，网关上游过载嫌疑。

## 2026-07-23·键盘跟手 Plan B 落地（resize:none + --kb 提前驱动）

用户反馈壳内键盘适配不跟手。根因：`Keyboard resize:'native'` 是系统键盘动画**结束后** WKWebView 才一步缩高 → --vvh 再变 → composer 慢一拍且有跳变。落地 2026-07-20 预留的 Plan B：

1. `capacitor.config.ts`：Keyboard resize `native`→`none`（webview 恒定全高，键盘只是覆盖层）。
2. `ui/hooks.js` useVVH 改造：壳内（检测到 Keyboard 插件）走 `keyboardWillShow/Hide`——willShow 在系统动画开始**前**携带键盘高度，立即写 `--kb` + `kb-open`/`kb-native` 类 + bus `kb-change`；浏览器分支维持 visualViewport 跟踪（--vvh），互不干扰。
3. `style.css`：`#app{height:calc(var(--vvh) - var(--kb))}` + kb-native 下 250ms `var(--spring)` 高度过渡（与 iOS 键盘 ~0.25s 同步）；fixed-bottom 层全部骑上键盘：`.sheet-panel`/`.approval-layer` bottom:var(--kb)（带过渡）、`.toasts` bottom 加 --kb、`.confirm-card` 居中点上移 --kb/2；`kb-open` 时 composer/home-dock/approval 的 safe-area 底垫收为固定 10/12px（键盘已盖住 home indicator 区）。
4. `chat.js`：kb-change 后 350ms rAF 逐帧贴底（覆盖高度过渡全程），visualViewport 分支保留给浏览器。

验证：node --check/typecheck 全绿；cap sync 后 ios capacitor.config.json 确认 `"resize":"none"`；Chrome 回归（--kb=0 路径）#app 高度=视口、无 console 错误、kb-native 未误触发。**待真机**：输入框聚焦上浮同步性、收键盘回落、键盘开着时打开模式 sheet/审批卡（应浮在键盘上方）、home 屏输入。

架构结论（对用户"要不要换架构"的回答）：本次是 webview 键盘适配的正解姿势（提前信号+自绘过渡），先真机验收；仍不满意再启动 RN 迁移——core/ 状态层已按可整体搬迁设计，daemon API 零改动，重写仅视图层。

## 2026-07-23·架构决策变更：启动 RN 迁移

用户真机验证 Plan B 键盘方案后仍不满意，拍板放弃 Capacitor 壳、迁移 React Native。**规划定稿 → `docs/rn-migration-plan.md`**（取代 ios-ui-redesign §0 的「架构不动」；视觉/权限模式规格继续有效）。要点：Expo prebuild + react-native-keyboard-controller（逐帧键盘同步=迁移主因）；`web/core/` 状态层经审计仅需 location guard + MMKV localStorage shim 即可整体复用；daemon/API/web/Mac 壳全不动；P0 脚手架→P1 只读流→P2 交互→P3 键盘收尾，任务卡待新会话确认后从 09 起生成。旧 Capacitor ios/ 目录保留至 RN 真机验收通过。**下一步：新会话按该文档 §8 开工。**

## 2026-07-23·RN 迁移 P0–P2 代码落地 + 模拟器启动通过（agent team）

按 `docs/rn-migration-plan.md` 执行，任务卡 `task/09–15`。agent team：主窗口做脚手架/集成/最微妙的 Chat 只读流；coder-glm 三波并行认领无文件重叠的组件（P1-A Markdown/Spark、P1-B 连接/设置、P1-C 抽屉；P2-E Composer、P2-F 审批/Toast）。coder-glm 本轮全程可用（与昨日不同），5 张卡全部交付。

**已完成**：
- `app/` Expo SDK 57 / RN 0.86 / React 19.2.3 工程（独立 npm，不进 pnpm workspace）；prebuild 出 ios/ 原生工程。
- metro watchFolders 指向 `../web`，直接 import `web/core/*` 与 `web/vendor/marked`；`resolveRequest` 把 vendor preact 重定向到 `src/shims/preact-htm.js`（bus.js 的 useBus 需要 useEffect，RN 由 react 提供）。
- **core 复用仅两处小改**：`web/core/api.js` connHost/wsEndpoint 加 `typeof location` guard（web 回归无碍）；MMKV localStorage shim（`app/src/lib/storage.js`，index.js 第一行 import）。
- 全屏：ConnectScreen/HomeScreen/ChatScreen/SettingsScreen + Drawer；Composer（Chat/New 两版）、模型/模式 bottom-sheet、bypass 确认、审批浮层、Toast、MarkdownView、Spark 全部落地，行为逐行对照 web。
- 导航：Drawer(自定义内容)+native-stack；AppState 回前台 reconnectNow；expo-linking 接 `claude-remote://` 深链→PairConfirm。theme.js 移植 style.css 明暗两套 token。

**验证**：全量 production bundle 编译通过（整模块图无 import/语法错）；iOS 模拟器 xcodebuild BUILD SUCCEEDED；app 启动到连接页正常渲染（芒星+衬线标题+表单）。**修掉一个运行时崩溃**：mmkv v4 废弃 `new MMKV()`，改用 `createMMKV()` 工厂 + `remove()`（原 `delete()` 也已改名）。

**坑记**：① CocoaPods 机器没装，`brew install cocoapods` 走 ghcr bottle 镜像 SSL 失败 → `env -u HOMEBREW_BOTTLE_DOMAIN` 绕过装成 1.17.0；② `pod install` 拉 cdn.cocoapods.org 同样 SSL EOF → 走系统代理 `https_proxy=http://127.0.0.1:1082 pod install` 成功；③ bundleId 用 `cc.anyyu.clauderemote.rn`（.rn 后缀与旧 Capacitor 壳区分，可并存对比）。

**当前运行态**：metro 在 8081（nohup，日志 /tmp/rn-metro.log）；daemon 8788；app 装在 iPhone 17 Pro 模拟器（<SIM_UDID>）。RN 全部改动**未 commit**（基线 82773cd）。

**剩余（P3，未做）**：keyboard-controller 交互式拖拽收起的真机跟手验收（=迁移主因，硬门槛见迁移计划 §6）、暗色真机回归、图标/启动屏换芒星、TestFlight/签名；以及用户模拟器点测后反馈的观感微调。

## 2026-07-30·P3 启动：真机装机前置打通 + 键盘安全区缺陷修复

**环境复原**（三项全停）：Tailscale 又停了（第三次复发，`Tailscale up` 已拉起，**仍强烈建议设为登录自启**）；daemon 重启于 8788（`pnpm dev`，日志 /tmp/claude-remote-daemon.log，health 带 Bearer 返回 ok:true，claudeCliVersion 2.1.209）；metro 重启于 8081（日志 /tmp/rn-metro.log）。**LAN IP 又漂了：192.168.1.3 → 192.168.1.8**，旧二维码再次失效；pair-info 现返回 Tailscale 100.64.0.10 / LAN 192.168.1.8 / mac.local 三候选。

**发现 7-24 存在未记录的改动**：图标/启动屏换芒星**已完成**（assets/icon.png 深底赤陶芒星 + splash-icon.png，ios/ 已 prebuild 出对应 Images.xcassets）——即 P3 第③项已做完，此前 PROGRESS 漏记。

**修复 composer 底部安全区被清零的缺陷**（ChatComposer.js / NewChatComposer.js）：

- 根因（读 keyboard-controller 1.21.9 源码取证）：`KeyboardAvoidingView` 的 `combinedStyles = [style, animatedStyle]`，animatedStyle 排在后面，`behavior="padding"` 时返回 `{paddingBottom: bottom}` 会**整体覆盖**使用者写在 `style` 上的 `paddingBottom`。键盘收起时 `progress=0 → bottom=0`，于是 `Math.max(insets.bottom, 8)` 被清零，输入框直接贴住 home indicator。
- 修法：安全区间距移到 KAV 的**子层 View**；KAV 加 `keyboardVerticalOffset={-padBottom}`。依据源码 `relativeKeyboardHeight = kbHeight + keyboardVerticalOffset`，键盘打开时 KAV padding = kbHeight − padBottom，叠加子层 padBottom 后总间距恰为 kbHeight（输入框贴键盘顶）；收起时 KAV padding = 0，子层 padBottom 保留安全区。
- ModeSheet 是 `BottomSheetModal`（portal 渲染），不受父级 padding 影响，故留在包裹 View 之外。

**打通真机装机前置**（此前无法构建）：
1. **`ios/` 缺 Pods**：7-24 那次为换图标重新 prebuild，重建了 ios/ 但**没跑 pod install**——没有 `Pods/`、`.xcworkspace`、`Podfile.lock`，工程根本不可构建。已用 `https_proxy=http://127.0.0.1:1082 pod install` 补上（cdn.cocoapods.org 仍需走代理，同 7-23 坑记）。
2. **签名 team 首次配置**：keychain 仅一个身份 `Apple Development: xuzihan923@icloud.com (5PX32Z7M2V)`，从证书 OU 提取 **Team ID = Z25WB9W2X5**（证书有效期至 2027-07-19）。已写进 `ios/ClaudeRemote.xcodeproj/project.pbxproj` 的 Debug/Release 两段 buildSettings（`DEVELOPMENT_TEAM` + `CODE_SIGN_STYLE = Automatic`，plutil -lint 通过，xcodebuild -showBuildSettings 实测生效）。**注意：`expo prebuild --clean` 会重新生成 pbxproj 并丢失这两行，届时需重配**（长期方案是做成 config plugin）。
3. 设备已配对：iPhone 17（`<COREDEVICE_ID>`，available）。

**验证**：两个 composer babel 解析通过；metro 全量 bundle 编译通过（10.0 MB，HTTP 200，整模块图无错）；pod install exit 0；签名设置 xcodebuild 实读确认。

**待用户执行（真机）**：Xcode 打开 `app/ios/ClaudeRemote.xcworkspace` 装机 → 按迁移计划 §6 五条验收键盘 + 本次修复点（收起键盘后输入框与 home indicator 的间距）+ 暗色回归。**未决**：免费签名 7 天过期 vs $99/年（装完看描述文件有效期即可确认账号类型）。本轮改动未 commit（基线仍 82773cd）。

## 2026-07-31·安全修复：配对端点隧道穿透漏洞 + Cloudflare Tunnel 方案验证

**背景**：讨论「Mac 与手机建立连接的更优方案」。查明现有机制三处硬伤：① **运行中不自愈**——`app/src/App.js:119-124` 回前台只 `ws.reconnectNow()`，不重新 `probeBases`，IP 漂移后只能杀 App 重开（当日实际踩中，手机报 network_timeout）；② **串行探测慢**——`web/core/api.js:91-100` for 循环逐个 await，health 超时 8s，三候选最坏 24s；③ **WS 无逃逸路径且缺半开检测**——`web/core/ws.js` 退避上限 30s 但 `attempt` 无限递增，永远重试失效地址；客户端无心跳超时检测，移动网络切换造成的 TCP 假活不触发 `onclose`，UI 显示已连接实则收不到消息。①②③ 均未修，属后续待办。

**发现并修复一个灾难级漏洞（P0）**：

- 根因：`packages/daemon/src/server.ts:284` 的配对端点用 `req.socket.remoteAddress` 判 loopback，且该检查在 Bearer 校验**之前**。设计前提是「loopback = 物理在本机的人」，在仅暴露局域网/Tailscale 时成立。**但 cloudflared / ngrok / nginx 等代理跑在本机时源地址同样是 127.0.0.1，前提被打破**——隧道一开，公网任何人 `curl $URL/api/pair-info` 即可无鉴权读走 BRIDGE_TOKEN，进而读全部会话、发消息执行命令（且存在 bypassPermissions 模式）。等于把开发机 shell 挂公网。
- 修法：新增 `looksProxied(headers)`（`pair.ts`），检测 `x-forwarded-for` / `x-forwarded-host` / `x-forwarded-proto` / `x-real-ip` / `forwarded` / `cf-connecting-ip` / `cf-ray` / `cf-ipcountry` / `cf-visitor` / `ngrok-trace-id`，出现任一即 403（fail-closed）。直连场景伪造这些头只会自拒，不构成提权，故宁可误杀。`server.ts` 与 loopback 判断做或运算。
- 测试：`server.test.ts` 新增用例锁定行为（本机直连 200 且返回 token；五种代理头分别 403；pair-qr.svg 同样受保护）。**daemon 测试 81 → 82 全绿，typecheck 通过。**
- **长期更稳的方案**（未做）：配对端点挪到独立的、仅绑 127.0.0.1 的端口，隧道只转发主端口——结构上不可能穿透，不依赖头部黑名单。

**Cloudflare Tunnel 方案实证（PoC 全通，隧道用完已关闭）**：

- `brew install cloudflared`（需 `env -u HOMEBREW_BOTTLE_DOMAIN` 绕 ghcr 镜像 SSL 失败，同 7-23 坑记）；`cloudflared tunnel --url http://127.0.0.1:8788` 拿到 `https://<随机>.trycloudflare.com`，边缘节点 sin11。
- 实测结果：经隧道 `/api/pair-info` → **403**（修复生效）；无 token → 401；带 token → 200；`/api/sessions` 真实业务接口正常返回；**WSS 握手成功、22s 收到服务端心跳 ping、连接保持 45s 未断**（CF 对 WS 长连接无碍）。
- 结论：**方案技术可行，daemon/API/WS 零改动即可跑通**。
- 待评估的代价：① **TLS 在 Cloudflare 终止，会话明文对 CF 可见**——产品是「远程操作开发机」，此账迟早需端到端加密；② `trycloudflare` 免费临时域名重启即变（本架构靠扫码下发地址，反而不惧）；③ **免费临时隧道用于商业分发的服务条款与稳定性尚未核实**，押注前必须查清。

**选型结论（讨论所得）**：面向最终用户，Cloudflare 显著优于 Tailscale——`cloudflared` 跑在 Mac 侧，可被菜单栏 App 内置并自动管理，用户全程零配置且无需知道 CF 存在；Tailscale 要求双端安装、注册、登录同一账号，这部分复杂度无法替用户吸收。用户自己日常使用仍用 Tailscale（已装好，按需开关）。

## 2026-10-21·cr 命令行取代菜单栏 App（分支 feat/cli-tui）

- 新增 `packages/cli`（命令 `cr`）：不带参数进 Ink 全屏控制台（会话列表 + 搜索 + 预览、会话实时视图与回复、审批、配对二维码、日志、启停）；子命令 `setup/up/down/restart/uninstall/status/logs/pair/web/ls/search/show/open`。用法见 `docs/cli.md`。
- launchd 控制逻辑从 `scripts/launchd/install.sh` 移到 `packages/cli/src/launchd.ts`（Label 不变，旧安装可接管）；`down` 额外 `launchctl disable`，跨登录保持停止。`install.sh` 删除，`run-daemon.sh` 保留为 launchd 入口。
- `cr setup` 把旧菜单栏 App 存在 Keychain 的 token 迁移进 `.env`，已配对手机不受影响。
- daemon 新增 `GET /api/sessions/search`（默认标题/路径/预览，`full=1` 流式全文、256MB 预算）与 `GET /api/interactions/pending`（后连客户端补齐待审批）。
- 删除 `mac/` Swift 菜单栏 App。
- 测试：daemon server 19/19，cli 18/18（含 ink-testing-library 的 TUI 交互测试）；在 Linux 伪终端里实跑过 TUI。**未在 macOS 实测 launchctl 与 `claude --resume` 接管**。

## 2026-10-21·进程守护修复（分支 fix/daemon-supervision）

针对「nohup 起的 daemon 会随会话消失」（7-31 坑 3）：
- 新增 `scripts/launchd/`：`install.sh install | uninstall | restart | status | logs` 生成 `com.claude-remote.daemon` LaunchAgent（RunAtLoad + KeepAlive + ThrottleInterval 10s + ExitTimeOut 15s），日志 `~/Library/Logs/claude-remote/`；`run-daemon.sh` 补 PATH、按 env → .env → Keychain 取 token、直接 exec tsx（SIGTERM 直达 daemon 优雅退出）。
- 菜单栏 App：检测到 LaunchAgent 时按钮改走 launchctl（停止用 bootout，否则 KeepAlive 立即拉起），不再自拉子进程抢端口。
- 修 App 自身守护的退避 bug：原先每次 `run()` 成功就把 `restartAttempt` 清零，启动即崩会永远 1 秒重启一次；改为稳定运行 ≥30s 才清零。
- 未在真机验证（编写环境无 macOS/swift）：需本机 `swift build` + `install.sh install` 实测。
- 按用户决定，不再用 launchd 托管 cloudflared 隧道（已从脚本移除）。
- 按用户决定去掉 Cloudflare 接入方式：删除 `BRIDGE_PUBLIC_BASES` / `config.publicBases`，配对候选只剩自动枚举的 Tailscale / 局域网 / mDNS 地址；pair-info 对代理特征头（含 cf-*）一律 403 的防护保留。

## 2026-07-31 晚·Named Tunnel 落地（claude.example.com 固定地址已通）+ Home 顶栏精简

**Named Tunnel 搭建完成，全链路实测通过**。这是本项目第一个**固定的、免疫 IP 漂移与 Tailscale 开关状态**的接入地址。

- **域名**：`example.com`（阿里云购买，用户自行把 NS 从 `dns1/2.hichina.com` 改到 Cloudflare `<ns1>/<ns2>.ns.cloudflare.com`，dig +trace 从根域确认生效，域名全新无历史解析记录，零迁移风险）。
- **隧道**：`cloudflared tunnel create claude-remote` → tunnel id `<TUNNEL_ID>`；`route dns` 绑 `claude.example.com`；配置 `~/.cloudflared/config.yml`（ingress → `http://127.0.0.1:8788`，含安全前提注释）。
- **实测**（经 `https://claude.example.com`）：带 token /api/health → 200；无 token → 401；**/api/pair-info → 403（漏洞防护回归通过）**；/api/sessions 真实业务接口正常；**WSS 握手 0.5s、22.6s 收到心跳 ping**（比 quick tunnel 的 1.2s 更快，边缘节点 sin07/08/15/21）。

**三个坑（下次搭建必看）**：
1. **管理命令必须走代理，运行时不用**：`cloudflared tunnel login` 直连会轮询 8 分钟后报 `Failed to write the certificate / Failed to fetch resource`（拉 cert 走 login.cloudflareaccess.org 被墙）。加 `https_proxy=http://127.0.0.1:1082` 后 6 秒内成功。`create` / `route dns` 同样需要。但 `tunnel run` 是到 CF 边缘的出站 QUIC，实测**无需代理**。
2. **本机 DNS 被代理软件劫持成 fake-ip**：`dig claude.example.com` 返回 `198.18.0.95`（保留段），本机自测走的是代理转发而非真实解析。不影响手机外网访问，但排障时别被这个 IP 误导。
3. **nohup 起的 cloudflared / daemon 会随会话消失**：本轮两者都死过一次（先报 1033 无活跃隧道，重启隧道后又报 502 源站不可达，才发现 daemon 也没了）。长期应交由菜单栏 App 托管（同 daemon 的守护逻辑）。

**其它**：
- 删除 HomeScreen 右上角圆形按钮（连接状态灯 + 设置入口）。先确认 `DrawerContent.js:118` 有独立「设置」入口才动手，不会锁死设置页；连带清掉只为它服务的死代码 `dotColor` / `wsPhase` state / `useBus('ws-state')` 订阅，babel 解析通过。**副作用：Home 页失去连接状态可视指示**，仅剩底部「加载失败」文案，需要的话可把状态点移至他处。
- 本机 Claude CLI 已升级 **2.1.209 → 2.1.220**（daemon health 探测所得）。
- 服务器 `203.0.113.10`（<KEY>.pem，root）经查**没有本项目部署**：`/root/projects/` 空，`/root/.claude/` 只是该机自身的 Claude Code 配置目录。本项目目前纯本地。

**当前运行态**：daemon 8788（nohup，日志 /tmp/claude-remote-daemon.log）；cloudflared named tunnel（nohup，日志 /tmp/cf-named-tunnel.log）；菜单栏 App 运行中；metro 8081；Tailscale 用户按需开关（本轮曾自行关闭）。**手机端接入地址现推荐 `https://claude.example.com`**，token 不变。

**下一步待办**（优先级排序）：
1. **三个连接硬伤**（与隧道方案无关，上了隧道照样咬人）：① 运行中不自愈（回前台不重探地址）② 串行探测最坏 24s ③ WS 无逃逸路径 + 缺半开连接检测。
2. Cloudflare 免费版商业分发的**服务条款与稳定性核实**（决定 C 值不值得投入）。
3. 把 cloudflared 集成进菜单栏 App，做成完整配对流程（地址变更自动刷二维码）。
4. **P3 键盘真机验收仍未做**（RN 迁移的存在理由，硬门槛见 rn-migration-plan §6）。
5. 端到端加密（明文对 CF 可见，产品化前必须解决）。

## 2026-09-03·RN 真机 Distribution 签名安装完成

**目标设备**：iPhone 17（UDID `<DEVICE_UDID>`，CoreDevice id `<COREDEVICE_ID>`），iOS 27.0 Beta，Developer Mode 已开启、有线配对。首次安装因手机锁屏报 `kAMDMobileImageMounterDeviceLocked`；解锁后 DDI 服务正常启用，无需更换 Xcode 26.5。

**Metro Release 构建修复**（`app/metro.config.js`）：Expo 57 / Metro 0.84 在 `projectRoot=app/`、`watchFolders=web/` 时无法为 `web/core/*.js` 建立文件哈希，生产打包先报模块不存在，直接 resolver 后进一步明确为 `Failed to get the SHA-1`。最小稳定修法是把 Metro `projectRoot`/`watchFolders` 提升到仓库根，同时显式设置依赖查找顺序为 `app/node_modules`、根 `node_modules`；自定义 resolver 按 Expo 官方方式回退到 `context.resolveRequest(...)`。冷缓存 `export:embed` 通过：1657 modules，bundle 6,272,535 bytes，18 assets。

**签名材料与本机状态**：
- 使用描述文件 UUID `<PROFILE_UUID>`，仅包含上述 UDID；允许的 Bundle ID 为 `<BUNDLE_ID>`，到期时间 2027-08-30（CST）。
- 对应证书为 `iPhone Distribution: <NAME> (<TEAM_ID>)`，SHA-1 `<CERT_SHA1>`；Root → Apple WWDR G3 → leaf 密码学链验证通过。
- 原 `.p12` 是旧式 PKCS#12 容器，先在临时目录解密并转换为 Apple 兼容容器；经用户明确授权后导入登录钥匙串，仅授权 `/usr/bin/codesign` 与 `/usr/bin/security`，未使用允许所有应用访问的 ACL。中间私钥文件与临时钥匙串均已清除。
- 描述文件安装于 Xcode UserData Provisioning Profiles；项目源码中的默认 Team/Bundle ID 未改，Release 构建通过命令行临时覆盖为 Team `<TEAM_ID>` 与 `<BUNDLE_ID>`。

**验证结果**：
- `xcodebuild` Release/iphoneos：`BUILD SUCCEEDED`。
- `codesign --verify --deep --strict`：通过；签名 Application Identifier 为 `<TEAM_ID>.<BUNDLE_ID>`，嵌入描述文件 UUID 匹配。
- `devicectl device install app`：成功，设备安装路径返回正常。
- `devicectl device process launch`：成功；3 秒后进程列表仍有 `ClaudeRemote`（PID 67571），未立即崩溃。

**待人工真机验收**：按 `docs/rn-migration-plan.md` §6 检查键盘逐帧跟手、交互式收起、sheet/审批卡位置、表情面板高度切换和暗色模式。当前源码未提交：`app/metro.config.js` 与本进度记录。



## 2026-10-27·自建 relay（分支 feat/self-hosted-relay，任务 10-26-self-hosted-relay）

- M1 手机端多通道：`probeBases` 并行探测（直连优先，relay 宽限 1.5s，401 短路）；WS 应用层 ping/pong 识别半开连接，连续失败或半开时 `ws-reselect` 重新选路；`GET /api/connect-info` 让已配对手机自动拿到新通道（`syncBases`）。
- M2 `packages/relay`：无状态 relay（设备 ID 由设备私钥派生），HTTP/WS 经 agent 长连接多路复用，256KiB 流量窗口；esbuild 打成单文件镜像。
- M3 daemon connector + `cr relay add/status/on/off/remove`；配对端点经 relay 一律 403（WHATWG 路径规范化 + X-Forwarded-* 双层）。
- M4 `deploy/relay/`：一行安装脚本（重跑即升级、保留密钥）、compose（relay + Caddy 自动 HTTPS / 自带证书）、GHCR 多架构镜像工作流（`relay-v*` 标签触发）。DinD 实测安装与升级、本机 buildx amd64/arm64 构建通过。
- M5 App 设备页：显示当前通道、通道偏好（自动/仅直连/仅 relay）、地址按通道标注。
- 规格：`.trellis/spec/backend/relay-tunnel.md`、`.trellis/spec/frontend/connection-channels.md`。
- 待办：镜像推 GHCR 并设为公开；真实服务器部署验证；真机测"直连断开 10 秒内切到 relay"。
- 教训：本仓库多个 worktree 共用 stash 列表，临时保存文件别用 `git stash`。
