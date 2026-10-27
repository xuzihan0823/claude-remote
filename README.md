# claude-remote

在手机上远程查看与续聊 Mac 本机的 Claude Code 会话：Mac 上一个 daemon 读取 `~/.claude/projects/` 的会话 JSONL 作为唯一数据真相，手机浏览器经 Tailscale 访问类 Claude App 的聊天界面；终端驾驶时实时旁观，空闲时手机接管续聊（SDK resume），工具审批在手机完成，回终端 `claude --resume` 完整可见。

阶段一为 Web 版（本仓库），阶段二 iOS 原生 app 在 Web 版验证后另行启动。

## 目录约定

```
claude-remote/
├── README.md            项目定位、协作规则、目录约定
├── PROGRESS.md          当前进度与状态（每次恢复工作先读这个）
├── docs/
│   ├── design.md        方案设计（架构、决策、里程碑、风险）
│   └── api-contract.md  HTTP/WS API 契约 v1（多任务卡共同依据）
├── task/                任务卡目录，每个 .md 是一个可分派的任务窗口
│   └── INDEX.md         任务总览、依赖关系、并行组
├── reports/             各任务窗口执行完成后的结果文档
├── packages/            daemon、interactions、agent-bridge、cli（cr 命令）
├── web/                 纯静态 Web UI（免构建）
└── .trellis/ .claude/ .codex/   Trellis 工作流（Claude + Codex 双平台）
```

## Mac 端：cr 控制台

Mac 端只有一个命令行入口 `cr`（原菜单栏 App 已删除）。daemon 交给 launchd 常驻：登录即起、崩溃自动拉起。

```sh
npm install -g @anyu/claude-remote   # 给其他人用：npm 安装
cr                                           # 首次运行自动初始化（token、查找 claude、注册 launchd），然后进入控制台

# 或者从源码运行（开发）
pnpm install
node packages/cli/bin/cr.mjs setup
```

常用子命令：`cr status`、`cr up|down|restart`、`cr logs`、`cr pair`、`cr web`、`cr search <词> [--full]`、`cr open <id>`。详见 [docs/cli.md](docs/cli.md)。

## 接入方式

手机连到 Mac 有两种方式，可以同时启用，手机会自动选当前能用的那条（能直连时优先直连）：

- **Tailscale**（没有服务器时用）：Mac 和手机装 Tailscale 并登录同一账号，`cr pair` 扫码即可。在同一 Wi-Fi 下也能直接走局域网。
- **自建 relay**（有一台公网 Linux 服务器时用）：在服务器上执行一行安装命令，再在 Mac 上执行它打印出的 `cr relay add …`。详见 [deploy/relay/README.md](deploy/relay/README.md)。

```bash
curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash
```

## 协作规则

1. 每个任务卡 `task/NN-*.md` 是一个独立"任务窗口"，只由一个 Claude/Codex 会话处理。
2. 任务窗口不得跨卡修改其他窗口拥有的文件；文件所有权在每张卡中明确列出。
3. 每张卡完成后必须写结果报告到 `reports/NN-*.md`。
4. 有依赖的卡不得并行；并行组见 `task/INDEX.md`。
5. 主窗口负责合并、集成（06 卡）、冲突调解和端到端验证。

## 技术边界

- 数据真相是 `~/.claude/projects/**/*.jsonl`；daemon 对其**只读**（写入只发生在 SDK resume 的天然落盘）。
- 已实测（Claude Code 2.1.209）：`--resume` 同 session_id 同文件追加；`--fork-session` 新文件全量复制历史。
- 网络边界是 Tailscale 或用户自建的 relay；Mac 不开公网端口（relay 由 Mac 主动连出），不自建加密协议，应用层仅一个固定 Bearer token。
- 零构建：daemon 用 tsx 直跑，Web UI 纯静态 + vendored 依赖，无打包工序。
- 审批 fail-closed：超时、断线、重启、异常一律 deny；不引入自动批准。
- 统一测试 runner：`tsx --test`（node:test），不混用多套框架。
- Node ≥ 22.5（interactions 包依赖 `node:sqlite`）。
