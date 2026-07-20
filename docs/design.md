# claude-remote 方案设计（阶段一：Web 版）

## 目标与验收

手机浏览器上以类 Claude App 的聊天界面：**看到 Mac 上所有 Claude Code 会话 → 终端驾驶时实时旁观 → 空闲时接管续聊 → 工具审批在手机完成 → 回终端 `claude --resume` 完整可见**。桌面浏览器打开同一页面即是"电脑同步显示"。

核心验收（M3）：网页发一句话 → SDK 续聊跑完 → 终端 `claude --resume` 看到这句话和回复。

## 架构

```
手机 Safari（PWA 可加主屏）/ 桌面浏览器
   │  HTTP + WebSocket，Tailscale 网内，固定 Bearer token
   ▼
bridge-daemon（Node/TS 单进程，tsx 直跑，零构建）
   ├─ SessionIndexer   扫描 ~/.claude/projects/**/*.jsonl → 会话列表
   ├─ TranscriptReader 解析 JSONL → 渲染用消息流（尾部起读 + 向上懒加载）
   ├─ LiveWatcher      fs.watch + mtime 轮询兜底，增量 tail → WS 推送
   ├─ ActivityDetector 判定会话由谁驾驶（互斥核心）
   ├─ Runner           SDK query({resume, cwd, canUseTool}) 驱动手机轮次
   ├─ ApprovalBridge   复用 qq-claude-bridge 的 interactions 包 → WS 审批卡片
   ├─ Notifier         Bark/ntfy 推送"任务完成/待审批"
   └─ 静态托管 web/（原生 JS + vendored preact/htm/marked，免构建）
```

## 关键设计决策（均有实测背书）

1. **一个 JSONL 文件 = 一个对话**。实测（Claude Code 2.1.209）`--resume` 同 session_id 同文件追加，daemon 不自建对话存储，`~/.claude/projects` 是唯一真相。
2. **cwd 从 JSONL 行内 `cwd` 字段读**，不从编码目录名反解（路径含 `-` 时有歧义）。
3. **消息链按 parentUuid 回溯渲染**：取文件最后一条消息回溯出活跃主链；fork 分叉与隐藏中间节点因此天然正确。未知行 type 折叠显示原始 JSON，不崩——JSONL 无官方 schema 承诺，容错是硬要求。
4. **驾驶互斥**：`idle | terminal-driving | daemon-driving` 三态。daemon 在跑 → daemon-driving；非 daemon 时段文件被写 → terminal-driving，静默 120s 回 idle；仅 idle 时手机可发送。反向（daemon 跑时终端强行 resume）技术上防不住，写入使用纪律。
5. **审批链整体复用**：interactions（SQLite 状态机、TTL 超时 deny、重启 auto-deny、审计）+ agent-bridge（sdk-bridge / permission-adapter，fail-closed）原样迁移，"QQ 键盘"换成"WS 卡片 + 网页按钮"。
6. **安全模型**：监听 127.0.0.1 + Tailscale 接口；Tailscale 管加密/鉴权/NAT；应用层固定 Bearer token 防内网其他设备。无 HMAC 线协议、无 relay、无 nginx。
7. **新仓库**。qq-claude-bridge 无 git 且 QQ 遗产占六成；复用文件以**复制**方式进入本仓库，旧项目原样归档。

## 里程碑

| 里程碑 | 内容 | 验证方式 | 工作量 |
|---|---|---|---|
| M1 | 索引 + 历史渲染（只读） | 网页会话列表/历史与 `claude --resume` 选择器对照一致 | ~1 天 |
| M2 | 实时旁观 | 终端聊天，网页同步滚出消息 | 0.5 天 |
| M3 | 手机续聊（核心） | 网页发送 → 回显 → 终端 resume 可见 | ~1 天 |
| M4 | 审批 + 推送 | Bash 审批卡允许/拒绝生效、超时 deny、Bark 通知 | ~1 天 |
| M5 | 互斥 + 真机 | 终端驾驶时输入置灰；手机 Safari 经 Tailscale 全流程 | 0.5 天 |

阶段二（SwiftUI 原生 app）只在 Web 版用出真实体感后启动，届时 API 已踩稳，iOS 纯粹是换渲染层。

## 风险与对策

- JSONL 格式随 CLI 版本漂移 → 渲染容错 + 记录版本号，升级 CLI 后重跑 M1 对照。
- 大会话文件（数 MB）→ 尾部块读起步 + 向上翻页懒加载，不全量 parse。
- compact 压缩行、subagent sidechain → 阶段一折叠/隐藏，不追求完美还原。
- Mac 休眠 → 文档写明 `caffeinate` / 电源设置要求。
- 手机锁屏收不到审批 → Bark/ntfy 推送补位，点通知回浏览器批。
- 悬空 promise（qq-claude-bridge 审查教训）→ Runner 的 completion 必须有消费者，所有异步路径显式 settle。

## 暂缓项（明确不做，防蔓延）

新建对话（阶段 1.5）、多机支持、公网访问、历史搜索、语音输入、iOS app（阶段二）。
