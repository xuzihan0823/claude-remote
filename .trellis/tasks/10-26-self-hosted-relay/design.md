# 技术设计：自建 relay 与多通道自动切换

需求见 `prd.md`。本文件记录边界、协议、数据流与取舍。现状核对见 `research/current-state.md`。

## 1. 总体结构

```
手机 App ──https──▶ relay（公网服务器）◀──wss 出站长连接── daemon 内置 connector ──http/ws 回环──▶ daemon 本体
   │                                                                                          ▲
   └──────────────── 直连（Tailscale / 局域网 / mDNS）───────────────────────────────────────────┘
```

- relay 是一个"HTTP/WS over WebSocket"的透明隧道，不认识任何业务接口。
- daemon 新增 connector 模块：主动连 relay，把 relay 转来的请求在本机回环重放给 daemon 自己的 HTTP 端口。daemon 的业务路由、鉴权、WS 逻辑一行不改。
- 手机把 relay 地址当成和直连地址平级的一个 base，`api()` 与 `wsEndpoint()` 已支持带路径前缀的 base（`web/core/api.js`），业务代码无需感知通道。

选择"回环重放"而不是在进程内直接调用请求处理函数：回环重放能原样复用 daemon 的 HTTP 解析、上传流、WS upgrade 与鉴权，connector 与 server 之间只有 HTTP 这一条已有契约，耦合最小。代价是每个请求多一次本机 TCP，开销可以忽略。

## 2. relay 服务（`packages/relay`）

### 2.1 对外路由

| 路径 | 用途 | 鉴权 |
|---|---|---|
| `GET /healthz` | 存活检查，返回 `{"ok":true,"version":"…"}` | 无 |
| `GET /agent`（WS upgrade） | daemon connector 接入 | `Authorization: Bearer <RELAY_SECRET>` + `X-Device-Id` + `X-Device-Key` |
| `/d/<deviceId>/*`（HTTP） | 手机 HTTP 请求，去掉 `/d/<deviceId>` 前缀后转发 | relay 不鉴权，Bearer 原样交给 daemon |
| `/d/<deviceId>/ws`（WS upgrade） | 手机 WebSocket | 同上，`?token=` 原样交给 daemon |

其他路径一律 404。设备离线时 `/d/<id>/*` 返回 `503 {"error":"device_offline"}`，WS upgrade 直接以 503 拒绝。

### 2.2 设备身份与防抢占

- 设备私钥：32 字节随机数（base64url），由 `cr relay add` 在 Mac 本地生成，只存在 Mac 配置里。
- 设备 ID 由私钥派生：`deviceId = base32小写(sha256("claude-remote-relay/v1:" + 私钥))` 取前 20 位。
- relay 接入时只校验 `X-Device-Id` 是否等于由 `X-Device-Key` 算出的值，不一致返回 `403 device_key_mismatch`。relay 不保存任何设备信息，因此是无状态的：重启、迁移、重新部署都不需要持久化存储，也不会丢失设备绑定。
- 同一设备 ID 已有在线连接时，新的合法连接替换旧连接（Mac 网络抖动重连的常见情况），旧连接以 close code 4001 关闭，旧连接上的进行中请求全部 reset。
- 为什么需要私钥：只靠共用的 `RELAY_SECRET`，另一台拿到密钥的机器就能占用别人的设备 ID，手机发出的请求（含 Bearer token）就会落到抢占者手里。设备 ID 由私钥派生后，没有私钥就无法接入该 ID。
- 换私钥等于换设备 ID：手机上的 relay 地址随之改变，需要经直连同步（`connect-info`）或重新扫码。`cr relay add` 因此复用已有私钥，只有 `cr relay remove` 才清除它。

### 2.3 隧道帧格式

一条 agent WS 上多路复用多个流（stream），每个手机请求或手机 WS 连接是一个流，流 ID（`sid`）由 relay 分配的 u32 递增数。

控制帧用 JSON 文本帧：

