# cr：Mac 端命令行控制台

`cr` 取代了原来的 SwiftUI 菜单栏 App（`mac/` 已删除）。daemon 由 launchd 常驻，`cr` 负责安装、启停、观察和日常操作。

## 安装

两种形态，`cr` 会自动识别：

| | npm 安装（给其他人用） | 源码运行（开发） |
|---|---|---|
| 安装 | `npm i -g @anyu/claude-remote` | `pnpm install && node packages/cli/bin/cr.mjs setup` |
| 配置 | `~/.claude-remote/config.env` | 仓库根目录 `.env` |
| 数据 | `~/.claude-remote/.data/`、`~/.claude-remote/uploads` | 仓库 `.data/` |
| launchd 启动 | `node <包>/dist/daemon.js`（PATH 显式包含 node 与 claude 目录） | `zsh -l scripts/launchd/run-daemon.sh` → tsx |

`setup` 幂等，可重复运行；npm 安装后**第一次运行 `cr` 会自动执行**：

1. **token**：已有 `BRIDGE_TOKEN` 就沿用；没有但 Keychain 里有旧菜单栏 App 存的 token（service `claude-remote` / account `bridge-token`），就迁移进配置，**已配对的手机不用重配**；都没有就生成新的（配置文件权限 0600）。
2. **找 claude**：依次查当前 PATH、登录 shell（`$SHELL -ilc 'command -v claude'`，覆盖 nvm/fnm 配在 .zshrc 里的情况）、官方安装器 `~/.claude/local`、`~/.local/bin`、Homebrew、`npm prefix -g`、bun、volta、nvm/fnm 各版本目录。找到的绝对路径写进 `CLAUDE_BIN`：daemon 用它驱动会话（Agent SDK 的 `pathToClaudeCodeExecutable`），`cr open` 用它接管。已配置且仍可执行就沿用。同时报告 `~/.claude/projects` 里有多少项目的会话。
3. **PATH**（仅源码运行）：把 `~/.local/bin/cr` 软链到 `packages/cli/bin/cr.mjs`。
4. **launchd**：写 `~/Library/LaunchAgents/com.claude-remote.daemon.plist` 并启动，等待 `/api/health` 响应。Label 与旧 `install.sh` 相同，旧安装直接被接管。

换了 Node 版本或重装 claude 后重新运行 `cr setup` 即可（plist 内容有变化会自动重载）。

### 发布 npm 包

```sh
pnpm build:npm                # 输出 dist/npm（esbuild 打包 cli/daemon，web 静态资源一并带上）
cd dist/npm && npm publish --access public
```

workspace 包打进 bundle，第三方依赖（ink、react、ws、qrcode、Agent SDK）保持 external 作为 dependencies。
包名默认 `@anyu/claude-remote`，可用 `--name` 或 `NPM_NAME` 覆盖（npm 包名只能小写，scope 必须是自己的 npm 用户名或组织）。

## 全屏控制台

直接运行 `cr`（需要 TTY）。界面用 Ink（React for CLI）绘制，与 Claude Code 同一技术栈。

| 区域 | 内容 |
|---|---|
| 顶栏 | daemon 运行状态与时长、访问地址、claude 版本；边框绿=正常、红=未运行 |
| 审批横幅 | 有待审批时黄色常驻，并响铃一次 |
| 搜索框 | `/` 聚焦，`Tab` 切换「标题/路径」⇄「全文」；全文命中会在标题后显示 `↳ 片段` |
| 会话列表 | 状态图标：`●` daemon 运行中、`◐` 终端在用、`○` 空闲 |
| 预览 | 选中会话最近的消息，实时更新 |

快捷键：

| 键 | 作用 |
|---|---|
| `↑↓` / `j k` | 选择会话 |
| `Enter` | 会话视图：实时旁观 + 底部输入框回复。经 daemon 发送，手机端同步可见；会话非空闲时不能发 |
| `o` | 在当前终端 `claude --resume` 接管（仅空闲会话），claude 退出后回到 cr |
| `a` | 待审批：`y` 允许一次、`n` 拒绝；AskUserQuestion 用数字键选项 |
| `p` / `w` / `l` | 配对二维码 / 浏览器打开 Web（token 复制到剪贴板）/ 日志 |
| `s` / `r` | 启停 daemon / 重启 |
| `?` / `q` | 帮助 / 退出 |

