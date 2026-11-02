# Linux 服务器单机部署测试文档

## 目的

验证在一台 Linux 服务器上同时完成以下几件事：

1. 安装并登录 Claude Code CLI。
2. 用 `cr` 启动 daemon，daemon 能读取这台服务器上的 Claude 会话数据，也能从手机发起新的对话。
3. 同一台服务器上运行 relay，手机通过 relay 连到这台服务器上的 daemon。

不在本次范围内：开机自启（`cr up|down|restart` 的 launchd 部分只支持 macOS，Linux 上没有对应实现）、npm 安装形态、Tailscale 直连。

## 测试前须知

项目目前按 Mac 设计，daemon 代码本身不依赖 macOS，但从没在 Linux 上实际跑过。以下几点是读代码得出的已知情况，测试时留意：

- daemon 默认只监听 `127.0.0.1:8787`，不对公网开放；手机只能经 relay 访问。
- 随 `cr` 运行的 daemon 会在 `cr` 收到 SIGHUP 时一起退出，SSH 断开就会停。所以 `cr` 必须放在 tmux 里运行。
- relay 的接入地址同时也是手机访问的地址。daemon 和 relay 在同一台机器上时，daemon 要从服务器内部访问自己的公网地址（回环访问），部分云厂商的网络不支持，第 3 步专门检查这一点。
- daemon 日志固定写在 `~/Library/Logs/claude-remote/daemon.log`，Linux 上也是这个路径。
- 没有读权限的文件：手机能看到文件卡片，但取内容时连接会中断，不会给出明确错误。这是已知问题，第 7 步记录现象即可。

## 占位符

| 占位符 | 含义 |
|---|---|
| `<RELAY_HOST>` | relay 的公网地址（IP 或域名），不带协议 |
| `<RELAY_SECRET>` | relay 安装脚本最后打印的接入密钥 |
| `<TEST_USER>` | 运行 Claude 和 daemon 的普通用户，不要用 root |
| `<TOKEN>` | 仓库 `.env` 里的 `BRIDGE_TOKEN` |

## 环境要求

- Debian / Ubuntu，amd64 或 arm64。
- Node.js ≥ 22.5（daemon 用到 `node:sqlite`），git，tmux，curl。
- 安全组放行 TCP 443；使用 IP 证书时还要放行 TCP 80。8787 不要放行。
- 服务器上 443、80 端口没有被其他程序占用；被占用时安装 relay 用 `--https-port` 换端口。

## 结果记录

每一项填“通过 / 失败 / 跳过”，失败时把命令输出贴在备注里。

| 编号 | 检查项 | 结果 | 备注 |
|---|---|---|---|
| 1.1 | 普通用户存在，Node 和 pnpm 版本符合要求 | | |
| 2.1 | `claude --version` 有输出 | | |
| 2.2 | 非交互调用能返回回答，生成会话记录 | | |
| 3.1 | relay 两个容器都在运行 | | |
| 3.2 | 服务器本机能通过公网地址访问 relay | | |
| 4.1 | `cr setup` 找到 claude 和会话记录 | | |
| 5.1 | tmux 里运行 `cr`，daemon 健康检查通过 | | |
| 5.2 | daemon 只监听 127.0.0.1 | | |
| 5.3 | 带 token 能列出会话，不带 token 返回 401 | | |
| 5.4 | 断开 SSH 后 daemon 仍在运行 | | |
| 6.1 | `cr relay add` 后显示已连接和手机地址 | | |
| 6.2 | 公网经 relay 访问 daemon 正常，配对接口被拒绝 | | |
| 7.1 | 手机扫码配对成功，走 relay 通道 | | |
| 7.2 | 手机能看到服务器上的历史会话 | | |
| 7.3 | 手机发消息，服务器上的 claude 正常回复 | | |
| 7.4 | 工具审批能在手机上弹出并生效 | | |
| 7.5 | 文件卡片：工作目录内、目录外、无权限、敏感文件 | | |
| 8.1 | 重启 relay 容器后 daemon 自动重连 | | |
| 8.2 | 在 `cr` 里按 `r` 重启 daemon 后手机自动恢复 | | |
| 8.3 | 连续运行 24 小时后仍可用 | | |

