# 现状核对（2026-10-26）

规划时对照代码与服务器确认的事实，供实现与检查子代理参考。

## 客户端连接

- `web/core/api.js`：`wsEndpoint()` 保留 base 的路径前缀，`api()` 直接拼 `${baseUrl}${path}`，所以 `https://relay/d/<id>` 这类 base 不需要改业务代码。`task/check-relay-connection.mjs` 已验证带前缀的 WS 地址拼接。
- `probeBases()` 是 for 循环串行探测，单个 `/api/health` 超时 8 秒，候选越多越慢。
- `web/core/devices.js`：每台 Mac 一条记录 `{ id, name, bases, token, lastBase, lastConnectedAt, ... }`；`candidateBases(d)` = `uniq([lastBase, ...bases])`；`upsertDevice` 以 token 或地址交集判定同一台。
- `app/src/App.js`：回前台只调 `ws.reconnectNow()`，不重新探测地址；`tryConnectBases` 成功后 `rememberDevice` 并异步取 `/api/health` 补主机名。
- `web/core/ws.js`：退避 1s→30s，失败后永远重连同一个 `wsEndpoint()`；没有应用层心跳。
- iOS `Info.plist` 已开 `NSAllowsArbitraryLoads`。
- 手动加地址的入口：`app/src/screens/settings/AddDeviceScreen.js`、`app/src/components/ConnForm.js`；设备详情：`app/src/screens/settings/DeviceDetailScreen.js`。

## daemon

- `packages/daemon/src/config.ts`：环境变量配置，非法值抛 `ConfigError` 拒绝启动；`BRIDGE_HOST` 默认 `127.0.0.1`。
- `packages/daemon/src/server.ts`：`/api/*` 先处理 CORS 与配对路由，再校验 Bearer；WS 只接受 `/ws?token=`；`#onClientFrame` 在缺 `sessionId` 时直接返回；服务端每隔 `WS_HEARTBEAT_MS` 发协议层 ping（RN 端不可见）。
- `packages/daemon/src/pair.ts`：配对端点要求 socket 来源为 loopback 且没有任何代理特征头（`looksProxied`）。经本机隧道回放的请求来源也是 loopback，必须带转发头或被直接拦截，否则 token 会泄露。
- 配对二维码 payload：`claude-remote://setup?v=1&token=…&bases=<逐个 URL 编码后逗号分隔>`。
- 10-21 已删除 `BRIDGE_PUBLIC_BASES`（PROGRESS.md），目前候选只有 Tailscale / en0 局域网 / mDNS。

## cli

- `packages/cli/src/config.ts`：`cr config` 管理的 `ConfigKey` 列表；配置文件为源码模式的仓库 `.env` 或 npm 模式的 `~/.claude-remote/config.env`，权限 0600。
- 子命令在 `packages/cli/src/main.tsx` 分发，实现在 `commands.ts`。

## 参考：已有的两台服务器（仅作部署验证候选，不是本项目依赖）

- 腾讯云上海 106.54.40.65：Ubuntu 24.04 x86_64，已有 frps（7000）与 mihomo，无 Web 服务器；80/443 空闲但域名需备案。
- 华为云 60.204.203.202（`ssh huawei`）：Ubuntu 24.04 x86_64，Caddy 在 `pi.anyyu.cloud:8443` 反代另一个项目 pi-remote 的专用 relay（协议不通用）；证书由 acme.sh 阿里云 DNS 验证签发——这正是"国内服务器 + 自有域名 + DNS 验证 + 高端口"场景的实例。