| 方向 | 帧 | 含义 |
|---|---|---|
| relay→agent | `{"t":"open","sid","kind":"http","method","path","headers","remote"}` | 新 HTTP 请求；`path` 已去前缀、含 query；`remote` 为手机来源 IP |
| relay→agent | `{"t":"open","sid","kind":"ws","path","headers","remote"}` | 新 WS 连接 |
| agent→relay | `{"t":"head","sid","status","headers"}` | HTTP 响应头；对 `kind:"ws"` 表示拒绝 upgrade（如 401） |
| agent→relay | `{"t":"accept","sid"}` | WS upgrade 成功 |
| 双向 | `{"t":"end","sid"}` | 本方向数据结束（HTTP 请求体/响应体发完） |
| 双向 | `{"t":"wsclose","sid","code","reason"}` | WS 关闭 |
| 双向 | `{"t":"reset","sid","reason"}` | 异常中止，对端立即释放该流 |
| 双向 | `{"t":"credit","sid","bytes"}` | 流控：允许对端再发送这么多字节 |

数据帧用二进制帧：`[u8 type][u32 sid 大端][payload]`，type `1`=HTTP 体数据，`2`=WS 文本消息，`3`=WS 二进制消息。

帧编解码放在 `packages/relay/src/protocol.ts`，同时作为包导出（`@claude-remote/relay/protocol`）供 daemon connector 复用，保证两端只有一份实现。

### 2.4 流控与资源上限

- 每个流每个方向初始窗口 256 KiB；接收方把数据写进下游 socket 且 drain 后回 `credit`。发送方窗口耗尽即暂停读取上游（对 HTTP 是 `pause()` 手机请求流，对 connector 是暂停读 daemon 响应）。这样大附件上传、大响应、慢速手机都不会让 relay 内存无限增长，一个慢流也不会阻塞同连接上的其他流。
- 每台设备并发流上限 `RELAY_MAX_STREAMS`（默认 64），超出返回 `503 too_many_streams`。
- 单个 HTTP 请求体上限 `RELAY_MAX_BODY_MB`（默认与 daemon 上传上限对齐，实现时从 `server.ts` 上传逻辑确认），超出 413。
- relay 等待 `head` 超过 30 秒返回 504；HTTP 流 120 秒无任何数据则 reset。WS 流不设空闲超时（由两端心跳负责）。
- agent 连接心跳：relay 每 20 秒发 WS ping，两个周期无 pong 即断开并 reset 全部流；connector 侧同样检测。

### 2.5 配置（环境变量）

`RELAY_SECRET`（必填，至少 32 字符，缺失或过短拒绝启动）、`RELAY_HOST`（默认 `127.0.0.1`，Docker 内设为 `0.0.0.0`）、`RELAY_PORT`（默认 8790）、`RELAY_MAX_STREAMS`、`RELAY_MAX_BODY_MB`。relay 无状态，没有数据目录。

### 2.6 日志

只记录连接事件和请求摘要（设备 ID、方法、去掉 query 的路径、状态码、耗时）。**禁止记录 query**（WS 的 `?token=` 在 query 里）、请求头和请求体。

## 3. daemon 侧改动

### 3.1 connector（`packages/daemon/src/relay/connector.ts`）

- 配置来自环境变量：`RELAY_URL`、`RELAY_SECRET`、`RELAY_DEVICE_ID`、`RELAY_DEVICE_KEY`、`RELAY_ENABLED`（`on`/`off`，默认 `on`）。四个必需值缺任一或 `RELAY_ENABLED=off` 时 connector 不启动，状态 `disabled`。值不合法（如 URL 非 http(s)）按 `config.ts` 现有约定抛 `ConfigError` 拒绝启动。
- `server.listen()` 之后启动，回放目标为 daemon 实际监听地址；监听在 `0.0.0.0`/`::` 时用 `127.0.0.1`。
- 处理 `open`（http）：
  - 路径是 `/api/pair-info` 或 `/api/pair-qr.svg` → 直接回 `403 {"error":"loopback_only"}`，不进 daemon（纵深防御）。
  - 其余：过滤 hop-by-hop 头，`Host` 改为本机地址，追加 `X-Forwarded-For: <remote>`、`X-Forwarded-Proto: https`、`X-Forwarded-Host`。这些头保证即使上面的路径判断被绕过，`looksProxied()` 也会让配对端点 403。
