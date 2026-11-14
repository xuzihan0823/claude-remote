<div align="center">

<img src="app/assets/icon.png" alt="claude-remote" width="96" />

# claude-remote

### 在 iPhone 上远程查看、续聊与审批 Mac 本机的 Claude Code 会话

**把桌面终端里的 Claude Code 带到手机上——实时镜像、双向接力、安全审批、多通道连接。**

Local-first · 只读 JSONL 历史 · Fail-closed 审批 · Tailscale / 自建 Relay

<br />

[![Stars](https://img.shields.io/github/stars/xuzihan0823/claude-remote?style=flat&label=stars)](https://github.com/xuzihan0823/claude-remote/stargazers)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%2B%20iOS-000000?logo=apple&logoColor=white)](docs/quickstart.md)

<br />

[快速开始](docs/quickstart.md) ·
[整体结构](#整体结构) ·
[安全边界](#local-first-与安全边界) ·
[自建 Relay](deploy/relay/README.md) ·
[常用命令](#cr-控制台与常用命令) ·
[开发与目录](#开发与目录约定)

</div>

> 浏览器客户端已移除。daemon 仅提供 API、WebSocket 和本机配对接口，根路径与网页静态资源返回 `404`。

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

从 `app/` 构建到真机

</td>

<td width="25%" valign="top">

### 04

**扫码配对**

运行 `cr pair` 开始使用

</td>

</tr>
</table>

<div align="center">

### [查看完整安装与配置指南 →](docs/quickstart.md)

**需要 macOS · Node.js ≥ 22.5 · Claude Code CLI · Xcode（iOS 源码构建）**

</div>

---

## `cr` 控制台与常用命令

直接运行 `cr` 会进入全屏 TUI 控制台（支持会话列表、搜索、详情回看、实时输出、审批、配对二维码与日志查看；进入后按 `?` 查看全部快捷键）。子命令适合脚本或快速操作：

| 命令 | 用途 |
|---|---|
| `cr` | 进入全屏控制台（首次运行自动初始化） |
| `cr setup` | 重新探测 `claude` 路径并检查初始化状态 |
| `cr pair [--tailscale]` | 打印配对二维码与候选地址；加 `--tailscale` 自动配置 Tailscale Serve |
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
├── README.md            项目定位、概览、命令与目录约定
├── PROGRESS.md          当前状态、待办与踩坑记录
├── app/                 React Native + Expo 手机端（独立 npm 依赖；原生工程在 app/ios/）
├── docs/                快速安装指南、架构说明与设计方案
├── packages/            daemon、agent-bridge、interactions、cli、relay
├── web/core/            手机端共用的连接、缓存、模型与流草稿逻辑及测试
├── web/vendor/          手机端依赖的 Markdown 解析器与事件 hook 兼容依赖
├── deploy/relay/        公网 Relay 一键安装与 Docker/Caddy/systemd 部署文件
└── scripts/             npm 打包、launchd 入口与历史会话修复脚本
```

---

## 文档导航

- [快速开始](docs/quickstart.md) — Mac 端安装、Tailscale Serve / Relay 接入与 iOS 真机编译指南
- [架构说明](docs/architecture.md) — 会话数据流、终端/手机占用互斥、安全边界与 Relay 协议
- [自建 Relay 指南](deploy/relay/README.md) — 多 Relay 容灾、IP 证书、端口与国内服务器配置
- [进度与踩坑记录](PROGRESS.md) — 当前各分支进度与已知调试经验
