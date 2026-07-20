# 03 · 实时 watcher + 驾驶状态机 — 结果报告

状态：**完成**。`pnpm --filter @claude-remote/daemon test` 38 个测试全绿（02 交付的 17 个 + 本卡新增 21 个）；全仓 `pnpm typecheck && pnpm test` 全绿（interactions 7 + agent-bridge 5 + daemon 38）。另做真机只读冒烟（见文末）。

## 交付文件

```
packages/daemon/src/watch/
├── watcher.ts    # SessionWatcher：增量 tail、fs.watch + 轮询兜底、resync、write 事件
└── activity.ts   # ActivityTracker：idle | terminal-driving | daemon-driving 三态机
packages/daemon/__tests__/
├── watch-watcher.test.ts             # 12 测试
├── watch-activity.test.ts            # 9 测试
└── fixtures/watch/fake-scheduler.ts  # 注入用假时钟/定时器（测试不 sleep 实测时间）
```

## 实现要点

### SessionWatcher

- **行解析零重复**：完全复用 02 的 `parseTranscriptLine`（纯函数）。watcher 只做字节 → 行切分（半行 Buffer 缓存，按 `0x0a` 切，多字节 UTF-8 切半不坏）、seq 计数、链尾校验。
- **seq 对齐**：`watch()` 时顺序轻扫一遍现有文件（只提取 uuid/parentUuid/isSidechain，即读即弃，手法同 02 的 scanLines），得到完成行数 = 尾行 seq、链尾 uuid、尾部半行缓存。此后每见一个换行 `lineCount+1` 即该行 seq，与 reader 分页的物理行号语义完全一致——消费方用 seq 去重即可无缝衔接 readTail。
- **两路监听、offset 去重**：目录级 `fs.watch`（persistent:false、错误静默）为主，500ms stat 轮询保底；两路都汇入同一个 `#poll`，size===offset 即空转，天然去重。同目录多会话共享一个目录监听（引用计数）。单会话 poll 串行化（进行中再触发只置 dirty，结束补一轮），不会交错读。
- **truncation**：stat.size < offset → 重扫全文件重建 seq/链尾/半行缓存，emit `resync("truncated")`。文件短暂消失（替换中）跳过本轮，替换完成表现为 size 变化。
- **链尾校验**：非 sidechain 且带 uuid 的增量行，parentUuid ≠ 已知链尾 → emit `resync("chain-mismatch")`，该行不推送（消费方全量重拉，seq 去重防重复），链尾更新为该行后续继续正常增量。链穿过 attachment/system/isMeta 行（02 实测事实）不误报——这些行带 uuid，照常参与链尾推进，只是 parse 产出 0 条。
- **write 事件**：以 stat.size 变化为信号（追加型写入必然变 size），带注入时钟的时间戳，供 ActivityTracker 消费。同尺寸原地改写不触发（mtime-only），实际场景不存在该写法，且链校验兜底。
- **清理**：所有 timer 走可注入 Scheduler（生产实现 setTimeout+unref），fs.watch persistent:false + 显式 close；最后一个会话 unwatch 后轮询 timer 清空。测试用注入的记录型工厂 + FakeScheduler.pending===0 断言验证；真机冒烟脚本 close 后进程自然退出。
- 公开 `pollNow(sessionId?)`：立即轮询并等待完成，测试确定性驱动，也可供 06 做手动刷新。
- `watch()` 对不存在的会话抛 `code:"ENOENT"` 错误，HTTP 层转 404。

### ActivityTracker

- 规则严格按契约"状态语义"节：活跃 run → `daemon-driving`（期间 `noteWrite` 直接忽略）；非 run 写入 → `terminal-driving` 并（重）挂 cooldown（默认 120_000，可配 `cooldownMs` ← `ACTIVITY_COOLDOWN_MS`）；到期检查以最后写入时间戳为准，未满静默期按剩余量重挂（时钟注入下的防御）。
- `getStatus` 对未知会话返回 `idle`；回落 idle 且无 run 的条目从 Map 删除，长期运行不膨胀。
- `onChange`：EventEmitter `"change"` 事件 `{sessionId, status}`，仅状态实际变化时发出（持续终端驾驶只报一次）。
- clock/scheduler 注入手法沿用旧项目 wire.ts 的 `Scheduler` 接口（`set/clear`），`Scheduler`/`systemScheduler` 从 watcher.ts 导出、activity.ts 复用。

## fs.watch 在 macOS 上的实际行为记录