- 处理 `open`（ws）：连 `ws://<本机>/ws?<原 query>`，带同样的转发头；成功回 `accept`，被拒回 `head`（状态码取 daemon 的响应）。
- 重连：指数退避 1 秒到 30 秒加随机抖动；relay 返回 401/403（密钥错、私钥不匹配）时状态记为 `error:auth`，退避上限提到 5 分钟，避免狂打。
- 对外暴露只读状态：`{ state: "disabled"|"connecting"|"connected"|"error", error?: string, base?: string, since: number }`，`base` 为 `${RELAY_URL}/d/${RELAY_DEVICE_ID}`。
- daemon 停止时 connector 先关闭（发 close，reset 进行中流）。

### 3.2 新接口与改动

- `GET /api/connect-info`（需 Bearer）：`{ "bases": string[], "relay": <connector 状态> }`。`bases` = `enumeratePairBases()` 的直连地址 + relay 启用时的 relay base（排在最后）。不包含 token。手机用它同步地址，`cr status` 用它展示通道。
- `pairInfo` / 配对二维码：relay 启用时在直连地址后追加 relay base。payload 格式不变（`bases` 逗号分隔、逐个 URL 编码），旧版 App 也能解析。
- WS 应用层心跳：客户端发 `{"type":"ping"}`，daemon 立即回 `{"type":"pong"}`。`#onClientFrame` 目前在缺 `sessionId` 时直接返回，ping 必须在该判断之前处理。daemon 现有的协议层 ping（`#pingClients`）保留不动；RN 的 WebSocket 看不到协议层 ping，所以客户端需要应用层心跳才能发现半开连接。
- `docs/api-contract.md` 同步：新接口、pong 帧、relay 相关环境变量。

## 4. Mac 端 `cr`

- 新子命令 `cr relay`（`packages/cli/src/relay.ts`，在 `main.tsx` 分发）：
  - `add <url> <secret>`：校验 URL（必须 https；`http://localhost`/`127.0.0.1` 仅用于本地测试）→ `GET <url>/healthz` → 没有设备私钥则生成并派生设备 ID，已有则复用 → 写入 `RELAY_*` 到配置文件（已是 0600）→ 重启 daemon → 轮询 `/api/connect-info` 最多 15 秒，打印"已连接"或具体错误（密钥错误、连不上 relay）。
  - `status`：打印 connector 状态和 relay base。
  - `on` / `off`：改 `RELAY_ENABLED` 并重启 daemon。
  - `remove`：删除全部 `RELAY_*`（含设备私钥）并重启。
- `cr status`：在现有输出里加"通道"一节：Tailscale 地址是否存在（来自 `bases` 是否含 100.64/10 地址）、relay 状态。
- TUI 设置页：只读显示 relay 状态一行（不在 TUI 里做增删，避免在全屏界面里输入密钥）。
- `RELAY_*` 不加进 `cr config` 的通用配置表（`config.ts` 的 `ConfigKey`），由 `cr relay` 专门管理，避免用户手改出半配置状态。

## 5. 手机端多通道

### 5.1 通道识别

base 的路径匹配 `/d/<deviceId>` 即为 relay，否则为直连。直连内部再按地址区分 Tailscale（100.64.0.0/10）、局域网、mDNS，只用于展示。识别函数放在 `web/core/devices.js`，纯函数、可单测。

### 5.2 设备记录扩展（`web/core/devices.js`）

- 新增字段 `channelPref: "auto"|"direct"|"relay"`（缺省视为 `auto`）、`manualBases: string[]`（用户在"添加设备"里手填的地址）。
- `candidateBases(d)` 按偏好过滤：`direct` 只留直连，`relay` 只留 relay，`auto` 全部保留。
- 新增 `syncBases(id, daemonBases)`：`bases = uniq([...daemonBases, ...manualBases])`，daemon 报告的列表是权威来源（Mac 换了局域网 IP 后旧 IP 会被淘汰），手填地址永远保留。`lastBase` 不在新列表里时清空。
- 旧记录无新字段时按缺省处理，不需要迁移。

### 5.3 并行探测（`web/core/api.js`）

`probeBases(bases, tok)` 改为并行：

