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
- xcodebuild 重建成功、装模拟器（iPhone 17 Pro / <SIM_UDID>…）、启动，连接页新芒星 logo 生效；
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
