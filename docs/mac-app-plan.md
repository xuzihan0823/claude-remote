# Mac 端待办总览（阶段 B：菜单栏 App「Claude Remote for Mac」）

> 2026-07-21 定稿。承接 docs/pairing-plan.md §3.5/§3.6；阶段 A（daemon 出码 + `#/pair` 页 + 扫码配对 + 附件时序修复）已全部完成并实测连通，见 PROGRESS.md 同日记录。本文是 Mac 端后续工作的唯一清单，清空上下文后从这里恢复。

## 0. 产品定位（已拍板）

- **一个收费产品 + 一个免费配套**：iOS app 上 App Store 收费；Mac 菜单栏 app 免费、不上 Mac App Store（沙盒无法启动 claude CLI / 读 `~/.claude`），公证后以 DMG 分发。
- Mac app 定位是「Claude Code 的遥控器配套助手」：前提是用户本机已安装并登录 Claude Code。app 不碰 Anthropic 凭据，账号/权限/CLAUDE.md 全部经由调用本机 `claude` CLI 天然复用。
- **发布结构（双仓库)**：现 monorepo 保持私有；另建公开仓库 `claude-remote-releases` 只放 README/FAQ/更新日志，DMG 作为其 GitHub Release 附件发布（空仓库可发 Release）。将来 Sparkle 的 appcast.xml 也放这里。切勿直接公开 monorepo（iOS 源码公开会架空收费）。

## 1. App 形态与职责

SwiftUI `MenuBarExtra` 常驻菜单栏，职责仅四项（聊天界面不做原生，复用 web UI）：

1. **守护 daemon**：作为子进程拉起/停止/崩溃重启（或注册 launchd 项实现登录自启）；菜单显示状态灯（运行中/已停止/端口冲突）。
2. **二维码窗口**：点开即弹窗。实现二选一：WKWebView 加载 `http://127.0.0.1:8788/#/pair`（省事，复用现成页面），或读 `/api/pair-info` 后用 CoreImage `CIQRCodeGenerator` 原生绘制（更快更稳，不依赖 web 资源）。payload 契约见 §4。
3. **「在浏览器打开完整界面」**入口 → `http://127.0.0.1:<port>/`。
4. 常规项：开机自启开关、检查更新（Sparkle）、退出。

被否选项（勿回头）：Capacitor→Mac Catalyst（官方不支持）、Electron（过重）、Tauri（新工具链收益不成比例）。

## 2. 消费级化三件事（daemon 侧配合改造）

按优先级：

1. **token 自动生成**（几行代码）：现在 `BRIDGE_TOKEN` 必须手写 `.env`，缺失拒启（packages/daemon/src/config.ts）。app 首启生成随机 token 存 Keychain，以环境变量注入 daemon 子进程。daemon 代码基本不用改（本来就读 env）。
2. **探测 `claude` 可执行文件**：GUI app 子进程没有 shell PATH。按序探测 `~/.local/bin/claude`、`/opt/homebrew/bin/claude`、`/usr/local/bin/claude`，兜底让用户手动选一次并持久化。注意确认 daemon 的 TurnRunner 当前如何 spawn claude（依赖 PATH 的话需支持显式路径注入，加一个 env 如 `CLAUDE_BIN`）。
3. **打包 Node 运行时**（最重，留最后）：daemon 现靠 `pnpm dev`（tsx + Node ≥22.5，依赖 node:sqlite）。方案：`node --experimental-sea` 单文件二进制 / bun compile（需验证 node:sqlite 兼容）/ app 内嵌精简 Node。产物随 app bundle 分发。

## 3. 分发链路

- Apple Developer ID 签名 + notarytool 公证 → DMG。
- Sparkle 自动更新：appcast 放公开 releases 仓库；私有仓库 CI 构建后推产物过去。
- 首次启动引导页：检测 claude CLI 是否存在/已登录，不满足时给安装指引链接。

## 4. 现有契约（app 依赖的接口，均已实现并实测）

- `GET /api/pair-info`（loopback-only，无 Bearer）→ `{ bases: string[], token: string }`；非本机 403 `{error:"loopback_only"}`。
- `GET /api/pair-qr.svg`（loopback-only）→ SVG 二维码。
- QR payload：`claude-remote://setup?v=1&token=<enc>&bases=<enc(url1)>,<enc(url2)>`（每个 URL 单独 encodeURIComponent，逗号不编码）。
- 地址枚举顺序：Tailscale(100.64/10) → en0 局域网 IPv4 → `<hostname>.local`（packages/daemon/src/pair.ts）。
- token 轮换：换 token 重启 daemon → 手机 401 → 回 SetupGate → 重扫即可。
- 上传：`POST /api/upload?filename=`（会话前，Bearer）与 `POST /api/sessions/:id/upload`（会话内）。

## 5. 建议实施顺序

1. daemon 支持 `CLAUDE_BIN` 显式路径（小改，先行合入）。
2. SwiftUI 壳：MenuBarExtra + 子进程管理 + 状态灯 + 二维码窗口（先 WKWebView 版）。
3. token 自动生成 + Keychain + 首启引导。
4. 运行时打包（SEA/bun 调研 node:sqlite 兼容性后定）。
5. 签名/公证/DMG + 公开 releases 仓库 + Sparkle。

每步完成后更新 PROGRESS.md。
