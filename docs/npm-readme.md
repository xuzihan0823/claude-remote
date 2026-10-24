# Claude Remote

在 iPhone 上接管 Mac 里的 Claude Code 会话：看实时输出、接着聊、批准工具调用。
Mac 端是一个常驻 daemon（launchd 托管）加终端控制台 `cr`。

## 安装

需要 macOS、Node.js 22.5+，以及已安装的 [Claude Code](https://docs.anthropic.com/claude-code)。

```sh
npm install -g @anyu/claude-remote
cr
```

第一次运行 `cr` 会自动初始化：

- 生成访问 token（存在 `~/.claude-remote/config.env`，权限 600）
- 自动查找 claude（当前 PATH、登录 shell、官方安装器、Homebrew、npm 全局、nvm/fnm 等位置）
- 注册 launchd 服务并启动 daemon（登录自启、崩溃自动拉起）

之后在控制台按 `p`，用 iPhone 相机扫码配对。手机和 Mac 需要在同一局域网或同一 Tailscale 网络，
并把监听地址改成 `0.0.0.0`：`cr config set host 0.0.0.0`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `cr` | 全屏控制台：会话、搜索、审批、配对、日志、设置 |
| `cr setup` | 重新初始化（换了 Node 版本或重装 claude 后运行） |
| `cr up` / `down` / `restart` | 启动 / 停止 / 重启 daemon |
| `cr status` | 运行状态和配对地址 |
| `cr config` | 查看和修改配置（端口、推送、审批超时、claude 路径…） |
| `cr pair` | 终端打印配对二维码 |
| `cr logs` | 跟随 daemon 日志 |
| `cr uninstall` | 移除 launchd 服务（不删数据） |

数据都在 `~/.claude-remote`（配置、审批记录、手机上传的附件），日志在 `~/Library/Logs/claude-remote/`。

## 卸载

```sh
cr uninstall
npm uninstall -g @anyu/claude-remote
rm -rf ~/.claude-remote
```
