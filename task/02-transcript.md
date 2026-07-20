# 02 · 会话索引器 + JSONL 解析/渲染链

## 背景

数据真相是 `~/.claude/projects/<编码路径>/<sessionId>.jsonl`，一个文件一个对话（已实测：resume 同文件追加）。本卡实现"读"的一半：扫描会话列表 + 把 JSONL 行解析成渲染用消息流。设计见 `docs/design.md`，输出结构必须严格符合 `docs/api-contract.md` 的 `SessionSummary`（GET /api/sessions 条目）与 `RenderMessage`。

## 目标

`packages/daemon/src/transcript/` 模块：给定项目目录能列出会话摘要、按 seq 分页读出主链 RenderMessage，容错所有未知行。

## 文件所有权

- `packages/daemon/src/transcript/**`（types.ts / indexer.ts / reader.ts）
- `packages/daemon/__tests__/transcript*.test.ts`、`packages/daemon/__tests__/fixtures/**`
- `packages/daemon/scripts/demo-list.ts`（演示脚本）

## 必读上下文

- `docs/api-contract.md`（RenderMessage 映射规则、SessionSummary 字段——本卡的规格书）
- `docs/design.md` 决策 1/2/3
- 真实样例参考（只读）：`ls -t ~/.claude/projects/-Users-mac/*.jsonl | head -3`，观察行结构；fixture 需手写脱敏版本

## 任务明细

1. **types.ts**：`RenderMessage`（含 `blockIndex`）、`SessionSummary`、解析器接口。此文件是 03 卡的依赖，字段以 api-contract 为准，交付后不可破坏性变更。
2. **indexer.ts**：`listSessions(projectsDir): Promise<SessionSummary[]>`。cwd 从行内 `cwd` 字段读（不从目录名反解）；title = 首条真实 user 文本截 60 字（剥 `<local-command-caveat>` 等包裹标签、跳过 `isSidechain`、跳过纯 tool_result 行），空会话给 `"(空会话)"`；lastActiveAt 用文件 mtime；status 字段本卡固定填 `"idle"`（03 卡负责真实状态）。目录不存在返回空数组。
3. **reader.ts**：
   - `readTail(file, limit)` / `readBefore(file, beforeSeq, limit)`：**尾部块读**（从文件尾按块回退找行边界），不全量读；seq = 1 起行号。
   - 行 → RenderMessage 映射：严格按 api-contract 规则（user/assistant blocks 拆分、sidechain 隐藏、元数据行跳过、未知 type → kind:meta + rawType、坏 JSON 行跳过并计数）。
   - **主链回溯**：文件最后一条 user/assistant 消息沿 parentUuid 回溯标记主链，链外行不输出。注意：分页窗口内可能拿不全链——实现允许对 tail 窗口先整文件扫 uuid→parentUuid 索引（仅索引不 parse 全文，读每行的 uuid/parentUuid/type 三字段即可），窗口内再完整 parse。
4. **fixtures**：手写至少 4 个 JSONL：①纯文本多轮 ②含 tool_use/tool_result/thinking ③含 fork 分叉 + sidechain + 未知 type 行 + 坏行 ④空/仅元数据。不得依赖真实 `~/.claude`。
5. **demo-list.ts**：对真实 `~/.claude/projects` 只读列出最近 10 个会话（title/cwd/时间），供人工比对 `claude --resume` 选择器。

## 约束

- 对 `~/.claude` 只读；所有 API 接受注入的目录参数（默认值才是 `~/.claude/projects`）。
- 大文件性能意识：4MB 文件 readTail(100) 不应读入超过约 1MB。

## 验收标准

`pnpm --filter @claude-remote/daemon test` 全绿；`tsx packages/daemon/scripts/demo-list.ts` 输出与 `claude --resume` 选择器人工比对一致（报告贴输出截屏/文本）。

## 依赖与并行

依赖 01。与 04、05 并行（并行组 A）。03 依赖本卡的 types.ts 与行解析函数——完成后建议同窗口继续做 03。

## 结果报告

`reports/02-transcript.md`：实现要点、映射规则的边界决定（遇到卡面没覆盖的行类型如何处理）、性能测量（大文件 readTail 耗时）、给 03/06 的接口说明。
