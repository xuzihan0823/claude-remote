# API 契约 v1

> 任务卡 02/03/04/05/06 的共同依据。改动本文件需主窗口同意并同步所有受影响的卡。

## 鉴权

- HTTP：`Authorization: Bearer <BRIDGE_TOKEN>`；WS：`/ws?token=<BRIDGE_TOKEN>`。
- token 来自环境变量 `BRIDGE_TOKEN`；缺失时 daemon 拒绝启动。
- 失败一律 `401 {"error":"unauthorized"}`，不泄露其他信息。

## HTTP 端点

### GET /api/health
`200 {"ok":true,"version":"<daemon版本>","claudeCliVersion":"<检测值|unknown>"}`

### GET /api/models

返回 Mac 模型目录：`200 {"models":[{"id":"provider/model","alias":"provider/model","displayName":"Model label"}],"defaultModel":"provider/model"}`。`defaultModel` 可省略；本接口沿用 Bearer 鉴权。

- 数据源为 `CLAUDE_CONFIG_DIR/settings.json`，未设置目录时读取 `~/.claude/settings.json`；每次请求重新读取。
- 优先使用 `modelPicker.options` 中有效的 `model` / `label`，保留顺序，按完整模型 ID 去重；不同服务来源不合并。只返回 ID、别名和显示名称，不透出 `description`、凭据或其他设置。
- 没有有效选项时回退到 `fable` / `opus` / `sonnet` / `haiku` 及其 `env.ANTHROPIC_DEFAULT_*_MODEL` 映射。有效默认模型不在列表内时补入；使用完整列表时，默认别名按有效映射解析为具体 ID。
- 新建会话和续聊的可选 `model` 使用同一目录校验。内置别名保留兼容；未知 ID 返回 `400 {"error":"unknown_model"}`，非字符串或空值返回 `400 {"error":"invalid_model"}`。省略 `model` 则由 SDK 使用 Mac 默认。

### GET /api/projects

返回完整会话索引聚合的项目目录，沿用 Bearer 鉴权：

```jsonc
{
  "projects": [{
    "id": "/Users/mac/Desktop/foo", // Git 仓库根路径；非 Git 则为原始 cwd
    "name": "foo",
    "cwd": "/Users/mac/Desktop/foo", // 最近活跃的已知实际工作目录
    "cwds": ["/Users/mac/Desktop/foo", "/Users/mac/worktrees/foo-fix"],
    "sessionCount": 12,
    "lastActiveAt": 1752825600000
  }],
  "totalSessions": 15,
  "unclassifiedCount": 3,
  "homeCwd": "/Users/mac" // daemon 主机用户主目录，未选择项目时的默认新建目标
}
```

- 同一 Git 仓库的 worktree 归到同一项目；普通目录按完整路径区分，同名目录不合并。Git 识别失败时保留原始 cwd。
- `cwds` 仅包含实际出现在会话中的非空目录，项目按最近活动排序。缺少 cwd 的会话计入未归类，不推测编码目录名。
- 项目 ID 用于浏览归组；新建会话仍必须提交选定的已知实际 `cwd`，不可拿仓库根目录代替 worktree。`homeCwd` 等同于在主机上直接启动 CLI 的当前目录，可作为没有项目偏好时的默认目标。

### GET /api/sessions?limit=50&offset=0
会话列表，按 `lastActiveAt` 降序。可选 `projectId` 按项目过滤（省略表示全部，空字符串表示未归类）；可选 `cwd` 按原始工作目录精确过滤。参数须 URL 编码，两种过滤同时提供时取交集。过滤发生在分页前，`total` 为过滤后的数量；未知项目返回空列表。旧调用兼容。

```jsonc
{
  "sessions": [{
    "sessionId": "3e8a4b9c-…",        // JSONL 文件名（去 .jsonl）
    "cwd": "/Users/mac/Desktop/foo",   // 从 JSONL 行内 cwd 字段读取
    "projectDirName": "-Users-mac-Desktop-foo", // 编码目录名（仅展示分组用）
    "title": "帮我审查一下…",           // 首条真实 user 文本截 60 字；无则 "(空会话)"
    "lastPreview": "…",                // 最后一条主链消息文本截 80 字
    "lastActiveAt": 1752825600000,     // 文件 mtime（epoch ms）
    "sizeBytes": 30489,
    "status": "idle"                   // idle | terminal-driving | daemon-driving
  }],
  "total": 123
}
```

### GET /api/sessions/:id/messages?beforeSeq=&limit=100
消息按 `seq` 升序返回主链消息（`offChain` 行不返回）。`beforeSeq` 缺省 = 从尾部取最新 `limit` 条。

