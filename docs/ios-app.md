# iOS App 打包方案（阶段二）

> 最终目标：把 `web/` 打包成 iOS App，他人安装后只需在设置页填「自己 Mac 的地址 + token」即可连上自己的 Mac。
> 前置条件已在阶段一完成：前端服务器地址可配置（`bridge_base`）、daemon 已加 CORS、附件上传走同一 API。

## 架构

```
iPhone App（Capacitor 壳，内嵌 web/ 静态文件）
   │  HTTP/WS（Bearer token）
   ▼
用户自己 Mac 上的 daemon（pnpm dev / launchd 常驻）
   │  只读 tail + claude --resume
   ▼
~/.claude/projects/**/*.jsonl
```

网络路径推荐 Tailscale（免公网、免证书、点对点加密）；同一 Wi-Fi 下局域网 IP 也可。

## 打包步骤（Capacitor）

```bash
# 1. 初始化（项目根执行一次）
pnpm add -D @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "Claude Remote" cc.anyyu.clauderemote --web-dir web
npx cap add ios

# 2. 每次前端更新后同步
npx cap sync ios

# 3. 打开 Xcode 构建
npx cap open ios
```

`capacitor.config.ts` 要点：

```ts
const config: CapacitorConfig = {
  appId: 'cc.anyyu.clauderemote',
  appName: 'Claude Remote',
  webDir: 'web',
  server: { iosScheme: 'capacitor' },
};
```

## iOS 侧必要配置

1. **ATS 豁免**（连 `http://100.x.x.x` 明文地址必需），`Info.plist`：
   `NSAppTransportSecurity → NSAllowsArbitraryLoads = YES`
   （或只加 `NSAllowsLocalNetworking`；Tailscale IP 属私网，两者取一即可）
2. **本地网络权限描述**：`NSLocalNetworkUsageDescription`（连局域网 Mac 时 iOS 会弹授权）。
3. 前端已就绪，无需改动：baseUrl 为空才回退同源，壳内首次启动会直接进连接设置页。

## 分发方式（需用户决策）

| 方式 | 成本 | 他人安装体验 |
|---|---|---|
| TestFlight（推荐） | Apple Developer $99/年 | 装 TestFlight 点链接即装，最多 1 万人 |
| 免费签名侧载 | 免费 Apple ID | 需连 Mac 用 Xcode 装，7 天过期重签 |
| App Store 上架 | $99/年 + 审核 | 最顺，但"远程控制自有电脑"类审核有沟通成本 |

## 他人快速上手流程（目标体验）

1. Mac：克隆本仓库 → `.env` 设 `BRIDGE_TOKEN`、`BRIDGE_HOST=0.0.0.0`（或 Tailscale IP）→ `pnpm dev`
2. Mac + iPhone 装 Tailscale，登录同一账号
3. iPhone 打开 App → 设置页填 `http://<Mac 的 Tailscale IP>:8787` + token → 保存

后续可做的顺滑化（候选）：daemon 启动时在终端打印含地址+token 的二维码，App 内扫码即完成配置；`launchd` plist 让 daemon 开机常驻；`npx claude-remote` 一条命令启动。

## 风险备忘

- iOS 后台 WebSocket 会被挂起：切后台靠 Bark/ntfy 推送补位（daemon 已支持），回前台 ws 自动重连补缺口（前端已实现）。
- 若未来走 HTTPS（Tailscale cert / 反代），前端 `wsEndpoint()` 已按协议自动切 wss。

## 审批不漏 / 推送直达（2026-10）

- **补拉**：ApprovalLayer 挂载时、以及每次 WS 连上（包括回前台的重连）都会 `GET /api/interactions/pending` 与服务端对账：补上手机在后台或断线期间产生的审批，去掉已在别处处理或已超时的。
- **推送深链**：daemon 推送（Bark / ntfy）带上点击链接：
  - 待审批 / 提问：`claude-remote://approval/<interactionId>?session=<sessionId>`，Bark 用 `level=timeSensitive`（可穿透专注模式），ntfy 用 `Priority: high`
  - 运行完成 / 出错：`claude-remote://session/<sessionId>`
  点通知打开 App → 进入对应会话，并把这条审批顶到最前；已处理则提示「这条审批已处理或已超时」。
- **触感反馈**（expo-haptics）：新审批到达、允许 / 拒绝、发送成功、停止运行、失败。expo-haptics 是原生模块，**需要重新编译 dev client**（`npx expo run:ios` 或重新打包）；旧 client 上自动降级为无震动，不会崩。

## 工具调用可读化（2026-10）

`app/src/lib/tool-view.js`（纯函数，有测试）把工具参数转成展示结构，`components/ToolInputView.js` 负责渲染，消息流与审批卡片共用：

- Edit / MultiEdit / NotebookEdit：行级 diff（红 `-` 删、绿 `+` 增），改动前后各留 2 行，其余折叠成「⋯ N 行未改动」；标题行显示 `目录/文件 +N −M`
- Write：整个文件按新增显示（最多 400 行）
- Bash：说明 + `$ 命令`；TodoWrite：勾选清单；Read/Grep/Glob/WebFetch 等：关键字段表
- 审批卡片里直接展开（最高 260pt，内部滚动）；右下「原始参数」可切回 JSON

## 开屏动画（2026-10）

- 原生启动屏改为纯底色（`assets/splash-blank.png` 透明图，浅色 `#FAF9F6`、深色 `#141414`，与 App 背景一致），保持到连接校验结束（最多 2.5s）后淡出。改了 app.json 的 splash 配置，需要重新编译 dev client 才生效。
- 首页芒星（`BloomSpark`）原位绽放：15 条光芒顺时针依次长出并回弹，整体放大到 1.35 倍再回落、轻转，约 1s，停下后就是首页的静态图标。
- 问候语 600ms、副标题 700ms、顶部按钮 800ms、底部输入框 850ms 依次渐入（`components/FadeIn.js`）。
- 每次冷启动只播一次（`lib/intro.js`）；系统开启「减弱动态效果」时不播。

## 登录页与连接衔接（2026-10）

- 芒星按参考图改为 12 条锥形光芒 + 实心中心（`components/Spark.js` 的 `RAYS` + `rayPath`，填充 path，端部平头小圆角）。web 端和 App 图标仍是旧版 15 条。
- 登录页：芒星绽放 + 标题；主按钮「扫码连接」打开 App 内相机（`components/QrScanner.js`，expo-camera，读 `cr` 配对页二维码里的 `claude-remote://setup` 链接）；次按钮「输入地址和令牌」展开表单。
- 连接中：芒星不转，各光束像星星闪烁一样轻微伸缩，显示「正在连接 <host>…」。失败：芒星左右抖一下 + 错误文案 + 触感。
- 成功：变绿「✓ 已连接」+ 触感 → 标题淡出 → 登录页把芒星的窗口位置交给首页（`lib/intro.js` 的 handoff），首页芒星从那里平移缩放到自己的位置，其它元素提前渐入；不再二次绽放。
- `tryConnect` / `tryConnectBases` 新增第三个参数 `{ beforeCommit }`，探测成功后、切到首页前调用。
- 冷启动已有 token 时登录页不抢开屏，首页照常绽放。
- 新增原生依赖 expo-camera（app.json 已加相机权限说明），需要重新编译 dev client；旧安装包里点扫码会提示重新编译。
