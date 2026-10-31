# 架构说明

记录关键设计及当前会话运行接口契约；实现与集成测试位于 `packages/daemon/src/server.ts` 和 `packages/daemon/__tests__/server.test.ts`。

## 整体结构

```
iPhone App (app/ + web/core/)
   │  HTTP + WebSocket，Bearer token
   ├── 直连：Tailscale / 局域网 / mDNS
   └── relay：https://<relay>/d/<deviceId>  ──  packages/relay（公网）
                                                  ▲ Mac 主动连出
Mac daemon (packages/daemon)  ── connector ───────┘
   ├── 读 ~/.claude/projects/**/*.jsonl（只读）
   ├── 经 Agent SDK 续聊（packages/agent-bridge）
   └── 审批状态机（packages/interactions，SQLite）
cr 命令行 (packages/cli)：控制台、启停、配对、relay 配置
```

## 会话数据

- JSONL 是唯一的数据来源。Claude Code 对话时逐行追加，daemon 增量 tail 实现实时镜像，自己不写 JSONL。
- `claude --resume <id>` 返回同一个 session_id，并追加到原文件；`--fork-session` 才会复制出新文件。手机续聊和终端续聊因此写的是同一个文件。
- 手机建的会话要能出现在终端 `/resume` 列表里：CLI 会隐藏 entrypoint 为 `sdk-cli`/`sdk-ts`/`sdk-py` 的会话，所以 `sdk-bridge.ts` 把子进程的 `CLAUDE_CODE_ENTRYPOINT` 设为 `claude-remote`。SDK 的 `options.env` 会整体替换子进程环境，必须自己带上 `process.env`。历史会话可用 `scripts/unhide-sdk-sessions.mjs` 修复。
- 驾驶状态（`watch/activity.ts`）分三种：`daemon-driving`（手机端有运行中的轮次）、`terminal-driving`（运行之外检测到文件写入）、`idle`。终端写入后静默 120 秒回到 idle；`cli-presence.ts` 通过 `~/.claude/sessions/<pid>.json` 判断终端是否已退出，退出后立即释放。
- 停止接口 `POST /api/sessions/:id/abort` 可带 `runId`，与当前运行不一致时返回 409 `run_mismatch`，防止过期的停止请求误停新一轮。

## 安全边界

- 应用层只有一个 Bearer token（`BRIDGE_TOKEN`），不自建加密协议。网络边界是 Tailscale 或 relay，Mac 不开公网端口。
- 审批 fail-closed：超时、断线、daemon 重启、异常一律拒绝，不做自动批准。
- 配对端点 `/api/pair-info`、`/api/pair-qr.svg` 会返回 token，只允许本机访问，并且有两层保护：
  1. daemon 判断来源是否 loopback，同时用 `looksProxied()` 检查代理特征头（`x-forwarded-*`、`forwarded`、`cf-*` 等），有就 403。原因是 cloudflared、nginx、relay connector 这类本机代理转发过来的请求，来源也是 127.0.0.1。
  2. relay connector 对配对路径做 WHATWG 路径规范化后直接 403，不转给 daemon；其余请求一律加 `X-Forwarded-*`，即使路径判断被绕过，第 1 层也会拦住。
- 新增仅限本机的接口时，要同时加进 connector 的 `PAIR_PATHS`。不要用"来自 127.0.0.1"做任何新的信任判断。

## Relay 协议

`packages/relay`（公网服务）与 `packages/daemon/src/relay/connector.ts`（Mac 端）共用 `@claude-remote/relay/protocol`，不要另写一份帧解析。

