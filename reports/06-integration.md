# 06 · 集成与真机验收 — 结果报告

状态：**代码集成完成，M1–M4 真机验收通过；M5 的 120s 回落观察与手机端（Tailscale/PWA）待验**。
`pnpm typecheck && pnpm test` 全绿（84 个：interactions 7 + agent-bridge 5 + daemon 72，本卡新增 server 集成测试 8 个）。

## 交付文件

```
packages/daemon/src/
├── config.ts          # env → DaemonConfig；缺 BRIDGE_TOKEN / 数值非法 → ConfigError 拒启
├── server.ts          # DaemonServer：node:http + ws、鉴权、端点映射、WS 订阅广播、静态托管、事件接线
├── session-files.ts   # sessionId → JSONL 定位（ENOENT→404）+ 头部扫 cwd（胶水）
└── index.ts           # 装配入口 + SIGINT/SIGTERM 优雅退出（abort 活跃 run → 关 watcher/tracker/DB）
packages/daemon/__tests__/server.test.ts   # 8 个集成测试（真 HTTP/WS + fake SDK）
.env                   # 本机验收配置（token/8788；不入 git）
```

## 实现要点

- **鉴权**：HTTP `Authorization: Bearer` 与 WS `?token=` 都过 sha256 + `timingSafeEqual`；`/api/*` 一律 401 兜底（health 也鉴权，05 的理解）；静态文件不鉴权（前端要先加载才能弹 token 窗）。
- **端点映射**：`NotIdleError→409 {error:"not_idle",status}`（status 由 tracker 现查）、`already_resolved→409`、ENOENT→404、decide 的 DecideOutcome 按 04 报告映射 200/404/409/400。
- **互斥闭环**：ActivityGate 用 04 报告的一行适配接 ActivityTracker；POST messages 不自己做互斥检查（Runner 内部同 tick 闭环）。
- **WS 广播语义**：message/resync/run → 该会话订阅者；status → 订阅者 + `"*"`；approval / approval.resolved → 全连接广播（05 对表第 4 条，契约已注明）。watcher 按订阅计数 watch/unwatch（并发 subscribe 竞态已处理）。
- **POST 的 cwd**：从会话 JSONL 头部行内 `cwd` 字段读（同 02 决策，不从目录名反解），空则回退 homedir。
- **notifier 触发点**：审批卡创建 →「Claude 待审批」；run done/error →「Claude 已完成/运行出错」+ 原文摘要。未配 BARK/NTFY 时 no-op。
- **claude CLI 版本**：启动时异步 `claude --version` 探测（实测得 `2.1.209 (Claude Code)`），失败保持 `unknown`。
- **心跳**：服务端 30s ping、两轮无 pong terminate（Tailscale NAT 保活）。

## 集成期修改的其他卡文件（遗留对表）

1. **契约 `docs/api-contract.md`**：新增 `{"type":"resync","sessionId"}` 帧（03 报告的建议）；注明 approval 帧广播语义（05 疑问 4）。
2. **`web/app.js` 两处**（05 遗留，属集成期修复）：
   - 新增 `ws:resync` 处理：清空本地列表全量重拉；
   - **修复"连接中…"横幅永不消失**：ConnBar 的初始快照与 useBus 订阅生效之间有空窗，本机 ~6ms 的 WS 握手让 `open` 状态变更恰好漏掉（mock 环境时序不同未暴露）。订阅生效后补读一次 `ws.state` 快照。已重载验证。
3. **`packages/daemon/src/run/runner.ts`**（04 遗留，真机才暴露的阻塞 bug）：
   - **SDK 流式输入 + persistSession 下，`result` 之后 CLI 子进程保持存活等待下一条输入，`sdk.messages` iterator 永不耗尽** → run 永不 settle、endRun 不执行、会话永久卡 `daemon-driving`、SDK 子进程泄漏（真机实测：网页轮次回复后徽标一直"运行中"，`ps` 可见 `--input-format stream-json` 子进程滞留）。
   - 修复：`#consume` 以 `result` WorkerEvent 为一轮终点，`break` 后走既有 finally（`sdk.close()` 关输入流与 Query，子进程退出）。旧项目 worker 同样依赖流自然结束——它从未真机跑过 SDK，此坑被两代 fake 测试掩盖。修复后 72 测试全绿，真机复测 run 正常 done、状态回 idle。
4. **`packages/daemon/tsconfig.json`**：include 补 `scripts/**/*.ts`（02 报告建议），demo-list.ts 纳入 typecheck。
5. **`packages/daemon/package.json`**：新增依赖 `ws@^8.18.0` + devDep `@types/ws`（卡面"node:http + ws"）。

