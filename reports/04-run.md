# 报告 · 04 SDK resume Runner + 审批桥 + 推送

状态：**完成**。`pnpm --filter @claude-remote/daemon test` 64 个全绿（本卡新增 26：runner 8 + approval 11 + notifier 7），根 `pnpm typecheck` / `pnpm test`（76 个）全绿。测试全部走 fake QueryFactory 与 mock fetch，interactions 用 `:memory:`，未触真 SDK/网络。

## 交付文件

```
packages/daemon/src/run/
├── runner.ts      # TurnRunner + ActivityGate 接口 + NotIdleError + RunEvent
├── approval.ts    # ApprovalBridge（implements PermissionBroker）+ ApprovalEvent + DecideOutcome
├── notifier.ts    # createNotifier / createNotifierFromEnv
└── index.ts       # re-export 三模块
packages/daemon/__tests__/
├── run-runner.test.ts
├── run-approval.test.ts
└── run-notifier.test.ts
```

## 实现要点

### TurnRunner（runner.ts）

- `startTurn({sessionId, cwd, text}): {runId, events, completion}` **同步返回**：空 text 抛 `TypeError`、活跃 run 存在或 gate 非 idle 抛 `NotIdleError`（06 映射 409）、`gate.beginRun` 与活跃 run 注册全在同一 tick 内完成——检查与发起之间无异步间隙（正是 03 报告担心的"检查-发起间隙被判 terminal-driving"，在 Runner 内部闭环解决，06 无需自己做互斥检查）。
- 并发=1：`Map<sessionId, runId>` 记录活跃 run，重复 `startTurn` 抛 `NotIdleError`；不同会话可并行。
- SDK 接线：`createPermissionAdapter(permissions, {sessionKey: sessionId, userId}, {timeoutMs})` → `startSdkQuery({cwd, prompt: text, resume: sessionId, canUseTool, signal})`；`permissionMode` 固定 `default`（sdk-bridge 写死，无 bypass 路径）；`userId` 默认 **"web"**。
- **completion 由 Runner 自建自耗、永不 reject**：消费循环全包 try/catch，正常结束 → `{state:"done"}`，流中抛错 → `{state:"error", error}`，abort → `{state:"error", error:"aborted"}`（aborted 标记优先于流的自然结束方式，终态确定性）。三条路径一律先推 `run` 终态事件、close 事件队列再 resolve。探针测试：`process.on("unhandledRejection")` 挂着不 await completion，30ms 内零命中。
- `finally` 收尾顺序：`sdk.close()` → 释放活跃 run 注册 → `gate.endRun(sessionId)`，每步各自 try/catch（endRun 抛错只 warn，不影响 settle，有测试）。endRun 在 SDK iterator 耗尽之后调用，满足 03 报告"最后一行落盘后再 endRun"的时序要求。
- `abort(runId): boolean`：经 AbortController → sdk-bridge 调 `Query.interrupt()`；未知 runId 返回 false（06 可映射 404）。
- 事件流 `events: AsyncIterable<RunEvent>` 为缓冲队列，push 先于消费不丢事件（消费者晚接入可回放全量），**单消费者语义**（06 的 WS 层是唯一消费者）。

### ApprovalBridge（approval.ts）

- `implements PermissionBroker`（agent-bridge 接口）。approval：`manager.createApproval` → emit `approval` 事件 → `awaitDecision(id, signal)`；question：`questionFromAskUserInput` 后**按单题拆分串行**（沿旧 dev-worker 的 splitQuestion 手法，测试断言第二题在首题答完前不出现），全部答完合并 answers；任一题非 answer（超时 deny）→ 整体 `{type:"deny", message:"Question was not answered"}`。
- 两侧失败纪律分离：SDK 侧 `request()` fail-closed（任何异常折算 deny，含畸形 question input）；HTTP 侧 `decide()` **永不抛异常**，`AlreadyResolved→{status:"already_resolved"}`、`NotFound→{status:"not_found"}`、`TypeError/InvalidAnswer/Unauthorized/未知→{status:"invalid", message}`，双击第二下有专门测试。
- 单用户简化：`decide` 用记录自身的 `userId` 决议（鉴权在 HTTP Bearer 层），`Unauthorized` 分支保留为纵深防御。
- `approval.resolved` 补发策略：`decide()` 成功路径与 `awaitDecision` 续体都会尝试 emit，按 interactionId Set 去重，恰好一条（有测试）；状态取落库终态，因此 **TTL 超时走 interactions 既有 auto-deny 时 emit 的是 `status:"expired"`**（decision 是 deny、状态是 expired，与契约的四值枚举一致）。
- `onEvent` 监听器抛错只 warn 不破坏状态机（观察者不得反噬审批链，有测试）。

### Notifier（notifier.ts）