- 入口：手机访问 `/d/<deviceId>/<path>`，WS 只允许 `/d/<deviceId>/ws`；Mac 以 `GET /agent` 升级连接，带 `Authorization: Bearer <RELAY_SECRET>`、`X-Device-Id`、`X-Device-Key`。
- 设备 ID 由设备私钥派生：`base32lower(sha256("claude-remote-relay/v1:" + key))` 取前 20 位。relay 每次连接时重新计算校验，不存任何状态。
- 同一设备 ID 重连会顶掉旧连接（关闭码 4001）。connector 遇到 4001 按认证类错误退避，避免两台 Mac 共用一个密钥时互相踢。
- 帧格式：控制帧是 JSON 文本（`open`/`head`/`accept`/`end`/`wsclose`/`reset`/`credit`）；数据帧是二进制 `[u8 类型][u32 sid 大端][负载]`，类型 1 为 HTTP body、2 为 WS 文本、3 为 WS 二进制。`sid` 只由 relay 分配。
- 流控：每个流每个方向初始窗口 256 KiB，接收方消费后回 `credit`。不能发 `bytes: 0` 的 credit（空 WS 消息不产生 credit 帧）。
- `RELAY_SECRET` 写入 `.env` 时不加引号，所以不能包含 `#`、引号、反引号和反斜杠，否则 `process.loadEnvFile` 会截断。
- 设备离线时 relay 立即返回 503 `device_offline`，手机会回退到其它地址。
- 多 relay 配置：第一项沿用 `RELAY_URL` / `RELAY_SECRET`，后续为 `_2`、`_3` 等连续编号。`loadRelaySettings` 返回数组；缺配对密钥、编号空位、规范化后地址重复或非法时拒启，错误指出编号。`RELAY_ENABLED=off` 时返回空数组。
- daemon 为每项创建独立 `RelayConnector`，全部启动和停止，各自退避、重连和发送心跳；单台失败不影响其他连接。不改变 relay 服务端或隧道协议。
- 所有 relay 共用 `RELAY_DEVICE_ID` / `RELAY_DEVICE_KEY`。`add` 追加地址或更新已有地址的密钥；`remove <地址>` 重排编号并保留设备身份；`remove --all` 清除身份。每台 relay 都会收到设备私钥，并能看到转发的 token 和内容，因此仅适用于自己控制的服务器。
- 配对码和 `GET /api/connect-info` 都在直连地址后追加所有已启用的 relay 地址，暂时故障的 relay 也保留。`connect-info` 返回 `{ bases: string[], relays: RelayStatus[] }`，不再返回单数 `relay`；未启用时 `relays` 为空，状态只含 `state`、`base`、`since` 和可选 `error`，不包含密钥。

## 手机端多通道

逻辑在 `web/core/`（`api.js`、`devices.js`、`ws.js`），由 `app/src/App.js` 调用。

- 一台设备保存多个地址：`bases`（同步而来）、`manualBases`（用户手填，同步时不能删）、`lastBase`、`channelPref`（`auto`/`direct`/`relay`）。
- `probeBases` 并行探测：直连先通就立即使用；relay 先通则再等 1.5 秒看有没有直连；任一地址返回 401 就停止并提示 token 错误。不要改回串行探测，一个失效的 Tailscale IP 就要等 8 秒超时。
- 完整连接时调用 `GET /api/connect-info`，用 `syncBases` 把新通道同步给已配对的手机，并删除 daemon 不再承认的旧通道；手填地址保留。冷启动或点“重新连接”会同步，`reselect` 只重新探测现有候选地址。新增 relay 后必须趁现有通道可用时完整连接一次。
- 多个 relay 没有优先级，选最先探测成功的那个；故障后重选通道，恢复后不会主动切回。Mac 或 daemon 离线时全部 relay 都不可用。
- WS 应用层心跳：每 10 秒发 `{type:"ping"}`，daemon 先回 `{type:"pong"}` 再做其它检查。收到过 pong 之后 5 秒内无任何帧视为半开连接；连续 2 次连接失败或半开时发出 `ws-reselect`，App 重新选路。App 回到前台时也会重新选路。

## 模型目录与项目分组