## 05 报告五条契约疑问的对表结论

| # | 疑问 | 结论 |
|---|---|---|
| 1 | 缺单会话元信息端点 | 阶段一维持现状（前端拉列表兜底可用），列阶段二候选 |
| 2 | 审批刷新即丢 | 维持现状（下一张或超时自愈）；阶段二可加 `GET /api/interactions?pending=1` 或订阅重放 |
| 3 | 分页组边界 | daemon 的 readTail/readBefore 本就按主链行开窗（02 决策 5），同 seq 块组天然不切页，与 mock 行为一致 |
| 4 | approval.resolved 无 sessionId | 采纳广播语义并写入契约 |
| 5 | 无 afterSeq | 维持已知限制，阶段二候选 |

## 真机验收记录（2026-07-18，Chrome 驱动真 daemon @ 127.0.0.1:8788）

**环境**：8787 被无关服务（hermes-webui）占用，daemon 用 8788；05 遗留的 mock server（同占 8788）已停。`.env` 含 BRIDGE_TOKEN/HOST/PORT。

- **M1 ✅**：`GET /api/sessions` 与 `~/.claude/projects` 实际文件对照：total 134，前 5 条的 id/顺序/大小逐一相同，首条即执行本卡的会话自身，title 均为首条真实指令。（交互式 `claude --resume` 选择器无法在会话内打开，用文件系统对照替代，方法同 02。）
- **M2 ✅**：网页打开本卡执行会话，页面加载之后发生的工具调用（click、`echo M2-LIVE-PROBE-*`）实时滚出，思考/工具卡渲染正确，贴底自动滚动；徽标"终端驾驶"、输入框置灰"终端驾驶中，暂不可发送"。控制台零报错。
- **M3 ✅（核心）**：草稿会话 `9d1457b7`（/tmp/claude-remote-m3）：网页发送 → pending 气泡被 WS 回显替换 → 助手回复实时滚出 → JSONL 同文件同 sessionId 追加 user+assistant 行 → 终端 `claude -p --resume 9d1457b7 "What was my previous message?"` **原文引用了网页发送的消息**。
- **M4 ✅**：`touch` 命令触发 Bash 审批卡（倒计时 4:25、input JSON、拒绝/允许一次）。允许 → 文件真实创建（`/tmp/claude-remote-m3/M4-created.txt`）、run 正常 done、状态回"可接管"；拒绝 → 工具结果标红出错、文件未创建、run 正常收尾。注：`echo` 类只读安全命令被 CLI 免审批直接放行（内建行为，非 bug）。超时 auto-deny 由 interactions/approval 单测覆盖；**Bark/ntfy 未配置未验**（M4 卡面"配了则验"）。
- **M5 部分**：终端驾驶置灰已在 M2 实证。**待验两项**：① 最后一次终端写入后 120s 静默自动回"可接管"（操作：终端对任一会话说一句话，网页观察徽标 终端驾驶→约 2 分钟后→可接管）；② 手机 Safari 经 Tailscale 全流程 + PWA 加主屏（需真机：`.env` 的 `BRIDGE_HOST` 改为 Tailscale IP 或 `0.0.0.0` 后重启 daemon，手机访问 `http://<mac-tailscale-ip>:8788`）。

## 遗留问题 / 阶段二候选

1. **M5 待验两项**（见上）——代码路径均有测试覆盖（cooldown 回落 9 个 activity 单测；WS/静态托管与浏览器实测），待真机确认。
2. 列表页的 status 徽标只对"被订阅过的会话"实时（tracker 只从 watcher 拿写入信号，watcher 只 watch 被订阅的会话）——设计使然，聊天页行为正确；若要列表页全量实时需 watch 全部会话，阶段二再议。
3. run 中断（abort）无 HTTP 端点（Runner 有能力，契约 v1 没定义端点），网页暂不能"停止生成"。
4. 04 报告遗留 1（无 waiter 的过期不发 resolved）维持原状，前端已按 run 终态清卡规避。
5. 05 的五条契约疑问中 #1/#2/#5 列为阶段二候选（见对表）。
6. `.env.example` 已核对与实现一致（变量名/默认值逐一对照 config.ts）。

## 复现验收环境

```bash
cd ~/Desktop/claude-remote
pnpm dev                       # 读 .env；缺 BRIDGE_TOKEN 拒启
open http://127.0.0.1:8788     # token 见 .env
```
