# Claude Remote for Mac

macOS 14+ 的 SwiftUI 菜单栏辅助程序。它以子进程方式管理本仓库的 daemon，并复用 daemon 的配对页面。

## 构建与运行

```sh
cd mac
swift build
swift run
```

默认启动命令是：

```sh
pnpm --dir /Users/mac/Desktop/claude-remote dev
```

启动命令、HTTP 端口和手动选择的 `claude` 路径均通过 `UserDefaults` 持久化。首次启动会在 Keychain 的 service `claude-remote` 中创建并保存 32 字节随机 hex `BRIDGE_TOKEN`。

## 常驻运行（launchd，推荐）

nohup 起的 daemon / cloudflared 会随终端或 agent 会话一起消失。改用 LaunchAgent 让 launchd 托管：登录即起、崩溃自动拉起、与任何会话无关。

```sh
pnpm install                                  # 首次
scripts/launchd/install.sh install            # 只托管 daemon
scripts/launchd/install.sh install --tunnel   # 同时托管 cloudflared named tunnel（默认隧道名 claude-remote）
scripts/launchd/install.sh status             # 查看状态 / pid / 上次退出码
scripts/launchd/install.sh logs               # 日志在 ~/Library/Logs/claude-remote/
scripts/launchd/install.sh uninstall          # 移除
```

- 安装时会先停掉占着 `BRIDGE_PORT` 的 nohup 旧实例和非托管的 cloudflared，避免撞端口。
- token 读取顺序：环境变量 → 仓库 `.env` → Keychain（菜单栏 App 生成的 `claude-remote / bridge-token`），三种启动方式用同一个 token。
- 装了 LaunchAgent 后，菜单栏 App 自动切换为「launchctl 模式」：启动 = `bootstrap + kickstart`，停止 = `bootout`（KeepAlive 下直接 kill 会被立刻拉起），重启 = `kickstart -k`；退出 App 不会停掉 daemon。
- 仓库在 `~/Desktop` / `~/Documents` 下时，launchd 起的 zsh 可能被 TCC 拦（日志里 `Operation not permitted`）：给 `/bin/zsh` 加「完全磁盘访问」，或把仓库移出这些目录后重装。

## 已知限制

- 当前为 Swift Package 可执行程序，尚未打包为 `.app`；`SMAppService.mainApp` 的开机自启注册需要完成 app bundle、签名和安装后才会成功。
- 默认命令面向开发环境，发布版仍需将 Node 运行时与 daemon 打包进 app。
- 未运行 GUI 验证；请在带有图形会话的 macOS 中执行 `swift run`。