- `createNotifier({barkUrl?, ntfyUrl?, fetchFn?}): (title, body) => Promise<void>`；都不配 → no-op（不发请求）；**都配时取 Bark**。Bark：`POST {url}/{encode(title)}/{encode(body)}`；ntfy：`POST {url}?title={encode(title)}`、body 为正文（title 走查询参数避开 HTTP 头非 ASCII 限制）。
- 失败（fetch reject 或非 2xx）仅 `console.warn`，返回的 Promise 永不 reject，可安全 fire-and-forget。
- `createNotifierFromEnv(env?, fetchFn?)` 给 06 接线 `BARK_URL`/`NTFY_URL` 用。谁在何时调 `notify` 由 06 决定（建议：`approval` 事件 → "待审批"，`run` 终态 → "任务完成"）。

## activityGate 最终接口签名（给 03/06）

```ts
// packages/daemon/src/run/runner.ts 导出
export interface ActivityGate {
  isIdle(sessionId: string): boolean;
  beginRun(sessionId: string): void;
  endRun(sessionId: string): void;
}
```

与 03 的 `ActivityTracker`（`getStatus/beginRun/endRun`，均同步幂等）对齐无缝，06 装配一行适配：

```ts
const gate: ActivityGate = {
  isIdle: (id) => tracker.getStatus(id) === "idle",
  beginRun: (id) => tracker.beginRun(id),
  endRun: (id) => tracker.endRun(id),
};
```

409 响应体需要的具体 status（`terminal-driving`/`daemon-driving`）由 06 捕获 `NotIdleError` 后调 `tracker.getStatus()` 获取（Runner 不感知三态枚举）。

## Runner 事件流与审批事件 payload 样例（给 05/06）

`TurnHandle.events`（06 的 WS 层从中转发 `run` 帧；`worker` 事件当前契约不直接上 WS，message 帧走 watcher）：

```jsonc
{"type":"run","runId":"3f2c…","sessionId":"3e8a…","state":"started"}
{"type":"worker","runId":"3f2c…","sessionId":"3e8a…","event":{"type":"session","sessionId":"3e8a…"}}
{"type":"worker","runId":"3f2c…","sessionId":"3e8a…","event":{"type":"assistant","text":"好的…","messageId":"m1"}}
{"type":"worker","runId":"3f2c…","sessionId":"3e8a…","event":{"type":"tool_use","toolUseId":"t1","toolName":"Bash","input":{"command":"ls"},"messageId":"m1"}}
{"type":"run","runId":"3f2c…","sessionId":"3e8a…","state":"done"}          // 或 {"state":"error","error":"aborted"}
```

`ApprovalBridge` 的 `onEvent`（与契约 WS 帧同构，06 直接转发即可）：

```jsonc
// approval 卡（kind=approval）
{"type":"approval","interaction":{
  "interactionId":"Y2FyZC1pZC0x…","sessionId":"3e8a…","kind":"approval",
  "toolName":"Bash","input":{"command":"ls"},"prompt":"Run Bash?","expiresAt":1752825900000
}}
// question 卡（多题已拆单题，questions 恒为单元素；input 为该卡的拆分负载）
{"type":"approval","interaction":{
  "interactionId":"cS1jYXJkLTI…","sessionId":"3e8a…","kind":"question",
  "toolName":"AskUserQuestion","input":{"questions":[{…q1}]},"prompt":"Which database?",
  "expiresAt":1752825900000,
  "questions":[{"question":"Which database?","header":"DB","multiSelect":false,
                "options":[{"label":"SQLite","description":"local file"},{"label":"Postgres","description":"server"}]}]
}}
// 决议（decide / TTL 超时 / 重启 deny 均落库后按终态发，Set 去重恰一条）
{"type":"approval.resolved","interactionId":"Y2FyZC1pZC0x…","status":"allowed"}   // allowed|denied|answered|expired
```

`decide(interactionId, decision): DecideOutcome` 与 06 的 HTTP 映射：`{status:"allowed"|"denied"|"answered"}`→200、`{status:"not_found"}`→404、`{status:"already_resolved"}`→409、`{status:"invalid",message}`→400。

## 遗留问题（均非阻塞）

1. **无 waiter 的过期不发 `approval.resolved`**：run 被 abort 后交互仍 pending，TTL 到期由 manager 内部 timer auto-deny，此时没有 awaitDecision 续体、也没人 decide → 不 emit。影响仅限"网页残留一张已死卡片直到刷新"；05 可在收到 `run` 终态时清掉该会话未决卡片规避。根治需给 InteractionManager 加 expire 钩子（动 interactions 包，超出本卡所有权）。
2. `#resolvedEmitted` 去重 Set 随进程生命周期增长（每交互一条 string，量级可忽略）；若未来做常驻多年进程可改 TTL 清理。
3. TurnRunner 无全局 shutdown（逐 run `abort` 已够 06 用）；daemon 退出时对活跃 run 统一 abort 由 06 装配层做。
4. 通知触发点未接线（本卡只交付 notify 能力），Bark/ntfy 真机连通性验证归 M4/06。
