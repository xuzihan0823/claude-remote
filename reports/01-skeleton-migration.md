# 报告 · 01 仓库骨架 + 复用代码迁移

状态：**完成**。`pnpm install && pnpm typecheck && pnpm test` 全绿（node v24.14.1 ≥ 22.5，pnpm 10.33.0）。测试 13 个全过（interactions 7 + agent-bridge 5 + daemon 1）。`grep -r "qq-render\|qq-adapter" packages/` 无结果。`pnpm dev` 打印 `@claude-remote/daemon 0.1.0` 后退出（exit 0）。

## 目录树

```
claude-remote/
├── package.json              # workspace 根：dev / test / typecheck 脚本，engines.node >=22.5
├── pnpm-workspace.yaml       # packages/*
├── tsconfig.json             # 根 tsc：NodeNext + strict 全家桶 + noEmit
├── .env.example              # 按 docs/api-contract.md 环境变量表生成
└── packages/
    ├── interactions/         # @claude-remote/interactions（审批状态机，SQLite）
    │   ├── package.json / tsconfig.json
    │   ├── src/{index,manager,store,types,sdk-contract}.ts
    │   └── __tests__/manager.test.ts
    ├── agent-bridge/         # @claude-remote/agent-bridge（SDK 桥）
    │   ├── package.json / tsconfig.json
    │   ├── src/{index,types,sdk-bridge,permission-adapter,event-adapter}.ts
    │   └── __tests__/{permission,event-adapter}.test.ts
    └── daemon/               # @claude-remote/daemon（空壳）
        ├── package.json / tsconfig.json
        ├── src/index.ts      # 仅打印名称+版本后退出
        └── __tests__/smoke.test.ts
```

## 复制文件改动清单

来源 `/Users/mac/Desktop/qq-claude-bridge/`（下称"旧"）。**逐字节一致（零改动）**的复制：

| 新位置 | 旧位置 |
|---|---|
| `interactions/src/manager.ts` | `interactions/src/manager.ts` |
| `interactions/src/store.ts` | `interactions/src/store.ts` |
| `interactions/src/types.ts` | `interactions/src/types.ts` |
| `interactions/src/sdk-contract.ts` | `interactions/src/sdk-contract.ts` |
| `agent-bridge/src/sdk-bridge.ts` | `mac-worker/src/sdk-bridge.ts` |
| `agent-bridge/src/permission-adapter.ts` | `mac-worker/src/permission-adapter.ts` |
| `agent-bridge/src/event-adapter.ts` | `mac-worker/src/event-adapter.ts` |
| `agent-bridge/__tests__/permission.test.ts` | `mac-worker/__tests__/permission.test.ts` |
| `agent-bridge/__tests__/event-adapter.test.ts` | `mac-worker/__tests__/event-adapter.test.ts` |

有改动的文件：

- **`interactions/src/index.ts`**：删除 `bypass.js` / `commands.js` / `dispatcher.js` 三行 re-export，其余保留。
- **`interactions/__tests__/manager.test.ts`**（9 测试 → 7）：
  - 删 `InteractionBypass` import；测试数据 `sessionKey: "qq:dm:user-1"` → `"session-1"`；
  - "first button or text resolution wins…" 改为直接调 `manager.resolve` 两次（第二次断言 `InteractionAlreadyResolvedError`），语义不变（重复决议拒绝）；
  - "Question accepts numeric option callback…" 改为直接 `manager.resolve` 提交 answer，保留 `decisionToAgentSdkResult` 映射断言（更名 "question resolution records answers and maps to SDK result"）；
  - 删除 2 个纯 QQ 文本命令测试（`/answer` 数字选项、`/answer` 自由文本）——被测代码（commands/bypass）已删；
  - "non-owner QQ user…" 测试更名去掉 "QQ"（断言逻辑不变）。