`200 {"messages":[RenderMessage], "firstSeq":12, "hasMore":true, "status":"daemon-driving", "activeRunId":"<uuid|undefined>"}`
`status`/`activeRunId` 供客户端重建运行状态；`activeRunId` 缺席表示当前无活跃 run。
会话不存在 → `404 {"error":"session_not_found"}`

### POST /api/sessions/:id/messages
Body `{"text":"下一句话", "clientMessageId?":"<uuid>", "model?":"…", "permissionMode?":"…"}`。触发 Runner 以 `resume` 续聊。

- `202 {"runId":"<uuid>", "clientMessageId?":"<uuid>"}` — 已开始，后续经 WS `run`/`message`/`stream` 事件观察；`clientMessageId` 会作为 SDK 输入消息的 uuid 落盘，随后可由 `RenderMessage.uuid` 精确确认
- `409 {"error":"not_idle","status":"terminal-driving"}` — 互斥拒绝
- `404` 会话不存在；`400` text 空/非字符串、`clientMessageId` 非 UUID

### POST /api/sessions
Body `{"cwd":"…", "text":"…", "sessionId?":"<uuid>", "clientMessageId?":"<uuid>", "model?":"…", "permissionMode?":"…"}`。

- `202 {"sessionId":"<uuid>", "runId":"<uuid>", "clientMessageId?":"<uuid>"}` — 新建会话并开始首轮
- 客户端可预分配 `sessionId`（必须是 UUID）；该 ID 已存在时 `409 {"error":"session_exists"}`
- 省略 `sessionId` 时由 daemon 生成（旧客户端兼容）

### POST /api/sessions/:id/abort
Body 可选 `{"runId?":"<uuid>"}`。中止该会话当前的 daemon run。

- `200 {"runId":"<uuid>","status":"aborted"}` — 已发出中止
- `200 {"status":"already_finished"}` — 当前没有活跃 run（幂等）
- `200 {"runId":"<uuid>","status":"run_mismatch"}` — 请求的 runId 与当前活跃 run 不一致，不执行中止（防止迟到停止误伤新一轮）
- `404` 会话不存在；`400` runId 非 UUID

### POST /api/interactions/:id/decision
Body 三选一：`{"type":"allow_once"}` | `{"type":"deny","message?":"…"}` | `{"type":"answer","answers":{"<question>":"<answer>"}}`

- `200 {"status":"allowed|denied|answered"}`
- `404` 不存在；`409 {"error":"already_resolved"}`；`400` 决策类型与交互种类不匹配

语义沿用 interactions 包：一次性授权、无持久 allow、超时/重启 auto-deny。

### POST /api/sessions/:id/upload?filename=<原始文件名>
附件上传（2026-07-18 增补）。请求体为原始二进制（`Content-Type: application/octet-stream`），上限 25MB。文件落盘 `<UPLOADS_DIR>/<sessionId>/<时间戳>-<消毒后文件名>`（消毒：取 basename、替换路径分隔符、剥控制字符）。

- `200 {"path":"/Users/…/xx.png","name":"xx.png","sizeBytes":1234}` — `path` 为 Mac 上的绝对路径，前端把它写进消息文本让 Claude 直接读
- `404 session_not_found`；`400 empty_file`；`413 payload_too_large`

## CORS（2026-07-18 增补）

`/api/*` 全部带 `Access-Control-Allow-Origin: *`；`OPTIONS` 预检免鉴权返回 `204`（允许方法 GET/POST/OPTIONS，允许头 Authorization/Content-Type）。动机：iOS 壳（`capacitor://localhost`）与非同源部署的前端需要跨域；鉴权靠 Bearer token 不依赖 Cookie，放开 Origin 安全。

## WebSocket /ws?token=

文本帧 JSON。客户端断线自行指数退避重连，重连后重新 subscribe 并用 `GET messages` 补缺口（以 `seq` 去重）。

存活检测：服务端仍保留协议层 ping（30s），但 JS 客户端看不到；客户端前台每 10s 发 `{"type":"ping"}`，5s 无 pong 且期间无任何帧则重连。旧 daemon 不回 pong 时，只要仍在收到数据帧即视为存活。订阅以 `subscribed` 帧为“就绪”信号；客户端在该帧到前缓存 live 帧，到后拉取快照合并。

### client → server
```jsonc
{"type":"subscribe","sessionId":"…"}    // 可多会话；列表页可订阅 "*" 仅收 status/approval
{"type":"unsubscribe","sessionId":"…"}
{"type":"ping"}                          // 应用层心跳；服务端不要求 sessionId
```

