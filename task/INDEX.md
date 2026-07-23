# 任务总览

| 卡 | 标题 | 依赖 | 并行组 | 状态 |
|---|---|---|---|---|
| [01](01-skeleton-migration.md) | 仓库骨架 + 复用代码迁移 | 无 | 先行（阻塞全部） | ✅ 完成（reports/01） |
| [02](02-transcript.md) | 会话索引器 + JSONL 解析/渲染链 | 01 | A | ✅ 完成（reports/02） |
| [03](03-watch.md) | 实时 watcher + 驾驶状态机 | 01, 02 | 02 完成后串行（建议同窗口接续） | ✅ 完成 |
| [04](04-run.md) | SDK resume Runner + 审批桥 + 推送 | 01 | A | ✅ 完成 |
| [05](05-web.md) | Web UI（对 mock 开发） | 01 | A | ✅ 完成（reports/05） |
| [06](06-integration.md) | 集成、真机验收（主窗口执行，不分发） | 02–05 | — | ✅ 完成（reports/06） |
| [07](07-state-layer-extraction.md) | iOS UI 重构 T1：状态层抽离 | 06 | 先行（阻塞 T2–T4 前端） | ✅ 完成（2026-07-22） |
| [08](08-permission-mode-frontend.md) | 权限模式·前端全链路（T4） | 07 | 与视觉收尾并行（文件不重叠） | ✅ 完成（reports/08，主窗口代实施） |

## 依赖图

```
01 ──┬── 02 ── 03 ──┐
     ├── 04 ────────┼── 06（主窗口）
     └── 05 ────────┘
```

执行节奏：01 单窗口先做完 → 02 / 04 / 05 三窗口并行 → 03 在 02 的窗口接续 → 全部报告返回后主窗口做 06。

## 所有窗口共同约束

1. 先读 `docs/design.md` 与 `docs/api-contract.md`，再读自己卡里的"必读上下文"。
2. 只允许修改本卡"文件所有权"列出的路径；根配置（package.json / tsconfig / pnpm-workspace.yaml / .env.example）只有 01 卡可动，其余卡缺什么在报告里提。
3. TypeScript strict（沿用 01 建立的 tsconfig），零构建（tsx 直跑），测试统一 `tsx --test`（node:test），不引入本卡未声明的运行时依赖。
4. 对 `~/.claude/` 一律只读；测试不得依赖真实 `~/.claude`，用 fixture + 可注入目录。
5. 所有异步路径显式 settle，禁止无消费者的 promise（qq-claude-bridge 审查教训）。
6. 完成后：`pnpm typecheck && pnpm test` 全绿，写报告到 `reports/NN-*.md`（做了什么、关键决定、偏离卡面的地方、遗留问题、给 06 集成的注意事项）。