1. 所有候选同时发 `/api/health`。
2. 任一直连成功 → 立即采用。
3. relay 先成功 → 再等最多 1.5 秒（`DIRECT_GRACE_MS`），期间有直连成功则用直连，否则用 relay。
4. 任一返回 401 → 立即抛 `unauthorized`（token 错与通道无关）。
5. 全部失败 → 抛最后一个错误。决定后中止其余未完成请求。

单个探测超时仍为 8 秒，但并行后最坏总等待从"候选数 × 8 秒"降为 8 秒。探测逻辑写成可注入 `fetch` 与计时器的纯函数，便于用假时钟测试上面每条规则。

### 5.4 自动重选（`app/src/App.js` + `web/core/ws.js`）

- App 新增 `reselect()`：对当前设备 `candidateBases` 跑一次 `probeBases`；结果与当前 base 相同则只 `ws.reconnectNow()`，不同则 `saveConn` 并重启 ws（不重挂导航、不清缓存）。
- 触发时机：App 回到前台（替换现在只 `reconnectNow()` 的逻辑）；ws 报告 `reselect` 事件。
- `ws.js`：
  - 连上后每 10 秒发 `{"type":"ping"}`；5 秒内没有收到任何消息（含 pong）判定半开，主动关闭。已打开的连接意外断开时立即重选通道（实现时为满足"10 秒内切换"验收而收紧）。
  - 兼容旧 daemon：只有收到过至少一次 `pong` 后才启用半开判定，避免旧 daemon 不回 pong 被误判。
  - 连续 2 次连接失败或一次半开 → `bus.emit('ws-reselect')`，由 App 调 `reselect()`；重选期间暂停自身退避重试，重选结束后由 App 重启 ws。
- 连上 daemon 后（`tryConnectBases` 成功路径）异步调 `/api/connect-info`，成功则 `syncBases`；404（旧 daemon）静默忽略。

### 5.5 界面

- 设置 → 设备详情：显示当前通道（"直连 · Tailscale"/"直连 · 局域网"/"relay"）和通道偏好三选一。改偏好后立即 `reselect()`。
- 首页不加常驻状态指示（保持现有精简）；`connErrMsg` 的超时文案从"检查 Tailscale"改为同时提示 relay。

## 6. 部署（`deploy/relay/`）

只面向自己有 Linux 服务器的用户，目标是"一行命令装好"。没有服务器的用户走 Tailscale，不提供 PaaS 部署按钮或 Workers 版本。

### 6.1 一行安装

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/deploy/relay/install.sh | sudo bash -s -- --domain relay.example.com
```

`install.sh` 参数：`--domain`（可省略）、`--https-port`（默认 443）、`--cert <fullchain> --key <key>`（使用已有证书，不自动申请）、`--version <tag>`（默认 `latest`）。全部可省略；在交互终端下缺失的值会提示输入，通过管道执行时使用默认值。

脚本步骤：

1. 检查 root、架构（amd64/arm64）、系统（以 Debian/Ubuntu 为主要验证目标，其它发行版尽力而为）。
2. 未安装 Docker 时用 Docker 官方安装脚本安装。
3. 安装目录固定为 `/opt/claude-remote-relay/`：写入 `docker-compose.yml`、`Caddyfile`、`.env`（0600）。`.env` 已存在时保留其中的 `RELAY_SECRET`，只更新传入的参数——这就是重复执行即升级的基础。
4. 未给 `--domain` 时探测公网 IP，生成 `<ip 用横线连接>.sslip.io`。
5. `docker compose pull && docker compose up -d`。
6. 等待 `https://<域名>:<端口>/healthz` 成功（含证书签发），超时则打印 `docker compose logs` 的排查提示。
7. 打印接入命令：`cr relay add https://<域名>[:端口] <RELAY_SECRET>`。

安装脚本不读取、不上传任何用户数据；生成的密钥只写本机 `.env` 并打印在终端。

### 6.2 镜像

- `deploy/relay/Dockerfile`：多阶段，pnpm 安装 → esbuild 把 `packages/relay` 打成单文件 → `node:22-alpine` 运行，非 root 用户，无数据卷。
- GitHub Actions（`.github/workflows/relay-image.yml`）：打 `relay-v*` 标签或手动触发时用 buildx 构建 amd64 + arm64，推送 `ghcr.io/<owner>/claude-remote-relay:<版本>` 与 `latest`。镜像设为公开，用户拉取无需登录。
- compose 中镜像名由 `.env` 的 `RELAY_IMAGE` 决定，便于 fork 的人改成自己的镜像。