- `GET /api/models` 每次请求都重新读取 `$CLAUDE_CONFIG_DIR/settings.json`（默认 `~/.claude/settings.json`）。有合法的 `modelPicker.options` 时用它，否则退回 fable/opus/sonnet/haiku 四个别名及其 `ANTHROPIC_DEFAULT_*_MODEL` 映射。只投影 `{id, alias, displayName}`，不要把选项对象整体展开到响应里（描述字段可能含账号信息）。发送时未在目录里的具体模型 ID 返回 400 `unknown_model`。
- 目录的 `defaultModel` 仅代表用户配置默认，不是指定项目的有效默认模型。手机端默认项显示“跟随项目默认”，并说明“用户配置默认：A；实际运行遵循当前项目配置”。省略 `model` 时保持 SDK 默认配置加载行为，不把目录默认值作为显式覆盖传入。
- `GET /api/projects` 基于完整会话索引聚合，再分页。Git 仓库按共享根目录分组，worktree 归入同一个项目；同名不同仓库仍是不同项目，`name` 只用于显示。
- 项目 ID 只用于浏览分组，不能当作工作目录。新会话必须使用项目 `cwds` 里真实出现过的原始目录；没有选择时默认 `homeCwd`（daemon 主机的用户主目录）。后台刷新不能悄悄替换用户已选的目录。

## 会话运行接口契约

以下路径相对 daemon base；经 relay 时 base 包含 `/d/<deviceId>`。HTTP 使用 `Authorization: Bearer <token>`；WS 为 `/ws?token=<token>`。除配对接口外，未鉴权返回 `401 {"error":"unauthorized"}`。JSON 请求体上限 1 MiB，超出返回 413 `payload_too_large`；坏 JSON、空正文（停止接口除外）或 null/标量返回 400 `invalid_json`。客户端使用 JSON 对象传参。错误响应使用 `{ "error": "<code>" }`，必要时附加状态字段。

### 新建会话：`POST /api/sessions`

```json
{ "cwd": "/path/to/project", "text": "检查这个项目", "model": "sonnet", "permissionMode": "plan" }
```

`cwd`、`text` 必填且不能全为空白。cwd 去除两端空白后必须精确命中已有会话中非空的原始 cwd 或 daemon 用户主目录；项目分组 ID 不能代替 cwd，也不接受任意目录。错误分别为 400 `invalid_cwd`、`invalid_text`、`unknown_cwd`。

`model` 和 `permissionMode` 为本轮可选覆盖，新建与续聊使用相同校验：

- `model` 省略时不向 SDK 注入模型，遵循当前项目配置；不能用空字符串或 null 表示默认。非字符串/空白返回 400 `invalid_model`，不在目录中的具体 ID 返回 400 `unknown_model`。接受目录中的完整 ID 或 alias，以及内置 `fable`、`opus`、`sonnet`、`haiku`；字符串会去除两端空白。
- `permissionMode` 只接受 `default`、`acceptEdits`、`plan`、`bypassPermissions`，省略时 SDK 使用 `default`，非法值返回 400 `invalid_permission_mode`。覆盖不写回 Mac 设置，也不修改已经开始的轮次。
- `effort` 为本轮思考程度覆盖，仅接受 `low`、`medium`、`high`、`xhigh`、`max`；省略时不注入 SDK，跟随本机配置，不回写设置文件。服务端只校验取值，非法值返回 400 `invalid_effort`，不判断模型是否支持。

成功返回 `202 { "sessionId": "<uuid>", "runId": "<uuid>" }`，表示已受理，不保证推理成功或 JSONL 已落盘。新会话可立即订阅取得运行状态；消息接口在落盘前可能返回 404 `session_not_found`，客户端应重试。后台发现文件后发送 `resync` 以触发正文重拉。运行互斥冲突返回 `409 { "error": "not_idle", "status": "daemon-driving" }`（status 为当时真实状态）。

### 续聊：`POST /api/sessions/:id/messages`

```json
{ "text": "继续检查", "model": "sonnet", "permissionMode": "acceptEdits" }
```

`text` 必填；模型、权限校验同新建。cwd 从该会话 JSONL 读取，无 cwd 时回退 daemon 用户主目录；客户端不能在此覆盖 cwd。成功返回 `202 { "runId": "<uuid>" }`。未知会话返回 404 `session_not_found`，非空闲或已有活跃 run 返回 `409 { "error": "not_idle", "status": "terminal-driving" }` 或 `daemon-driving`。客户端应及时绑定响应 runId，并防止迟到响应覆盖更新的运行终态/新轮次。

### 停止或解除占用：`POST /api/sessions/:id/abort`

