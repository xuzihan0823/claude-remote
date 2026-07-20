# 06 · 集成与真机验收（主窗口执行，不分发）

## 背景

02–05 交付库模块与前端后，主窗口把它们组装成可运行的 daemon 并完成真机验收。本卡由主窗口（拆卡的那个会话）执行。

## 目标

`pnpm dev` 一条命令起完整服务；手机 Safari 经 Tailscale 完成 M1–M5 全部验收。

## 文件所有权

- `packages/daemon/src/`（server.ts / config.ts / index.ts 及集成所需胶水）
- `.env.example` 最终核对、`PROGRESS.md` 更新
- 集成期修其他卡遗留问题时，先读对应报告，改动记入本卡报告

## 前置

- reports/01–05 全部到位；`pnpm typecheck && pnpm test` 全绿
- 阅读各报告的"给 06 的说明"，对齐 activityGate 接口与审批事件 payload

## 任务明细

1. **config.ts**：读 `docs/api-contract.md` 环境变量表，缺 `BRIDGE_TOKEN` 拒绝启动。
2. **server.ts**：node:http + ws：Bearer/token 鉴权、HTTP 端点按契约映射（NotIdleError→409、AlreadyResolved→409、not found→404）、WS subscribe 管理、静态托管 `web/`、watcher/activity/runner/approval 事件接线到 WS 广播、notifier 触发点（审批创建、run done/error）。
3. **index.ts**：装配 + SIGINT/SIGTERM 优雅退出（关 watcher、abort 活跃 run、关 DB）。
4. **互斥闭环**：ActivityTracker 实现 04 的 activityGate 接口；daemon run 落盘行经 watcher 推给订阅者（自己驾驶也实时回显）。
5. **验收清单**（逐项记录到报告）：
   - M1：列表/历史与 `claude --resume` 对照一致；
   - M2：终端聊，网页实时滚出（含本会话窗口自身）；
   - M3（核心）：网页发送 → 回显 → 终端 `claude --resume` 看到手机轮次；
   - M4：触发 Bash 审批 → 手机允许/拒绝生效、超时 deny、Bark 通知（配了则验）；
   - M5：终端驾驶中网页置灰；120s 后回 idle；手机 Safari 经 Tailscale 全流程 + PWA 加主屏。
6. 收尾：PROGRESS.md 更新为"阶段一完成"，记录 CLI 版本、遗留问题、阶段二候选改进。

## 验收标准

M1–M5 全过且有记录；`pnpm typecheck && pnpm test` 全绿；`.env.example` 与实现一致。

## 结果报告

`reports/06-integration.md`：验收记录（含截图/输出）、集成期修改清单、遗留问题与阶段二建议。
