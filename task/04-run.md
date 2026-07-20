# 04 · SDK resume Runner + 审批桥 + 推送

## 背景

手机续聊 = daemon 用 Agent SDK `query({resume: sessionId, cwd})` 驱动一轮对话；工具审批经 `canUseTool` → interactions 状态机 → WS 卡片 → 手机决定。复用代码已由 01 卡迁入 `packages/interactions` 与 `packages/agent-bridge`。设计见 `docs/design.md` 决策 5，审批 API 语义见 `docs/api-contract.md`。

## 目标

`packages/daemon/src/run/` 模块：`startTurn` 能对空闲会话发起 resume 续聊并产出事件流；审批请求可被外部决策接口 resolve；可选推送通知。

## 文件所有权

- `packages/daemon/src/run/**`（runner.ts / approval.ts / notifier.ts）
- `packages/daemon/__tests__/run*.test.ts`

## 必读上下文

- `docs/api-contract.md`（POST messages 语义、approval/approval.resolved WS 事件、decision 端点、环境变量）
- `packages/agent-bridge/src/`（01 迁入的 sdk-bridge / permission-adapter / event-adapter——直接复用，不重写）
- `packages/interactions/src/`（manager / store / sdk-contract）
- 测试手法参考：`/Users/mac/Desktop/qq-claude-bridge/packages/mac-worker/__tests__/worker.test.ts`（fake QueryFactory）、`tests/e2e/dev-worker.test.ts`（审批链路组装）

## 任务明细

1. **runner.ts**：`class TurnRunner`：
   - `startTurn({sessionId, cwd, text}): {runId, events, completion}`；
   - 前置检查经注入的 `activityGate: {isIdle(sessionId): boolean; beginRun; endRun}`（03 卡的 ActivityTracker 实现此接口；本卡只依赖接口定义，测试用 stub）——非 idle 抛 `NotIdleError`（06 映射 409）；
   - 每会话并发 = 1（Map 记录活跃 run；重复 startTurn 抛 NotIdleError）；
   - 调 `startSdkQuery({cwd, prompt: text, resume: sessionId, canUseTool, signal})`（agent-bridge），消费 messages 经 `adaptSdkMessage` 转 WorkerEvent 流出；
   - **completion 必须被内部消费并 settle**：正常/异常/abort 均 emit `run` 终态事件，绝不留悬空 promise（旧项目审查教训，写测试验证 rejection 不逃逸）；
   - `abort(runId)`；`endRun` 在 finally 里保证调用。
2. **approval.ts**：`class ApprovalBridge implements PermissionBroker`（agent-bridge 的接口）：
   - approval → `manager.createApproval` → emit `approval` 事件（供 WS 层）→ `awaitDecision(id, signal)`；
   - question → 按单题拆分串行（参考旧项目 dev-worker 的 splitQuestion 手法），全部答完合并 answers；
   - `decide(interactionId, decision)`：给 HTTP 层调用，返回 resolution；**必须捕获 AlreadyResolved / Unauthorized / TypeError 转成结构化结果**（旧项目审查教训：双击按钮不得抛裸异常），重复决策返回 `{status:"already_resolved"}`；
   - resolve/expire 时 emit `approval.resolved`；
   - 超时（PERMISSION_TIMEOUT_MS）与重启 auto-deny 由 interactions 包既有逻辑负责，验证接线正确即可。
3. **notifier.ts**：`notify(title, body)`：`BARK_URL`/`NTFY_URL` 二选一，POST；未配置则 no-op；失败仅 console.warn，不影响主流程；fetch 可注入。

## 约束

- `permissionMode` 固定 default，禁止任何 bypass/自动批准路径。
- 测试全部用 fake QueryFactory 与 mock fetch，不真调 SDK/网络；真机链路由 06 验收。
- interactions DB 路径来自参数（默认 `.data/interactions.sqlite`），测试用 `:memory:`。

## 验收标准

`pnpm --filter @claude-remote/daemon test` 全绿，覆盖：正常轮次事件流、gate 拒绝、并发=1、abort、审批 allow/deny/超时 deny/重复决策、question 多题串行合并、completion 无逃逸 rejection（`process.on("unhandledRejection")` 探针测试）、notifier 三态。

## 依赖与并行

依赖 01。与 02、05 并行（并行组 A）；与 03 无文件交集，仅共享 `activityGate` 接口定义（写在本卡 runner.ts 内 export，03 报告里对齐）。

## 结果报告

`reports/04-run.md`：实现要点、activityGate 最终接口签名（给 03/06）、审批事件 payload 样例（给 05/06）、遗留问题。
