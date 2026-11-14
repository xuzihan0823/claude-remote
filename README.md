<div align="center">

<img src="app/assets/icon.png" alt="claude-remote" width="96" />

# claude-remote

### 在 iPhone 上远程查看、续聊与审批 Mac 本机的 Claude Code 会话

**把桌面终端里的 Claude Code 带到手机上——实时镜像、双向接力、安全审批、多通道连接。**

Local-first · 只读 JSONL 历史 · Fail-closed 审批 · Tailscale / 自建 Relay

<br />

[![Stars](https://img.shields.io/github/stars/xuzihan0823/claude-remote?style=flat&label=stars)](https://github.com/xuzihan0823/claude-remote/stargazers)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%2B%20iOS-000000?logo=apple&logoColor=white)](#快速开始)

<br />

[快速开始](#快速开始) ·
[整体结构](#整体结构) ·
[安全边界](#local-first-与安全边界) ·
[自建 Relay](deploy/relay/README.md) ·
[常用命令](#cr-控制台与常用命令) ·
[开发与目录](#开发与目录约定) ·
[待做清单](docs/v2-backlog.md)

</div>

> 浏览器客户端已移除。daemon 仅提供 API、WebSocket 和本机配对接口，根路径与网页静态资源返回 `404`。后续能力规划见[第二版本待做清单](docs/v2-backlog.md)。

---

## 为什么用 claude-remote？

<table>
<tr>

<td width="25%" valign="top">

### 实时镜像与续聊

直接读取 Mac 本机 `~/.claude/projects/**/*.jsonl`。

手机端实时查看输出、选择模型与思考强度、上传图片/文件并续聊会话。

</td>

<td width="25%" valign="top">

### 终端与手机接力

手机与桌面共享同一份会话记录。

`cr open <id>` 可在终端用 `claude --resume` 接管；终端占用期间自动避免并发冲突。

</td>

<td width="25%" valign="top">

### Fail-closed 审批

工具调用与提问经手机端弹窗确认。

超时、断线、重启或异常一律自动拒绝（deny），不做自动放行。

</td>

<td width="25%" valign="top">

### 多通道自动选路

支持局域网、Tailscale、自建公网 Relay 同时启用。

直连优先，断线自动重选；Mac 无需开放公网入站端口。

</td>

</tr>
</table>

---

## 整体结构

```text
iPhone App (app/ + web/core/)
   │  HTTP + WebSocket · Bearer Token
   ├── 直连通道：局域网 / Tailscale / mDNS（优先）
   └── 中转通道：https://<RELAY_HOST>/d/<deviceId> ── packages/relay（自建公网服务器）
                                                          ▲ Mac 主动连出
Mac daemon (packages/daemon) ──── connector ──────────────┘
   ├── 读取 ~/.claude/projects/**/*.jsonl（只读）
   ├── 经 Agent SDK 驱动续聊（packages/agent-bridge）
   └── 审批状态机（packages/interactions，node:sqlite）
cr 命令行 (packages/cli)：全屏 TUI 控制台 · 启停 · 配对 · Relay 配置
```

---

## Local-first 与安全边界

| 项目 | 默认行为与约束 |
|---|---|
| 会话数据源 | 仅以 Mac 本机 `~/.claude/projects/**/*.jsonl` 为准；daemon 只读不改写（写入仅来自 SDK resume 原生落盘） |
| 终端 / 手机互斥 | 实测 Claude Code 2.1.209：`--resume` 同 `session_id` 同文件追加；`--fork-session` 复制新文件。存活终端占用期间不抢占 |
| 审批策略 | Fail-closed：默认 300 秒超时自动拒绝，断线、异常、重启一律 deny |
| 应用层鉴权 | 随机生成的固定 Bearer Token（`BRIDGE_TOKEN`），不自建加密协议 |
| 配对接口保护 | `/api/pair-info` 与 `/api/pair-qr.svg` 仅允许本机回环访问，经 Relay 或携带代理特征头一律返回 `403` |
| 公网中转边界 | 无官方托管云端；Relay 仅支持部署在你自己控制的 Linux 服务器上（HTTPS 在你的服务器上解包，请勿接入不可信 Relay） |

---

## 快速开始

<table>
<tr>

<td width="25%" valign="top">

### 01

**安装 `cr`**

Mac 端自动初始化配置

</td>

<td width="25%" valign="top">

### 02

**打通网络**

Tailscale 或自建 Relay

</td>

<td width="25%" valign="top">

### 03

**安装 iPhone App**

目前需源码构建到真机

</td>

<td width="25%" valign="top">

### 04

**扫码配对**

运行 `cr pair` 开始使用

</td>

</tr>
</table>

### 前置条件

- **Mac**：macOS、**Node.js ≥ 22.5**（`interactions` 包依赖内置 `node:sqlite`）、已安装并登录 **Claude Code CLI**
- **iPhone**：当前暂未上架 App Store / TestFlight，需在 Mac 上使用 **Xcode** 从 `app/` 编译安装到真机
- **远程网络（跨 Wi-Fi 使用时二选一）**：
  - 无服务器：Mac 与 iPhone 安装 **Tailscale** 并登录同一账号
  - 有公网 Linux 服务器：部署一份自建 **Relay**（支持无域名 IP 证书）

---

### 第一步：Mac 端安装与初始化

```sh
npm install -g @anyu/claude-remote
cr
```

首次运行 `cr` 没有检测到 `BRIDGE_TOKEN` 时会自动执行初始化：
- 生成随机 `BRIDGE_TOKEN` 并写入 `~/.claude-remote/config.env`
- 自动探测本机 `claude` 可执行文件路径（支持 PATH、login shell、Homebrew、nvm/fnm/volta/bun 等）
- 启动 daemon 并进入 `cr` 全屏控制台

> 默认模式下，daemon 随 `cr` 一起启停（打开 `cr` 启动，退出即停）。如果需要后台常驻与开机自启，执行：
> ```sh
> cr config set autostart on
> ```

---

### 第二步：打通连接方式（可同时启用）

手机会把直连地址和 Relay 地址视作同一台 Mac 的多个通道，**能直连时优先直连，不通时自动走 Relay**。

#### 方案 A：Tailscale Serve（无需服务器）

1. 在 Mac 和 iPhone 上安装 Tailscale，并连接同一个 Tailscale 网络。
2. 保持 Mac 上的 `cr` 运行，在另一个终端运行：

   ```sh
   cr pair --tailscale
   ```

3. 首次使用 Serve 时，按 Tailscale 提示在浏览器开启 HTTPS，再扫终端二维码。

daemon 可以保持默认的 `127.0.0.1`。命令会复用已经指向 daemon 的私有 HTTPS Serve 地址，或在 Tailscale 的 443、8443 端口中选一个空闲端口。已配对且在线的手机会自动收到新地址。

Tailscale 会自动处理直连和 DERP 中继，手机使用同一个 HTTPS 地址。也配置了自建 Relay 时，在 App 的「设置 → 设备 → 设备详情 → 通道偏好」选择「Relay」「Tailscale」或「自动」。切换当前设备的通道时，App 会先试连，再保存偏好。

只在同一个 Wi-Fi 下使用时，也可以用 `cr config set host 0.0.0.0` 开启局域网直连。默认随 `cr` 启停时，重开 `cr` 使设置生效，再运行 `cr pair`。

#### 方案 B：自建公网 Relay（有 Linux 服务器时）

在公网 Linux 服务器（以 Debian / Ubuntu 为主要验证目标）上执行一行安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash
```

脚本会自动安装 Docker、拉取镜像、启动 Relay 与 Caddy（支持直接用公网 IP 申请 HTTPS 证书），并在最后打印一条接入命令，复制到 Mac 执行即可：

```sh
cr relay add https://<RELAY_HOST> <密钥>
```

- 支持同时接入多台自有 Relay 容灾；配置热加载生效，无需重启正在进行的会话。
- 已配对手机完整连接一次（或热加载同步后）会自动获取新 Relay 地址，无需重新扫码。
- 端口放行（443 / 80）、自定义域名与国内未备案服务器指引详见 [deploy/relay/README.md](deploy/relay/README.md)。

---

### 第三步：安装 iPhone 客户端（源码构建）

<details>
<summary><strong>展开查看 iOS 真机编译步骤（当前无 TestFlight，需 Xcode）</strong></summary>

<br />

`app/` 使用原生模块（如 `expo-camera`、`expo-dev-client`、`react-native-mmkv`、`react-native-webview`），不能直接用 Expo Go 运行，需在 Mac 上编译安装：

```sh
git clone https://github.com/xuzihan0823/claude-remote.git
cd claude-remote/app
npm install
npx expo run:ios --device
```

- 首次构建需在 Xcode 中选择你自己的 **Apple Developer Signing Team**，并按需修改不冲突的 **Bundle Identifier**。
- 首次安装真机前请保持 iPhone 解锁（锁屏可能触发 `kAMDMobileImageMounterDeviceLocked` 报错）。
- 若要打 Release 包，可直接使用 `app/ios/` 工程配合 `xcodebuild` 构建签名安装。

</details>

---

### 第四步：扫码配对

如果第二步已经完成扫码，可以开始使用。需要再次显示配对码时，在 Mac 终端运行（或在 `cr` 全屏控制台里按 `p`）：

```sh
cr pair
```

使用 iPhone 相机扫码（或在 App 内「添加设备」扫码），即可完成配对并同步候选连接地址。

---

## `cr` 控制台与常用命令

直接运行 `cr` 会进入全屏 TUI 控制台（支持会话列表、搜索、详情回看、实时输出、审批、配对二维码与日志查看；进入后按 `?` 查看全部快捷键）。子命令适合脚本或快速操作：

| 命令 | 用途 |
|---|---|
| `cr` | 进入全屏控制台（首次运行自动初始化） |
| `cr setup` | 重新探测 `claude` 路径并检查初始化状态 |
| `cr pair` | 在终端打印配对二维码与候选地址 |
| `cr status` | 查看 daemon、launchd、通道（Tailscale / Relay）与会话状态 |
| `cr up` / `cr down` / `cr restart` | 启动 / 停止 / 重启 daemon |
| `cr config` | 查看或修改配置（`host`、`port`、`bark`、`ntfy`、`autostart` 等） |
| `cr relay add \| status \| on \| off \| remove` | 管理自建 Relay 连接 |
| `cr ls [-n 20]` / `cr search <词> [--full]` | 列出或搜索最近会话（`--full` 全文检索） |
| `cr show <id>` / `cr open <id>` | 查看会话最近消息 / 在终端 `claude --resume` 接管 |
| `cr logs` | 实时查看 daemon 日志 |

---

## 开发与目录约定

<details>
<summary><strong>展开查看源码运行、构建与测试命令</strong></summary>

<br />

### 从源码运行 Mac 端

```sh
git clone https://github.com/xuzihan0823/claude-remote.git
cd claude-remote
pnpm install
node packages/cli/bin/cr.mjs setup
```

- 源码模式（`repo`）配置位于仓库根目录 `.env`（可参考 [.env.example](.env.example)），`cr setup` 会在 `~/.local/bin/cr` 创建软链；npm 全局安装模式（`package`）配置位于 `~/.claude-remote/config.env`。
- 开发时 daemon 通过 `tsx` 运行（`pnpm dev`）；`pnpm build:npm` 会构建发布到 `dist/npm/` 的 CLI 与 daemon 产物。
- 手机端 `app/` 维护独立的 `npm` 依赖与原生工程，不纳入根 `pnpm` workspace。

### 开发检查

```sh
pnpm typecheck   # 检查工作区 TypeScript
pnpm test        # 运行核心逻辑、手机端辅助逻辑与各包测试（统一使用 node:test / tsx --test）
pnpm build:npm   # 构建 npm 发布包
```

> 兼容命令 `pnpm test:web` 仅运行 `web/core/` 测试，不代表仍存在浏览器界面；`web/core/` 暂时保留原路径以避免大范围改写手机端 import。

</details>

### 仓库目录

```text
claude-remote/
├── README.md            项目定位、快速上手、命令与目录约定
├── PROGRESS.md          当前状态、待办与踩坑记录
├── app/                 React Native + Expo 手机端（独立 npm 依赖；原生工程在 app/ios/）
├── docs/                架构说明、设计方案与 V2 待做清单
├── packages/            daemon、agent-bridge、interactions、cli、relay
├── web/core/            手机端共用的连接、缓存、模型与流草稿逻辑及测试
├── web/vendor/          手机端依赖的 Markdown 解析器与事件 hook 兼容依赖
├── deploy/relay/        公网 Relay 一键安装与 Docker/Caddy/systemd 部署文件
└── scripts/             npm 打包、launchd 入口与历史会话修复脚本
```

---

## 文档导航

- [架构说明](docs/architecture.md) — 会话数据流、终端/手机占用互斥、安全边界与 Relay 协议
- [自建 Relay 指南](deploy/relay/README.md) — 多 Relay 容灾、IP 证书、端口与国内服务器配置
- [第二版本待做清单](docs/v2-backlog.md) — 后续能力规划与验收标准
- [进度与踩坑记录](PROGRESS.md) — 当前各分支进度与已知调试经验