### 6.3 compose 与 Caddy

- `docker-compose.yml`：`relay` + `caddy` 两个服务；Caddy 数据卷只用于保存证书（避免每次重启重新签发触发速率限制），relay 本身无状态。
- `Caddyfile` 读 `RELAY_DOMAIN`、`RELAY_HTTPS_PORT`，反代到 `relay:8790`。TLS 两种来源：自动申请（默认，需要 80 或 443 端口可从公网访问）；或挂载 `--cert/--key` 提供的证书文件。Caddy 默认处理 WS；安全性不依赖反代配置（connector 自己加转发头并拦配对路径）。

### 6.4 文档与手动部署

- `deploy/relay/README.md`：一行安装、升级（重复执行）、卸载、端口与云厂商安全组、国内未备案服务器（acme.sh DNS 验证签证书 → `--cert/--key` + 非 443 端口）、sslip.io 的适用范围、明文可见性说明、密钥轮换。
- `relay.service`：不用 Docker 时的 systemd 单元样例（专用用户、`Restart=always`、`MemoryMax`），配合用户已有的反向代理。
- 根 `README.md` 增加"接入方式"一节：没有服务器用 Tailscale，有服务器用一行命令装 relay，两者可同时启用。

## 7. 安全小结

| 风险 | 处理 |
|---|---|
| 经 relay 读取配对端点拿 token | connector 直接拦截配对路径 + 转发头触发 `looksProxied()`，两层 |
| 设备 ID 被抢占截获 token | 设备 ID 由设备私钥派生，relay 每次接入校验 |
| 一行安装脚本被篡改 | 脚本只从仓库 main 分支获取；README 同时给出"先下载、阅读、再执行"的两步写法 |
| relay 密钥泄露 | 只能注册新设备 ID，无法读取现有设备流量；文档说明轮换方法（改 `.env` 重启 + 各 Mac `cr relay add` 重新写入） |
| relay 运营方可见明文 | 自建前提下接受；PRD 非目标中记录端到端加密为后续任务 |
| 日志泄露 token | relay 日志禁止记录 query 与请求头 |
| 资源耗尽 | 并发流、请求体、空闲超时、流控窗口 |

## 8. 兼容性与回滚

- relay 默认关闭：没有 `RELAY_*` 配置时 daemon 行为与现在完全一致。
- 新 App + 旧 daemon：`connect-info` 404 忽略；pong 未出现则不启用半开判定；并行探测对旧 daemon 透明。
- 旧 App + 新 daemon：二维码多一个 relay 地址，旧 App 串行探测仍可用（直连在前）。
- 回滚：`cr relay remove` 或删除 `RELAY_*` 即关闭 connector；App 侧改动彼此独立，可按里程碑单独回退。

## 9. 测试策略

- `packages/relay`：协议编解码往返；设备 ID 派生（固定向量）；用真实 relay + 假 agent（直接用 protocol 模块）测路由、去前缀、离线 503、ID 与私钥不匹配 403、relay 重启后同一私钥仍能接入同一 ID、替换旧连接、并发上限、body 上限、head 超时、流控（慢消费者下 relay 缓冲不超过窗口）。
- daemon：connector 接真实 relay 与真实 server 的集成测试：GET/POST、上传、流式搜索响应、WS 收发、经 relay 的 pair-info 为 403、relay 重启后自动重连；`connect-info` 与 ping/pong。
- cli：`cr relay add/on/off/remove` 对配置文件的读写（沿用 `config.test.ts` 方式），URL 校验。
- 手机端核心：`probeBases` 假时钟测试（直连优先、宽限期、401 短路、全部失败）；`candidateBases`/`syncBases`/通道识别；`ws.js` 半开判定与旧 daemon 兼容。
- 端到端：本机起 relay + daemon，模拟器 App 经 relay 跑通会话、发送、上传、审批；再在一台真实服务器按 README 部署验证（需用户同意使用哪台服务器）。