- 目录级 `fs.watch`（FSEvents）对"已存在文件被追加"可靠触发，且延迟极低：测试里 append 后 `await once(watcher,"message")` 即刻返回（整个用例 5.3ms，轮询定时器全程未推进，证明事件来自 FSEvents 主路）。
- 回调的 `filename` 参数在 macOS 上实测有值；实现对 `filename===null` 的兜底是 poll 该目录下全部订阅会话。
- `persistent:false` 的 fs.watch 不阻止进程退出，配合 unref 的 setTimeout，close 后无需 process.exit 进程即退——冒烟脚本实测如此。
- FSEvents 偶发丢事件（历史已知问题）无法在测试中稳定复现，兜底路径用"禁用 fs.watch + 假定时器推进 500ms"模拟验证（卡面要求的模拟方式）。

## 真机冒烟（只读）

临时脚本（未入仓）以真实 `~/.claude/projects` 为源、订阅执行本卡的这个会话自身，旁观 20 秒：

```
watching f979756e-3857-4147-a825-cb3b14fe1775 for 20s ...
WRITE at=2026-07-18T10:19:36.809Z
MSG seq=186 block=0 user/tool_result started
closed
```

窗口内本会话恰好落盘一条 tool_result（内容 "started"，正是当时刚返回的 Bash 结果），watcher 实时捕获且 seq/kind/role 正确、零误报 resync；close 后进程干净退出。完整的"终端聊天、网页同步滚出"验收属 M2，由 06 做。

## 给 04 的说明（beginRun/endRun 接口）

- 接口：`ActivityTracker.beginRun(sessionId)` / `endRun(sessionId)`，同步方法，幂等（重复 begin 无副作用，未 begin 的 end 是 no-op）。
- 调用时序：**POST messages 处理器在发起 SDK query 前调 `beginRun`**（互斥检查 `getStatus()==="idle"` 通过后立即调，防检查-发起间隙被判 terminal-driving）；**`endRun` 必须在 run 完全 settle、SDK 最后一行落盘之后调**——endRun 后到达的文件写入会被判外部信号，把会话错标 terminal-driving 120 秒。SDK query 的 async iterator 耗尽即代表 CLI 侧写入结束，在那之后调 endRun 即可。
- run 期间 watcher 照常推 `message` 事件（契约注明 WS message"含 daemon 自跑轮次落盘的行"），activity 只是不把这些写入算外部信号，两者不冲突。

## 给 06 的说明（事件接线）

- 接线关系：
  - `watcher.on("write", e)` → `tracker.noteWrite(e.sessionId, e.at)`；
  - `watcher.on("message", e)` → WS `{"type":"message",...}`（仅推给订阅了该会话的连接）；
  - `tracker.on("change", e)` → WS `{"type":"status",...}`；`GET /api/sessions` 的 `status` 字段用 `tracker.getStatus()` 覆盖 02 的恒 idle；
  - `watcher.on("error")` 记日志即可（poll 自愈，不影响后续轮次）。
- **resync 的客户端语义是"全量重拉"，但契约 v1 的 WS 帧没有对应类型**——建议 06 提请主窗口在契约加 `{"type":"resync","sessionId":"…"}` 帧（客户端收到后重新 `GET messages` 并清空本地列表）；不加帧的替代方案是 06 在 daemon 内收 resync 后主动断开该会话订阅者迫使重连补拉，不如加帧干净。
- `watch()` 是 async（定位文件 + 初扫），subscribe 处理器需 await 并把 ENOENT 转 404/订阅失败帧。
- watcher 构造参数 `projectsDir` 必须注入（默认值 `~/.claude/projects` 由装配层给，同 02 的 listSessions 约定）。

## 偏离卡面与遗留

1. `Scheduler` 接口定义在 watcher.ts 内由 activity.ts 复用，未新开第三个源文件（卡面文件清单只列 watcher.ts/activity.ts，从其规定）。
2. 测试辅助 `fake-scheduler.ts` 放在 `__tests__/fixtures/watch/`（卡面授权的新增 fixture 目录），非 `*.test.ts` 不被 test runner 收集。
3. 事件接口用 Node `EventEmitter` + override 方法签名收窄成 typed（卡面允许的第一种方案），零第三方依赖，未新增任何运行时依赖。
4. 无阻塞遗留。非阻塞備忘：chain-mismatch 校验对"带 uuid 但 parentUuid 合法地不指向链尾"的未知新行型理论上会误报 resync——resync 的代价只是一次全量重拉，语义安全；真机冒烟未出现误报。
