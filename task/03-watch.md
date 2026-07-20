# 03 · 实时 watcher + 驾驶状态机

## 背景

终端里聊天时 JSONL 实时逐行追加（已实测）。本卡实现"实时旁观"与"驾驶互斥"两个能力：增量 tail 推送新消息、判定会话当前由谁驾驶。设计见 `docs/design.md` 决策 4，状态语义见 `docs/api-contract.md`"状态语义"节。

## 目标

`packages/daemon/src/watch/` 模块：订阅某会话后能收到增量 RenderMessage 事件；任意时刻能查询会话状态 `idle | terminal-driving | daemon-driving`，状态变化有事件。

## 文件所有权

- `packages/daemon/src/watch/**`（watcher.ts / activity.ts）
- `packages/daemon/__tests__/watch*.test.ts`（fixture 可复用 02 的目录，新增文件放 `__tests__/fixtures/watch/`）

## 必读上下文

- `docs/api-contract.md`（WS message/status 事件、状态语义、ACTIVITY_COOLDOWN_MS）
- `packages/daemon/src/transcript/types.ts` 与 reader 的行解析函数（02 卡交付，复用其解析，**不得重新实现**）

## 任务明细

1. **watcher.ts**：`class SessionWatcher`：
   - `watch(sessionId)` / `unwatch(sessionId)`；内部记录每文件 offset，新增字节 → 逐行 → 02 的解析 → emit `{sessionId, message: RenderMessage}`；
   - 监听手段：目录级 `fs.watch` 为主，**500ms mtime 轮询兜底**（FSEvents 丢事件时保底）；两路去重靠 offset；
   - 文件变小（截断/替换）→ 重置 offset 并 emit resync 事件（消费方全量重拉）；
   - 半行写入处理：残行缓存，凑齐换行再解析；
   - 主链注意：增量行天然是链尾追加，直接输出；若增量行 parentUuid 不指向已知链尾（外部 fork 等），emit resync。
2. **activity.ts**：`class ActivityTracker`：
   - 三态机；输入：watcher 的写入事件（时间戳）、Runner 的 `beginRun(sessionId)` / `endRun(sessionId)`（04 卡会调，本卡只定义接口）；
   - 规则：有活跃 run → `daemon-driving`（run 期间的文件写入不算外部信号）；非 run 期间写入 → `terminal-driving`，最后写入后 `cooldownMs`（默认 120_000，可配）无写入 → `idle`；
   - `getStatus(sessionId)` + `onChange` 事件；clock/timer 可注入，测试确定性（参考旧项目 `/Users/mac/Desktop/qq-claude-bridge/packages/mac-worker/src/wire.ts` 的 Scheduler 注入手法）。
3. 事件接口用 Node `EventEmitter` 或轻量 typed-emitter 自写，不引第三方依赖。

## 约束

- 对 `~/.claude` 只读；测试用临时目录 + 注入 clock，不 sleep 实测时间。
- watcher 停止后不得遗留 timer/fd（`unref` 或显式清理，测试验证进程可退出）。

## 验收标准

`pnpm --filter @claude-remote/daemon test` 全绿，覆盖：增量追加事件、半行、轮询兜底路径（禁用 fs.watch 模拟）、truncation resync、三态全部迁移路径（含 run 期间写入不触发 terminal-driving）。

## 依赖与并行

依赖 01、02（复用解析与类型）。建议在 02 的窗口完成后接续执行。

## 结果报告

`reports/03-watch.md`：实现要点、fs.watch 在 macOS 上的实际行为记录、给 04（beginRun/endRun 接口）与 06（事件接线）的说明。