推荐传 `{ "runId": "<uuid>" }`，以保护指定轮次。sessionId 非 UUID 返回 400 `invalid_session_id`；runId 非 UUID（包括 null、空字符串、数字）返回 400 `invalid_run_id`，无状态副作用。

| 请求与服务器状态 | HTTP 与响应 | 行为 |
| --- | --- | --- |
| runId 等于当前运行 | `200 { "runId": "<uuid>", "status": "aborted" }` | 停止已受理，等待 SDK 收尾；重复停止安全 |
| runId 与当前运行不同 | `409 { "error": "run_mismatch", "activeRunId": "<当前uuid>", "status": "daemon-driving" }` | 不停止当前运行；客户端同步当前身份 |
| 指定 runId，但当前无运行 | `200 { "runId": null, "status": "idle", "sessionStatus": "idle" }` | 幂等；sessionStatus 也可能为 terminal-driving，此时不解除终端占用 |
| 不指定 runId，当前有运行 | `200 { "runId": "<uuid>", "status": "aborted" }` | 兼容旧客户端，停止会话当前轮次；无指定轮次保护 |
| 不指定 runId，终端占用 | `200 { "runId": null, "status": "released" }` | 手动解除占用，后续终端写入仍可重新占用 |
| 不指定 runId，当前空闲 | `200 { "runId": null, "status": "idle" }` | 无操作 |

兼容无请求体及 `{}`。`aborted` 是受理结果，不是运行终态；客户端显示“正在停止”并保持发送受限，等待对应 run 终态或权威状态快照。Runner 默认最多等待约 5 秒中止宽限后强制关闭。A 的迟到停止响应不能清除 B；通用 404/409 不等于运行已结束。

### 模型目录与消息读取

`GET /api/models` 返回 `{ "models": [{ "id": "provider/model", "alias": "sonnet", "displayName": "Sonnet" }], "defaultModel": "sonnet" }`，defaultModel 可缺省。目录读取用户 settings，不解析指定 cwd 的 project/local 设置，不包含凭据或 picker description；不能据此宣称项目一定使用某模型。

`GET /api/effort-levels?cwd=<cwd>&model=<override>` 返回 `{levels, verified}`。续聊以 `sessionId` 替代 cwd，服务端从 JSONL 解析真实工作目录；新建 cwd 仅接受已知会话目录或主目录。model 省略时按 `ANTHROPIC_MODEL` > settings `model` 取默认模型，别名经 `ANTHROPIC_DEFAULT_*_MODEL` 展开。若 `ANTHROPIC_BASE_URL` 是本机 HTTP 地址，服务端读取该网关（Magpie）的 `/v1/models`，按模型 id 匹配 `reasoning_levels`，有档位时 `verified: true`；网关不可达、非本机、找不到模型或档位为空（Magpie 对自定义渠道的模型不掌握思考能力，会报 `reasoning: false`）时返回全部五档、`verified: false`。不启动 SDK、不缓存。手机端每个会话只保存一个档位字符串；仅当 `verified` 且所选档位不在列表中时标红并阻止发送，不静默降档。

`GET /api/sessions/:id/messages?limit=100&beforeSeq=42` 返回 `{ "messages": [], "firstSeq": null, "hasMore": false }`。limit 默认 100、范围 1–500；beforeSeq 为大于等于 1 的安全整数且不包含该行，非法值返回 400 `invalid_before_seq`。消息按 seq、blockIndex 升序；以 `(seq, blockIndex)` 去重，seq 是 JSONL 物理行号而非数组下标。字段包括 uuid、parentUuid、role、kind，以及按 kind 出现的 text、toolName、toolInput、toolUseId、isError、timestamp、rawType；assistant 消息可含 `apiMessageId`，用于将草稿对账限定到同一 API 消息，不能假设转录 blockIndex 等于 SDK 流下标。

### WS 订阅、运行事件与状态恢复

客户端发送 `{ "type": "subscribe", "sessionId": "<uuid>" }`，取消用 `unsubscribe`。指定会话订阅成功后，服务器先发送当前权威快照，再发送尚存的流草稿；新会话尚未落盘时也提供状态快照。未知会话订阅静默忽略；同连接重复订阅不重发快照，需要重连或取消后重新订阅。

