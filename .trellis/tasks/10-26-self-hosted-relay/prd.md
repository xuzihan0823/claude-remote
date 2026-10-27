# 自建 relay 与多通道自动切换

## 背景

claude-remote 的 daemon 必须跑在用户自己的 Mac 上（读本机 `~/.claude/projects`、驱动本机 claude），手机要连到这台 Mac。目前只有 Tailscale / 局域网 / mDNS 三种地址，都要求手机和 Mac 在同一网络或同一 Tailscale 账号下。别人拿到仓库后，如果不想在手机上装 Tailscale，就没有办法用。

10-21 曾删除 `BRIDGE_PUBLIC_BASES` 与 Cloudflare 接入方式（见 PROGRESS.md）。本任务重新引入"公网地址"这条路，但改为用户自己部署、项目自带的 relay，不依赖第三方隧道服务。

## 目标

1. 仓库自带一个 relay 服务，用户有一台带公网 IP 的服务器就能在几分钟内搭好。
2. Mac 端用一条命令接入 relay，配对二维码自动带上 relay 地址。
3. 手机端把同一台 Mac 的直连地址（Tailscale / 局域网 / mDNS）和 relay 地址当作同一台设备的多个通道，自动选当前可用且最优的那个；网络变化后自动切换，不需要重新扫码或手动改地址。
4. 用户也可以手动指定某台设备"只走直连"或"只走 relay"。

## 需求

### R1 relay 服务

- 新增独立包 `packages/relay`，可单独运行，不依赖 daemon 的业务代码。
- relay 只做透明转发：手机发来的 HTTP 请求（含请求体与流式响应）和 WebSocket 连接，原样转给对应的 Mac，不解析业务内容。
- 一台 relay 可以同时服务多台 Mac，每台 Mac 有独立的设备 ID。
- Mac 主动连出到 relay，Mac 不需要公网 IP，也不需要开放入站端口。
- relay 不保存、也不需要知道 `BRIDGE_TOKEN`；手机请求里的 Bearer token 原样交给 daemon 校验。
- Mac 离线时，手机请求要快速得到明确的错误（而不是一直挂起）。

### R2 部署

relay 只面向"自己有服务器"的用户；没有服务器的用户走 Tailscale。

- 一行命令安装：在一台 Linux 服务器上执行一条 `curl … | sudo bash` 命令即可完成部署。脚本负责按需安装 Docker、拉取预构建镜像、启动 relay 与 Caddy（自动 HTTPS）、生成密钥，最后打印一行可以直接复制到 Mac 上执行的 `cr relay add …` 命令。
- 重复执行同一条命令即为升级，保留已有密钥与证书。
- relay 镜像预先构建并发布到 GHCR，支持 amd64 与 arm64，服务器上不需要 clone 仓库或编译。
- relay 无状态，部署不需要持久化存储卷。
- 不传域名时用服务器公网 IP 生成 sslip.io 域名自动签证书。
- 文档覆盖国内未备案服务器的情况（自有域名 + DNS 验证签证书 + 非 80/443 端口），安装脚本支持挂载已有证书文件。
- 另提供不用 Docker 的 systemd 单元样例，供已有反向代理的用户手动部署。

### R3 Mac 端接入

- `cr relay add <relay地址> <密钥>`：测试连通后写入配置并让 daemon 连上 relay。
- `cr relay status | on | off | remove`：查看状态、临时停用/启用、彻底移除。
- `cr status` 和 TUI 同时展示两类通道的状态（Tailscale 是否在线、relay 是否已连接）。
- 配对二维码在 relay 启用时自动包含 relay 地址，排在直连地址之后。
- daemon 断开 relay 后自动重连，不影响直连通道。

### R4 手机端多通道自动切换

- 同一台设备的所有候选地址并行探测，优先选直连；直连在短时间内不可达时用 relay。
- App 回到前台时重新选择通道；当前通道失效时自动换到其他可用通道。
- WebSocket 能发现"看似连着、实际已断"的连接（例如 Wi-Fi 切 4G），并自动重新选通道。
- 手机连上 daemon 后自动同步该设备的最新地址列表（例如 Mac 新加了 relay），不需要重新扫码。
- 设置 → 设备页显示当前走的是哪种通道，并可设置通道偏好：自动（默认）/ 只走直连 / 只走 relay。

### R5 安全

- 经 relay 到达的请求，`/api/pair-info` 与 `/api/pair-qr.svg` 必须拒绝（不能经 relay 拿到 token）。
- 设备 ID 不能被持有 relay 密钥的其他 Mac 抢占（否则抢占者能截获手机发出的 token）。
- relay 有基本的资源上限（并发流、请求体大小、空闲超时），单台设备异常不能拖垮整个 relay。
- 文档明确说明：relay 会在服务器上解开 TLS，会话内容对 relay 所在服务器可见；自建 relay 时这台服务器应当是用户自己可信的。

## 非目标

- 端到端加密（relay 看不到明文）：本期不做，作为后续产品化前的独立任务。
- 浏览器版 Web UI 经 relay 访问：本期只保证 iOS App；浏览器版继续按同源/直连使用。
- 官方托管的公共 relay、账号体系、计费。
- PaaS 平台一键部署按钮（Railway、Render、Zeabur 等）与 Cloudflare Workers 版 relay：没有服务器的用户使用 Tailscale。

## 验收标准

- [ ] 在一台全新的 Linux 服务器上，只执行一行安装命令，再在 Mac 上执行脚本打印出的 `cr relay add` 命令，手机 App 扫码后就能经 relay 正常使用：会话列表、打开会话、实时消息流、发送消息、附件上传、审批。
- [ ] 在同一台服务器上重复执行安装命令，relay 升级到新镜像，密钥不变，已接入的 Mac 自动重连。
- [ ] 手机在家（同 Wi-Fi 或 Tailscale 开着）走直连；关掉 Wi-Fi 和 Tailscale 后 10 秒内自动切到 relay 继续收消息；恢复后回到前台时切回直连。全程不需要手动操作。
- [ ] Mac 先只配了 Tailscale、手机已配对；之后执行 `cr relay add`，手机下次连上后设备记录里自动出现 relay 地址。
- [ ] 设置为"只走 relay"或"只走直连"时，探测和重连都只用对应通道。
- [ ] 经 relay 请求 `/api/pair-info` 得到 403；无 token 得到 401；Mac 离线时得到明确的"设备离线"错误。
- [ ] 第二台持有同一 relay 密钥、但没有设备私钥的 Mac 无法占用已注册的设备 ID。
- [ ] `cr relay off` 后 daemon 断开 relay，直连不受影响；`cr relay on` 后恢复。
- [ ] relay、daemon、cli、手机端相关新逻辑都有能发现错误实现的自动化测试；`pnpm test` 与 `pnpm typecheck` 通过。

## 待定问题

1. 通道偏好的默认值：本 PRD 假定"自动，直连优先"。
2. 一台 relay 多台 Mac 共用一个 relay 密钥（同一个人的多台 Mac）是否足够，还是需要按设备发不同的接入密钥？本 PRD 假定共用一个密钥，再用设备私钥防抢占。
