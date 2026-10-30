# 进度

> 恢复工作时先读本文件。项目定位、目录和技术边界见 `README.md`，关键设计见 `docs/architecture.md`，relay 部署见 `deploy/relay/README.md`。

## 当前状态（2026-10-28）

- 分支：`feat/cli-tui` 与 `feat/self-hosted-relay` 同在 `4f3eb04`，包含 cr 命令行与自建 relay，均**未合并进 `main`**。
- Mac 端：`cr` 命令行取代了菜单栏 App，daemon 默认随 cr 启停，`cr config set autostart on` 后交给 launchd 常驻。
- 接入：Tailscale / 局域网直连 + 自建 relay，手机自动选可用通道（直连优先）。不再使用 Cloudflare Tunnel。
- relay 已部署：华为云 `<SERVER_IP_A>`，地址 `https://<RELAY_HOST>:8443`。
- 手机端：React Native 版已用 Distribution 证书装到 iPhone 17（iOS 27.0 Beta），描述文件 2027-08-30 到期。

## 待办

1. 在常用 daemon 上执行 `cr relay add`，真机测"直连断开 10 秒内切到 relay"。
2. 分支合并进 `main`。
3. 键盘真机验收：逐帧跟手、交互式收起、sheet/审批卡位置、表情面板高度切换、暗色模式（09-03 记录时未做）。
4. macOS 上实测 launchctl 托管与 `claude --resume` 接管（10-21 记录时未在 macOS 验证）。
5. 可选：relay 镜像推 GHCR。

## 记录

### F-01 / L-01 / D-01 修复

- F-01：统一 App 运行状态更新，重连使用指定会话 WS 快照；修复空消息、首屏失败后的恢复和迟到响应覆盖，发送响应立即绑定 runId。
- L-01：默认项显示“跟随项目默认”，区分用户配置默认与项目实际运行配置，保持省略 model 的行为。
- D-01：当前新建、续聊、停止、模型与 WS 恢复契约集中维护在 `docs/architecture.md`；问题清单状态与实施记录已更新。
- 验证：`pnpm test` 367/367、`pnpm typecheck`、iOS Hermes bundle 导出通过。未做真机/模拟器交互、原生构建、真实推理或部署。

### 2026-09-03·RN 真机 Distribution 签名安装

- Metro Release 构建修复（`app/metro.config.js`）：Expo 57 / Metro 0.84 在 `projectRoot=app/`、`watchFolders=web/` 时无法为 `web/core/*.js` 建立文件哈希（`Failed to get the SHA-1`）。修法是把 `projectRoot`/`watchFolders` 提到仓库根，依赖查找顺序显式设为 `app/node_modules`、根 `node_modules`，自定义 resolver 回退到 `context.resolveRequest(...)`。
- 签名：Distribution 证书导入登录钥匙串，仅授权 `/usr/bin/codesign` 与 `/usr/bin/security`；描述文件只含这台 iPhone 的 UDID。项目源码里的默认 Team/Bundle ID 没改，Release 构建通过命令行临时覆盖。
- 验证：`xcodebuild` Release/iphoneos 成功，`codesign --verify --deep --strict` 通过，`devicectl` 安装并启动成功，3 秒后进程仍在。

### 2026-10-21·cr 命令行取代菜单栏 App

- 新增 `packages/cli`（命令 `cr`）：不带参数进 Ink 全屏控制台（会话列表/搜索/预览、实时视图与回复、审批、配对二维码、日志、启停）；子命令见 `cr --help`。
- launchd 逻辑移到 `packages/cli/src/launchd.ts`（Label 沿用 `com.claude-remote.daemon`，旧安装可接管），`scripts/launchd/run-daemon.sh` 保留为 launchd 入口；`cr down` 额外 `launchctl disable`，跨登录保持停止。
- `cr setup` 把旧菜单栏 App 存在 Keychain 的 token 迁进 `.env`，已配对手机不受影响。删除 `mac/` Swift 菜单栏 App。
- daemon 新增 `GET /api/sessions/search`（`full=1` 流式全文，256MB 预算）与 `GET /api/interactions/pending`（后连客户端补齐待审批）。
- 去掉 Cloudflare 接入（删除 `BRIDGE_PUBLIC_BASES`），配对候选只剩自动枚举的 Tailscale / 局域网 / mDNS 地址；pair-info 对代理特征头（含 `cf-*`）一律 403 的防护保留。

### 2026-10-27·自建 relay

- M1 手机端多通道：`probeBases` 并行探测（直连优先，relay 宽限 1.5s，401 短路）；WS 应用层 ping/pong 识别半开连接，连续失败或半开时 `ws-reselect` 重新选路；`GET /api/connect-info` 让已配对手机自动拿到新通道。
- M2 `packages/relay`：无状态 relay（设备 ID 由设备私钥派生），HTTP/WS 经 agent 长连接多路复用，256KiB 流量窗口；esbuild 打成单文件镜像。
- M3 daemon connector + `cr relay add/status/on/off/remove`；配对端点经 relay 一律 403（WHATWG 路径规范化 + X-Forwarded-* 双层）。
- M4 `deploy/relay/`：一行安装脚本（重跑即升级、保留密钥）、compose（relay + Caddy）、GHCR 多架构镜像工作流（`relay-v*` 标签触发）。
- M5 App 设备页：显示当前通道、通道偏好（自动/仅直连/仅 relay）。
- 部署：宿主 Caddy 共用 8443 按域名分流，relay 以 systemd `claude-remote-relay` 运行（机器无 Docker、内存 768MB、80 端口被占）。公网验证通过：token 200/401、配对端点 403、WS ping/pong、relay 重启后 Mac 约 1s 重连。
- relay 协议与多通道的设计要点已整理进 `docs/architecture.md`。

## 踩坑

- 真机首次安装报 `kAMDMobileImageMounterDeviceLocked`：手机锁屏导致，解锁即可，不用换 Xcode。
- 国内服务器上未备案域名（含 sslip.io）访问 80 端口会被阻断，sslip.io 兜底在国内不可用。
- 本仓库多个 worktree 共用 stash 列表，临时保存文件别用 `git stash`。