会话视图内：`Esc` 返回、`Ctrl+O` 本地接管、`Ctrl+X` 中止当前轮次。

**为什么运行中的会话不能 `o`**：手机或 daemon 正在驱动时，本地再 `claude --resume` 会让两个进程同时往同一个 JSONL 追加，产生分叉。此时只能旁观，等它空闲。`cr open <id> --force` 可强行接管。

## 子命令

```
cr setup                 首次安装（见上）
cr up | down | restart   启动（并开机自启）/ 停止（并取消自启，跨登录保持）/ 重启
cr uninstall             移除 launchd 服务（不删数据）
cr status                daemon、launchd、地址、会话与待审批数量；daemon 不通时退出码 1
cr logs                  tail -F ~/Library/Logs/claude-remote/daemon.log
cr pair                  终端二维码 + 候选地址（本地生成，不依赖 daemon 在跑）
cr web                   打开 Web 界面
cr ls [-n 20]            最近会话
cr search <词> [--full]  默认搜标题/项目路径/最后一条消息；--full 连对话全文
cr show <id>             最近 20 条消息（id 写前缀即可）
cr open <id> [--force]   claude --resume 接管
```

## 配置

全部沿用仓库 `.env`（见 `.env.example`）：

- `BRIDGE_TOKEN`：优先级 环境变量 > `.env` > Keychain（兼容旧安装）。
- `BRIDGE_PORT` / `BRIDGE_HOST`：`cr` 访问 `http://127.0.0.1:<port>`；若 `BRIDGE_HOST` 绑定的是具体 IP（如 Tailscale IP），改为直连该 IP。
- `CLAUDE_BIN`：`cr open` 与 daemon 使用的 claude 路径；launchd 下由 `run-daemon.sh` 自动探测。
- `CLAUDE_REMOTE_REPO`：仓库位置（默认按 `cr.mjs` 所在位置推断）。

## 从菜单栏 App 迁移

1. 退出菜单栏 App，在「系统设置 → 通用 → 登录项」里移除它，删掉 `ClaudeRemote.app`。
2. `git pull && pnpm install && node packages/cli/bin/cr.mjs setup`。
3. `cr status` 确认运行；手机端无需重新配对（token 已迁移）。

旧的 `scripts/launchd/install.sh` 已删除，对应关系：`install`→`cr up`，`uninstall`→`cr uninstall`，`restart`→`cr restart`，`status`→`cr status`，`logs`→`cr logs`。

## 开发

```sh
cd packages/cli
npx tsc --noEmit
npx tsx --test __tests__/*.test.ts __tests__/*.test.tsx
```

TUI 测试用 `ink-testing-library` 注入假依赖（`src/tui/deps.ts` 的 `TuiDeps`），不需要真 daemon。

## 配置

`cr` 里按 `c` 打开设置页，或用 `cr config`：

```sh
cr config                      # 列出全部配置（未设置的显示默认值）
cr config set host 0.0.0.0     # 允许局域网 / Tailscale 的手机直连
cr config set port 8790
cr config set bark https://api.day.app/<key>
cr config set timeout 600      # 审批超时，单位秒
cr config unset bark           # 恢复默认
cr config reset-token          # 生成新 token，已配对设备全部失效
```

| 项 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| host | BRIDGE_HOST | 127.0.0.1 | 监听地址 |
| port | BRIDGE_PORT | 8787 | 端口 |
| bark | BARK_URL | 不推送 | Bark 推送地址 |
| ntfy | NTFY_URL | 不推送 | ntfy 推送地址 |
| timeout | PERMISSION_TIMEOUT_MS | 300 秒 | 审批超时自动拒绝（输入/显示为秒） |
| cooldown | ACTIVITY_COOLDOWN_MS | 120 秒 | 终端会话静默多久算空闲 |
| claude | CLAUDE_BIN | PATH | `cr open` / `o` 接管用的 claude |
| uploads | UPLOADS_DIR | ~/.claude-remote/uploads | 手机上传附件目录 |

配置写入仓库根目录 `.env`（权限 600）。daemon 在 launchd 下运行时，保存后会自动重启生效（claude 路径只影响 cr，不重启）；
改地址、端口或 token 后 TUI 会用新参数重新连接，重置 token 后直接显示新的配对二维码。加 `--no-restart` 只写不重启。