### server → client
```jsonc
{"type":"subscribed","sessionId":"…"}   // watcher 已就绪（或 "*" 订阅已登记）；客户端收到后做快照同步
{"type":"pong"}                          // 对 {"type":"ping"} 的回应
{"type":"message","sessionId":"…","message":RenderMessage}          // watcher 增量（含 daemon 自跑轮次落盘的行）
{"type":"stream","sessionId":"…","runId":"…","messageId":"<API message id>","blockIndex":0,"text":"增量"}  // 真实流式文本；非持久，最终以 message 为准
{"type":"stream_snapshot","sessionId":"…","runId":"…","blocks":[{"messageId":"…","blockIndex":0,"text":"已生成文本"}]}  // 订阅/重连时恢复当前 run 已生成前缀
{"type":"resync","sessionId":"…"}   // daemon 侧链视图失效（终端 rewind/fork、文件截断）；客户端清空本地列表并重新 GET messages
{"type":"status","sessionId":"…","status":"idle|terminal-driving|daemon-driving"}
{"type":"run","sessionId":"…","runId":"…","state":"started|done|error","error?":"…"}
{"type":"approval","interaction":{
    "interactionId":"…","sessionId":"…","kind":"approval|question",
    "toolName":"Bash","input":{…},"prompt":"…","expiresAt":1752825900000,
    "questions?":[{"question":"…","header":"…","options":[{"label":"…","description":"…"}],"multiSelect":false}]
}}
{"type":"approval.resolved","interactionId":"…","status":"allowed|denied|answered|expired"}
```

`approval` / `approval.resolved` 为**广播语义**：发给全部已鉴权连接（不按 subscribe 过滤），客户端按 `interactionId` 匹配。

## RenderMessage（渲染用统一结构）

由 JSONL 行映射而来；`seq` = 行号（1 起），是分页与去重的唯一键。

```jsonc
{
  "seq": 42,
  "uuid": "…", "parentUuid": "…|null",
  "role": "user" | "assistant",
  "kind": "text" | "tool_use" | "tool_result" | "thinking" | "meta",
  "text?": "…",                        // text/thinking/tool_result 的文本
  "toolName?": "Bash", "toolInput?": {…}, "toolUseId?": "…",
  "isError?": false,                    // tool_result
  "timestamp?": "2026-07-18T08:30:28.132Z",
  "rawType?": "file-history-snapshot",  // kind=meta 时保留原始 type 供折叠展示
  "apiMessageId?": "msg_…"              // 仅 assistant 行：JSONL 行内 message.id，用于与流式增量对账
}
```

`uuid` 对用户消息等于提交时的 `clientMessageId`（旧客户端提交的消息为 CLI 生成的 UUID）。客户端以 `role=user && kind=text && uuid === clientMessageId` 精确确认本地待发气泡。

映射规则：
- user 行 content 为字符串或 blocks；text block → `kind:text`；tool_result block → `kind:tool_result`（role 保持 user）。剥离 `<local-command-caveat>…</local-command-caveat>` 等包裹标签后为空的行不返回。
- assistant 行 content blocks：text → `kind:text`；tool_use → `kind:tool_use`；thinking → `kind:thinking`。一行多 block 拆多条 RenderMessage，`seq` 相同时以 `seq + blockIndex/1000` 或 `{seq, blockIndex}` 区分——**实现取后者**：结构加 `"blockIndex": 0`。
- `isSidechain === true` 的行不返回（阶段一隐藏 subagent 支线）。
- 元数据行（mode/queue-operation/file-history-snapshot/summary 等）不返回；未知 type 且含 message 结构的行 → `kind:meta` + `rawType`。
- 主链判定：文件最后一条 user/assistant 消息沿 parentUuid 回溯；链外行不返回。

## 状态语义

- `daemon-driving`：Runner 有该会话的活跃 run。
- `terminal-driving`：非 daemon run 期间检测到文件写入；最后一次外部写入后 120s（`ACTIVITY_COOLDOWN_MS` 可配）无写入回落 `idle`。
- `idle`：其余情形。仅此状态接受 POST messages。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `BRIDGE_TOKEN` | ✅ | — | 应用层鉴权 token |
| `BRIDGE_HOST` | | `127.0.0.1` | 监听地址（Tailscale 部署时设为 Tailscale IP 或 `0.0.0.0` 由防火墙约束） |
| `BRIDGE_PORT` | | `8787` | 端口 |
| `CLAUDE_PROJECTS_DIR` | | `~/.claude/projects` | 数据源（测试注入 fixture 用） |
| `UPLOADS_DIR` | | `~/.claude-remote/uploads` | 手机端上传附件的落盘目录 |
| `ACTIVITY_COOLDOWN_MS` | | `120000` | terminal-driving 回落 idle 的静默期 |
| `INTERACTIONS_DB_PATH` | | `.data/interactions.sqlite` | 审批状态库 |
| `PERMISSION_TIMEOUT_MS` | | `300000` | 审批超时（超时即 deny） |
| `BARK_URL` / `NTFY_URL` | | — | 推送通知（可选，二选一） |
