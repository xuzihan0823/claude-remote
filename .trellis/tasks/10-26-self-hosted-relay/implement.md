# 执行计划

需求见 `prd.md`，设计见 `design.md`。按里程碑推进，每个里程碑都能单独验收、单独提交、单独回退。M1 与 M2 互不依赖，可以并行；M3 依赖 M2；M4 依赖 M2、M3；M5 依赖 M1、M3。

## 前置

- [ ] 用户确认 `prd.md` 的两个待定问题（默认按 PRD 中的倾向执行）。
- [ ] 当前分支 `feat/cli-tui` 上有 `mobile-session-features` 任务的未提交改动。开工前先确认它们已提交或另开分支，relay 工作在独立分支（建议 `feat/self-hosted-relay`）上进行，不与之混在一起。

## M1 手机端连接健壮性（不依赖 relay）

文件：`web/core/api.js`、`web/core/devices.js`、`web/core/ws.js`、`app/src/App.js`、`packages/daemon/src/server.ts`（仅 ping/pong 与 connect-info）、`docs/api-contract.md`。

1. daemon：WS 应用层 `ping`→`pong`（在 `#onClientFrame` 的 `sessionId` 判断之前处理）；新增 `GET /api/connect-info`，此时 `relay` 字段固定 `{ "state": "disabled" }`。
2. `probeBases` 改为并行 + 直连优先 + 1.5 秒宽限期 + 401 短路，可注入 `fetch`/计时器。
3. `devices.js`：通道识别、`channelPref`、`manualBases`、`candidateBases` 按偏好过滤、`syncBases`。
4. `ws.js`：应用层心跳与半开判定（收到首个 pong 后才启用），连续失败/半开时发 `ws-reselect`。
5. `App.js`：`reselect()`；回前台与 `ws-reselect` 时调用；连上后拉 `connect-info` 并 `syncBases`。
6. 更新 `docs/api-contract.md`。

验证：

```bash
pnpm run test:web
```

```bash
pnpm --filter @claude-remote/daemon test
```

另在模拟器上：连着 daemon 时切换 Mac 的 Wi-Fi/Tailscale，观察回前台后自动换地址、WS 断开后自动重选。

回滚点：M1 提交前后 App 行为对旧 daemon 兼容（connect-info 404 忽略、无 pong 不启用半开判定）。

## M2 relay 服务本体

文件：新建 `packages/relay/**`（`package.json`、`src/protocol.ts`、`src/config.ts`、`src/server.ts`、`src/index.ts`、`__tests__/**`）；`pnpm-workspace.yaml` 若需调整。

1. `protocol.ts`：帧类型、编解码、流控窗口常量；导出给 daemon 使用（`exports["./protocol"]`）。
2. `config.ts`：环境变量解析，`RELAY_SECRET` 缺失或短于 32 字符拒绝启动。
3. `server.ts`：`/healthz`、`/agent` 接入与设备 ID 派生校验（无状态，不落盘）、`/d/<id>/*` HTTP 转发、`/d/<id>/ws` 转发、流控、并发/体积/超时上限、心跳、日志脱敏。
4. `index.ts`：启动与优雅退出。
5. 测试（真实 relay + 用 protocol 模块写的假 agent）：设计 §9 列出的 relay 用例全部覆盖。

验证：

```bash
pnpm --filter @claude-remote/relay test
```

```bash
pnpm --filter @claude-remote/relay typecheck
```

## M3 daemon connector 与 `cr relay`

依赖 M2。文件：`packages/daemon/src/relay/connector.ts`、`packages/daemon/src/config.ts`、`packages/daemon/src/index.ts`、`packages/daemon/src/server.ts`（connect-info 接入真实状态、pairInfo 追加 relay base）、`packages/daemon/package.json`（依赖 `@claude-remote/relay`）、`packages/cli/src/relay.ts`、`packages/cli/src/main.tsx`、`packages/cli/src/commands.ts`（`cr status` 通道一节）、TUI 设置页只读状态行、`docs/cli.md`、`.env.example`。