```json
{ "type": "session-state", "sessionId": "<uuid>", "status": "daemon-driving", "activeRunId": "<uuid>" }
```

无活跃 daemon run 时 activeRunId 为 null，status 可以是 idle 或 terminal-driving。快照不伪造 `run.started`；客户端统一更新 status、运行标记和身份，无活跃运行时清理旧草稿及计时器。状态恢复不依赖前 200 条会话列表，也不依赖本地已有消息；HTTP 列表仅刷新元信息，不得覆盖后来收到的运行状态。重连补拉须使旧连接、旧会话的异步结果失效。

```json
{ "type": "run", "sessionId": "<uuid>", "runId": "<uuid>", "state": "started", "permissionMode": "plan" }
{ "type": "run", "sessionId": "<uuid>", "runId": "<uuid>", "state": "done" }
{ "type": "run", "sessionId": "<uuid>", "runId": "<uuid>", "state": "error", "error": "aborted" }
{ "type": "status", "sessionId": "<uuid>", "status": "idle" }
```

run.state 为 started/done/error；`error` 和 `permissionMode` 可选，permissionMode 仅显式指定时随启动帧出现，缺省不能解释为重置客户端模式。旧 run 的终态不能清除新 run。status 三态语义见“会话数据”。全局 `sessionId: "*"` 订阅只收状态广播，不补发会话快照或 run/正文/草稿。审批帧向全部连接广播。

正文帧为 `{ "type": "message", "sessionId": "<uuid>", "message": { "seq": 1, "blockIndex": 0, "uuid": "...", "parentUuid": null, "role": "assistant", "kind": "text", "text": "回答" } }`；链改写/文件替换等触发 `{ "type": "resync", "sessionId": "<uuid>" }`，客户端清空视图并重拉正文。

流帧为 `{ "type": "stream", "sessionId": "<uuid>", "key": "<apiMessageId>:<index>", "offset": 0, "text": "回答" }`，block 结束时带 `done: true`；offset 是 JavaScript 字符串偏移，按偏移合并可重复投递。订阅草稿快照从 offset 0 开始，终止清理为 `{ "type": "stream", "sessionId": "<uuid>", "clear": true }`。草稿仅供即时显示，正式正文以消息接口和 message 帧为准，二者需对账。

客户端 `{ "type": "ping" }` 收到 `{ "type": "pong" }`，与订阅无关。会话快照及上述 HTTP/WS 行为由 `server.test.ts` 集成测试覆盖；App 恢复顺序由 `app/src/lib/__tests__/chat-streaming.test.mjs` 覆盖。

## Markdown 公式与图片

手机端支持 `$…$`、`\(…\)` 行内公式，以及 `$$…$$`、`\[…\]` 块级公式。MathJax 3.2.2 在首次渲染公式时加载，输出 SVG 交给原生组件；无效或尚未闭合的公式保留原文，长块级公式可横向滚动。代码块继续使用现有 highlight.js。

本机图片和栅格 `data:image/…` 可自动显示；远程 HTTP(S) 图片须点击占位后才读取尺寸和内容，避免消息渲染自动向外发送请求。loopback URL 保留为链接，不改写为 daemon 或 relay 主机。点开图片复用全屏图片查看器。

`GET /api/sessions/:id/file?path=<path>` 使用 Bearer 鉴权，支持绝对路径、`file://`、`~/` 以及相对会话真实 cwd 的路径。服务端先 `realpath`，再检查真实路径的栅格图片扩展名、普通文件类型和 25 MiB 上限；不提供 SVG。成功返回图片二进制、对应 Content-Type、`nosniff` 和私有不缓存响应。未知会话返回 404 `session_not_found`，空路径或非法 file URL 返回 400 `invalid_path`，非图片返回 415 `unsupported_image`，超限返回 413 `payload_too_large`，文件缺失或不可读返回 404 `not_found`。仅提供 GET；读取错误不会中断 daemon。经 relay 时沿用包含 `/d/<deviceId>` 的 base 和请求头鉴权。