## 1. 准备环境

以 root 创建普通用户（已有可跳过）：

```bash
adduser <TEST_USER>
```

切到这个用户，之后除第 3 步外都用它操作：

```bash
su - <TEST_USER>
```

```bash
node --version && corepack enable --install-directory ~/.local/bin && pnpm --version
```

**1.1 预期**：Node 版本 ≥ 22.5，pnpm 能输出版本号。`~/.local/bin` 不在 PATH 里时，在 `~/.bashrc` 加 `export PATH="$HOME/.local/bin:$PATH"` 后重新登录。

## 2. 安装 Claude Code CLI

用 `<TEST_USER>` 按官方文档安装 Claude Code，然后登录：

```bash
claude
```

服务器没有浏览器，登录时把终端打印的链接复制到本地浏览器完成授权，再把授权码粘回终端。使用 API key 的话，改为在 `~/.bashrc` 里设置 `ANTHROPIC_API_KEY`。

```bash
claude --version
```

**2.1 预期**：输出版本号。

建一个测试目录，非交互地跑一次，生成会话记录：

```bash
mkdir -p ~/cr-test && cd ~/cr-test && echo "hello from server" > note.txt && claude -p "读一下 note.txt，回答里面写了什么"
```

```bash
ls ~/.claude/projects/
```

**2.2 预期**：回答里包含 `hello from server`；`~/.claude/projects/` 下出现以测试目录路径命名的子目录，里面有 `.jsonl` 文件。

## 3. 部署 relay

用 root 执行（脚本会安装 Docker 并启动 relay 和 Caddy）：

```bash
curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash
```

记下脚本最后打印的 `cr relay add https://<RELAY_HOST> <RELAY_SECRET>`。

```bash
cd /opt/claude-remote-relay && sudo docker compose ps
```

**3.1 预期**：`relay` 和 `caddy` 都是 running。

在服务器本机通过公网地址访问 relay：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<RELAY_HOST>/
```

**3.2 预期**：输出一个 HTTP 状态码（比如 404），没有证书错误或超时。这一步失败说明服务器无法访问自己的公网地址，daemon 将无法接入同机的 relay，需要先解决再继续。

## 4. 安装并初始化 claude-remote

回到 `<TEST_USER>`：

```bash
cd ~ && git clone https://github.com/xuzihan0823/claude-remote.git && cd claude-remote && pnpm install
```

```bash
node packages/cli/bin/cr.mjs setup
```

**4.1 预期**输出依次包含：

- `已生成访问 token，写入 .env`
- `✓ claude <版本>  <路径>`（没找到时用 `cr config set claude <绝对路径>` 指定）
- `✓ 发现 N 个项目的 Claude Code 会话记录`，N ≥ 1
- `~/.local/bin/cr → …` 软链
- `daemon 随 cr 启停`

```bash
cr --version
```

能输出 `cr 0.1.0` 即软链可用。

## 5. 用 cr 启动 daemon

在 tmux 里打开 `cr`：

```bash
tmux new -s cr
```

```bash
cr
```

`cr` 会进入全屏控制台并拉起 daemon。按 `Ctrl-b` 再按 `d` 离开 tmux，保持它在后台运行。以下检查在另一个 SSH 窗口里做，除配对接口外所有接口都要带 token：

```bash
TOKEN=$(grep '^BRIDGE_TOKEN=' ~/claude-remote/.env | cut -d= -f2-)
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/health
```

**5.1 预期**：返回 `ok: true`，`claudeCliVersion` 是第 2 步的版本，`hostname` 是这台服务器。

```bash
ss -ltnp | grep 8787
```

**5.2 预期**：只出现 `127.0.0.1:8787`，没有 `0.0.0.0:8787` 或 `*:8787`。

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/sessions | head -c 600; echo
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/api/sessions
```

```bash
cr ls
```

