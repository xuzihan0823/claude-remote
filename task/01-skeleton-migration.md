# 01 · 仓库骨架 + 复用代码迁移

## 背景

本项目 claude-remote：手机经 Tailscale 用 Web 界面查看/续聊 Mac 本机 Claude Code 会话。整体设计见 `docs/design.md`。本卡建立 pnpm monorepo 骨架，并从旧项目 `/Users/mac/Desktop/qq-claude-bridge/`（已代码审查、测试全绿）复制可复用的审批与 SDK 桥代码。

## 目标

`pnpm install && pnpm typecheck && pnpm test` 全绿的可开发骨架，含迁移完成的 `packages/interactions` 与 `packages/agent-bridge`，以及空壳 `packages/daemon`。

## 文件所有权（只允许动这些）

- 根：`package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、`.env.example`
- `packages/interactions/**`、`packages/agent-bridge/**`、`packages/daemon/**`（本卡仅建骨架）

## 必读上下文

- `docs/design.md`、`docs/api-contract.md`（环境变量表）
- 旧项目根配置参考：`/Users/mac/Desktop/qq-claude-bridge/package.json`、`tsconfig.json`

## 任务明细

1. **根配置**：pnpm workspace（`packages/*`）；根 scripts：`dev`（tsx packages/daemon/src/index.ts）、`test`（pnpm -r --if-present test）、`typecheck`（pnpm -r --if-present typecheck + 根 tsc）；`engines.node >= 22.5`（原因：interactions 用 `node:sqlite`，在 package.json 注明）。tsconfig 沿用旧项目风格：NodeNext、strict、exactOptionalPropertyTypes、noUncheckedIndexedAccess、verbatimModuleSyntax、noEmit。
2. **迁移 interactions**：复制 `/Users/mac/Desktop/qq-claude-bridge/packages/interactions/` 全包 →`packages/interactions`，然后：
   - **删除** QQ 专属文件及其测试：`src/dispatcher.ts`、`src/bypass.ts`、`src/commands.ts`（Web 版用按钮 + HTTP API，无文本命令），`index.ts` 相应裁剪；
   - 删除对 `../../qq-render/*` 的一切引用（删完上述文件后应自然消失，验证之）；
   - package.json：包名 `@claude-remote/interactions`，补 `engines.node >= 22.5`，删除 `file:` 依赖，测试脚本统一 `tsx --test __tests__/*.test.ts`；
   - 删除包内 `package-lock.json`（本仓库只有根 pnpm-lock.yaml）。
3. **迁移 agent-bridge**：新建 `packages/agent-bridge`（包名 `@claude-remote/agent-bridge`），从 `/Users/mac/Desktop/qq-claude-bridge/packages/mac-worker/src/` 复制：`sdk-bridge.ts`、`permission-adapter.ts`、`event-adapter.ts`，以及 `types.ts` 裁剪版（仅保留这三个文件所需类型：InteractionDecision、WorkerEvent 等）。**不复制** wire.ts、worker.ts、projects.ts、session-store.ts（本项目不需要线协议/白名单/独立会话存储）。相应测试从 `__tests__/permission.test.ts`、`__tests__/event-adapter.test.ts` 迁移适配。依赖：`@anthropic-ai/claude-agent-sdk`（沿用旧项目版本 0.3.212）。
4. **daemon 骨架**：`packages/daemon`（`@claude-remote/daemon`），依赖上述两包（`workspace:*` 协议），`src/index.ts` 暂时只打印版本并退出；tsconfig/test 脚本就位（可放一个恒真测试占位）。
5. **`.env.example`**：按 `docs/api-contract.md` 的环境变量表生成。

## 约束

- 复制文件尽量少改动（只改 import 路径、包名、删依赖），保持与旧项目 diff 可读；每处功能性修改在报告中列出。
- 不实现任何业务功能；02/04/05 会在此骨架上并行开工，目录结构一旦交付不可再动。

## 验收标准

```sh
cd /Users/mac/Desktop/claude-remote
pnpm install && pnpm typecheck && pnpm test   # 全绿
node --version                                 # >= 22.5 说明文档一致
```

interactions 与 agent-bridge 的迁移测试全部通过；`grep -r "qq-render\|qq-adapter" packages/` 无结果。

## 依赖与并行

无依赖，**必须第一个执行**；完成前 02/04/05 不得开工。

## 结果报告

写入 `reports/01-skeleton-migration.md`：目录树、每个复制文件的改动清单、删除文件清单及理由、给并行卡的注意事项。