1. daemon 配置读取 `RELAY_*`，非法值 `ConfigError`。
2. connector：接入、重放 HTTP/WS、拦截配对路径、追加转发头、重连退避、鉴权失败长退避、状态暴露、随 daemon 停止。
3. `connect-info` 与配对二维码带上 relay base。
4. `cr relay add|status|on|off|remove`，`cr status` 通道展示，TUI 状态行。
5. 检查 `scripts/build-npm.mjs` 能把 `@claude-remote/relay` 的 protocol 打进 npm 包。
6. 测试：connector 接真实 relay 与真实 daemon server 的集成测试（设计 §9 daemon 部分）；cli 配置读写与 URL 校验。

验证：

```bash
pnpm -r --if-present test
```

```bash
pnpm typecheck
```

另在本机：起 relay（`RELAY_HOST=127.0.0.1`）→ `cr relay add http://127.0.0.1:8790 <secret>` → `curl` 经 relay 访问 `/d/<id>/api/health`（带 token 200、无 token 401）与 `/d/<id>/api/pair-info`（403）。

## M4 一行安装与真实服务器验证

依赖 M2、M3。文件：`deploy/relay/Dockerfile`、`docker-compose.yml`、`Caddyfile`、`install.sh`、`relay.service`、`README.md`、`.github/workflows/relay-image.yml`；根 `README.md` 增加"接入方式"一节（没有服务器用 Tailscale，有服务器一行命令装 relay）。

1. Dockerfile 多阶段构建、非 root 运行、无数据卷。
2. GitHub Actions：buildx 构建 amd64 + arm64，推送 GHCR（`relay-v*` 标签或手动触发），镜像设为公开。
3. compose + Caddyfile（自动证书 / `--cert --key` 挂载证书两种；Caddy 证书卷持久化）。
4. `install.sh`：参数与交互、按需装 Docker、固定安装目录、保留已有密钥（重复执行即升级）、sslip.io 兜底、等待 healthz、打印 `cr relay add` 命令。
5. `deploy/relay/README.md`（一行安装、先下载再执行的两步写法、升级、卸载、安全组、国内未备案服务器、密钥轮换、明文可见性）与 systemd 样例。
6. 实现时确认 sslip.io 域名申请 Let's Encrypt 证书的可行性与速率限制，写进 README。

验证：

```bash
shellcheck deploy/relay/install.sh
```

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f deploy/relay/Dockerfile .
```

GitHub Actions 首次运行成功、GHCR 上镜像可匿名拉取（**推送镜像和把包设为公开需用户确认**）。之后在一台真实服务器上执行一行安装命令从零部署，再重复执行一次验证升级（**需用户指定服务器并同意**；按全局约定先备份该服务器上相关目录），手机经 relay 跑通 PRD 第一、二条验收标准。

## M5 手机端通道界面

依赖 M1、M3。文件：`app/src/screens/settings/DeviceDetailScreen.js`、必要时 `app/src/lib/conn-context.js`、`web/core/api.js` 的 `connErrMsg`。

1. 设备详情显示当前通道与通道偏好三选一，改动后立即 `reselect()`。
2. 超时错误文案同时提示 Tailscale 与 relay。

验证：模拟器上切换偏好，确认探测只用对应通道；按 PRD 验收标准第二、四条在真机上走一遍。

## 收尾

1. 全量测试与类型检查：

```bash
pnpm test
```

```bash
pnpm typecheck
```

2. 派 `trellis-check` 做整体检查；relay 与 connector 涉及安全边界，另派 `security-reviewer` 审一次。
3. `trellis-update-spec`：把 relay 协议、connector 安全约束、多通道选择规则沉淀到 `.trellis/spec/backend/` 与 `.trellis/spec/frontend/`。
4. 更新 `PROGRESS.md`，按里程碑分别提交。