- **`interactions/package.json`**：包名 → `@claude-remote/interactions`；删 `dependencies`（原仅 `file:../qq-render`）；补 `engines.node >=22.5`；scripts 不变。
- **`agent-bridge/src/types.ts`**：裁剪版，仅保留三个被复制文件所需的 `WorkerEvent` 与 `InteractionDecision`（文本与旧文件逐字一致）；删 `Source`/`GatewayEvent`/`GatewayResponse`/`RunCompletion`/`RunHandle`/`Runner`（wire/worker 专属）。
- **`agent-bridge/src/index.ts`**：新写，仅 re-export 保留的 4 个模块。
- **`agent-bridge/package.json`**：基于旧 mac-worker 包；包名 → `@claude-remote/agent-bridge`；依赖仅留 `@anthropic-ai/claude-agent-sdk@0.3.212`（精确锁定，沿用旧版本），删 `ws`/`yaml`/`@types/ws`（仅 wire/worker/projects 需要）；engines 20 → 22.5（仓库统一）。
- **各包 `tsconfig.json`**：沿用旧 compilerOptions，统一改为 `noEmit: true`（零构建项目），删除旧的 `declaration`/`outDir`；interactions 另删 `rootDir: "../.."`（原为跨包相对导入 qq-render 而设，现无必要）。

## 删除（未复制）文件及理由

| 文件 | 理由 |
|---|---|
| `interactions/src/dispatcher.ts` + `__tests__/dispatcher.test.ts` | 生成 QQ 键盘消息，Web 版走 WS 卡片 + HTTP API |
| `interactions/src/bypass.ts`、`src/commands.ts` | QQ 文本命令（`/allow` `/deny` `/answer`）解析，Web 版用按钮 |
| `interactions/package-lock.json` | 本仓库只有根 `pnpm-lock.yaml` |
| `mac-worker/src/wire.ts`、`worker.ts`、`projects.ts`、`session-store.ts` 及其测试 | 线协议/HMAC/白名单/独立会话存储，本项目无 relay、以 `~/.claude/projects` 为唯一真相 |

## 关键决定（偏离卡面处均已列出）

1. **根 tsc 的 include** 含 `packages/*/src`、`packages/*/__tests__` 以及（尚不存在的）`scripts/`、`tests/`：骨架期根目录没有 TS 文件，纯 scripts/tests include 会让 `tsc -p` 报 "No inputs"；现方案让根 tsc 有输入、并在单一编译图里再验证一次跨包解析。
2. **workspace 包导入方式**：`exports: { ".": "./src/index.ts" }` + `workspace:*`，tsc（NodeNext）与 tsx 均可解析——旧项目 relay 按包名导入 qq-adapter/qq-render 的同款先例，已由 daemon 的 typecheck/test 实证。
3. **daemon 占位测试**做成 wiring 冒烟（导入两个 workspace 包、开一个内存 SQLite store），比恒真断言多验证了 workspace 解析与 `node:sqlite` 可用性。
4. `manager.ts` 最终**逐字节保留**旧文件，其中未授权错误消息仍为 "interaction belongs to a different QQ user"（仅内部错误文案，测试不断言该文本；04 卡做错误映射时可自行决定是否改写）。
5. `engines.node >=22.5` 的原因已用 `"//"` 键注明在根 package.json（`node:sqlite` 的 `DatabaseSync` 自 22.5 提供）。运行时会打 SQLite ExperimentalWarning，无碍。

## 给并行卡（02 / 04 / 05）的注意事项

- **目录结构已冻结**：新代码进 `packages/daemon/src/`（02/03/04）与 web 静态目录（05，路径由该卡自定，建议 `web/`）；不要动三个包的既有文件布局。
- **根配置只有 01 可动**：缺依赖/脚本/tsconfig 调整，写进你的报告由主窗口合并。注意根 tsconfig include 目前覆盖 `packages/*/{src,__tests__}`——若 05 的 web 是 TS + DOM lib，需在报告里提出调整（如从根 include 排除）。
- **审批链用法**：`InteractionManager.createApproval/createQuestion` + `awaitDecision`（带 AbortSignal）→ HTTP 决议走 `manager.resolve(id, userId, decision)`；语义为一次性授权、TTL 超时 auto-deny、重启 auto-deny。`userId` 概念保留（本项目单用户，传固定值即可，如 `"web"`——由 04 卡定）。
- **SDK 桥用法**：`startSdkQuery({cwd, prompt, canUseTool, resume, signal})`；`createPermissionAdapter(broker, context, {timeoutMs})` fail-closed（超时/中断一律 deny）；`adaptSdkMessage` 把 SDKMessage 展平成 `WorkerEvent[]`。
- **类型重复是有意的**：`agent-bridge` 的 `InteractionDecision` 与 `interactions` 的 `Decision` 结构相同但各自声明（沿旧项目边界）。04 卡桥接两包时用结构兼容性直接传递即可，勿合并声明。
- `pnpm test` 输出带 SQLite ExperimentalWarning 属正常；测试统一 `tsx --test __tests__/*.test.ts`（node:test）。