**5.3 预期**：带 token 的请求返回会话列表，包含第 2 步在 `~/cr-test` 产生的会话；不带 token 的返回 `401`；`cr ls` 列出同一个会话。

断开所有 SSH 连接，等一分钟后重新登录，重新取一次 `TOKEN` 后：

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/health
```

**5.4 预期**：仍然返回 `ok: true`。如果 daemon 停了，说明 `cr` 没在 tmux 里运行。

## 6. 接入同机的 relay

用 `<TEST_USER>` 执行第 3 步记下的命令：

```bash
cr relay add https://<RELAY_HOST> <RELAY_SECRET>
```

daemon 随 `cr` 运行时，这条命令只保存配置。回到 tmux（`tmux attach -t cr`），在 `cr` 里按 `r` 重启 daemon，再离开 tmux：

```bash
cr relay status
```

**6.1 预期**：状态为已连接，并显示 `手机地址 https://<RELAY_HOST>/d/<设备 ID>`。

在本地电脑（不是服务器）上通过 relay 访问：

```bash
curl -s -H "Authorization: Bearer <TOKEN>" https://<RELAY_HOST>/d/<设备 ID>/api/health
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<RELAY_HOST>/d/<设备 ID>/api/pair-info
```

**6.2 预期**：健康检查返回 `ok: true`；`/api/pair-info` 返回 `403`（配对接口不允许经 relay 访问）。

## 7. 手机端

在 `cr` 里按 `p`，或在另一个窗口运行：

```bash
cr pair
```

用 App 扫描终端里的二维码。

**7.1 预期**：配对成功进入首页。二维码里除了 relay 地址，还有一个 `http://<主机名>.local:8787` 直连地址，手机访问不到，App 应自动选用 relay 地址；设置 → 设备里能看到这台服务器的主机名。

**7.2 预期**：首页能看到 `~/cr-test` 项目和第 2 步的会话，点开能看到完整的问答历史。

**7.3** 在这个会话里发：“在当前目录新建 hello.md，写一句问候”。**预期**：手机实时显示输出，服务器上 `~/cr-test/hello.md` 被创建。

**7.4** 权限模式选需要审批的模式，再让它执行一条 Bash 命令（比如 `ls ~`）。**预期**：手机弹出审批，批准后执行，拒绝后不执行。

**7.5** 文件卡片。分别让 Claude 在回复里给出下面几个文件的完整路径，点开文件卡片：

| 文件 | 准备方式 | 预期 |
|---|---|---|
| `~/cr-test/hello.md` | 7.3 已生成 | 正常预览 |
| `/etc/os-release` | 系统自带 | 正常预览（工作目录外的文件可读） |
| `~/.ssh/config` 或任意 `.env` | 已有或手动创建 | 提示敏感文件不能查看 |
| `/root/.bashrc` | 系统自带 | 无法读取（上级目录没有权限，目前显示“文件不存在”） |
| 无读权限的文件 | root 执行 `install -m 600 /dev/null /tmp/cr-noread.txt` | 已知问题：卡片能打开，内容加载失败。记录手机上的实际表现 |

## 8. 稳定性

```bash
cd /opt/claude-remote-relay && sudo docker compose restart
```

**8.1 预期**：一分钟内 `cr relay status` 恢复为已连接，手机无需操作即可继续使用。

**8.2** 在 `cr` 里按 `r` 重启 daemon。**预期**：手机短暂断开后自动重连，正在看的会话能继续收到消息。

**8.3** 保持运行 24 小时，期间不登录服务器。**预期**：手机仍能连接并发消息；`~/Library/Logs/claude-remote/daemon.log` 没有反复出现的报错。

## 清理

```bash
tmux kill-session -t cr
```

```bash
cd /opt/claude-remote-relay && sudo docker compose down -v && sudo rm -rf /opt/claude-remote-relay
```

```bash
rm -rf ~/claude-remote ~/cr-test ~/.local/bin/cr ~/.claude-remote ~/Library/Logs/claude-remote
```

手机上在设置 → 设备里删除这台服务器。
