# claude-remote

在 iPhone 上远程查看与续聊 Mac 本机的 Claude Code 会话。手机端使用 React Native + Expo，通过 HTTP/WebSocket 连接 Mac daemon；支持实时输出、续聊、工具审批和终端接管。会话数据以 `~/.claude/projects/**/*.jsonl` 为准。

浏览器客户端已移除。daemon 仅提供 API、WebSocket 和本机配对接口，根路径与网页静态资源返回 404。

## 目录约定

```
claude-remote/
├── README.md            项目定位、目录、技术边界
├── PROGRESS.md          当前状态、待办与踩坑（每次恢复工作先读这个）
├── app/                 React Native + Expo 手机端，独立 npm 依赖；原生工程在 app/ios/
├── docs/                架构说明与进行中的修复方案
├── packages/            daemon、agent-bridge、interactions、cli、relay
├── web/core/            手机端使用的连接、缓存、模型与流草稿逻辑及测试
├── web/vendor/          手机端依赖的 Markdown 解析器和事件 hook 兼容依赖
├── deploy/relay/        公网中转部署文件
├── scripts/             npm 打包、launchd 入口与历史会话修复脚本
```

## Mac 端：cr 控制台

Mac 端命令行入口为 `cr`。默认 daemon 随 cr 启停；设置 `cr config set autostart on` 后交给 launchd 常驻。

```sh
npm install -g @anyu/claude-remote   # 给其他人用：npm 安装
cr                                           # 首次运行自动初始化（token、查找 claude、注册 launchd），然后进入控制台

# 或者从源码运行（开发）
pnpm install
node packages/cli/bin/cr.mjs setup
```

常用子命令：`cr status`、`cr up|down|restart`、`cr logs`、`cr pair`、`cr search <词> [--full]`、`cr open <id>`。运行 `cr --help` 查看完整帮助。

## 接入方式

手机连到 Mac 有两种方式，可以同时启用，手机会自动选当前能用的那条（能直连时优先直连）：

- **Tailscale**（没有服务器时用）：Mac 和手机装 Tailscale 并登录同一账号，`cr pair` 扫码即可。在同一 Wi-Fi 下也能直接走局域网。
- **自建 relay**（有公网 Linux 服务器时用）：在每台服务器执行一行安装命令，再在 Mac 上执行它打印出的 `cr relay add …`。支持同时接入多个自有 relay，一台故障时手机自动重选可用通道。已配对手机完整连接一次即可同步新地址，无需更新 App 或重新扫码。详见 [deploy/relay/README.md](deploy/relay/README.md)。

```bash
curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash
```

## 技术边界

- 数据真相是 `~/.claude/projects/**/*.jsonl`；daemon 对其**只读**（写入只发生在 SDK resume 的天然落盘）。
- 已实测（Claude Code 2.1.209）：`--resume` 同 session_id 同文件追加；`--fork-session` 新文件全量复制历史。
- 网络边界是 Tailscale 或用户自建的 relay；Mac 不开公网端口（relay 由 Mac 主动连出），不自建加密协议，应用层仅一个固定 Bearer token。
- daemon 开发时用 tsx 运行；`pnpm build:npm` 构建 CLI/daemon 发布包，不再携带浏览器静态资源。手机端在 `app/` 中独立安装依赖和构建。
- 审批 fail-closed：超时、断线、重启、异常一律 deny；不引入自动批准。
- 统一测试 runner：`tsx --test`（node:test），不混用多套框架。
- Node ≥ 22.5（interactions 包依赖 `node:sqlite`）。

## 开发检查

`pnpm typecheck` 检查工作区 TypeScript；`pnpm test` 运行核心逻辑、手机端辅助逻辑和各包测试。兼容命令 `pnpm test:web` 仅运行 `web/core/` 测试，不表示仍有浏览器界面。

`web/core/` 暂时保留原路径，避免大范围改写手机端 import。
