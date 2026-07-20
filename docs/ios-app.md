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
