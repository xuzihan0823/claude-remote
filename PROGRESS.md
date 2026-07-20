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
