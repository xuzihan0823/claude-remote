# 08 权限模式·前端全链路 实施报告

> 2026-07-22。原派 coder-glm（模型 API 不可访问，开工即死）→ 升级 coder-gpt（同样模型不可访问，死前仅完成 core/modes.js）→ 按路由规则主窗口接管实施。coder-gpt 留下的 modes.js 经复核完全符合卡面规范，原样保留。

## 完成内容

1. **core/modes.js**（coder-gpt 实现，主窗口复核保留）：`getSessionMode`/`setSessionMode`（键 `session_mode:<sessionId>`）、`getNewSessionMode`/`setNewSessionMode`（键 `session_mode`，新会话记住上次选择）；全部 try/catch 包裹 localStorage、白名单校验回退 'default'。
2. **mode-sheet.js**：ModePill 非 default 时加 `active` 类；ModeSheet 内置 bypass 二次确认（`.confirm-overlay/.confirm-card`，红色警示文案，取消回 sheet、启用才生效）；已处于 bypass 再点 bypass 不重复确认。
3. **composer.js**（NewChatComposer）：mode 初始化自 `getNewSessionMode`；选择后写回全局记忆；POST /api/sessions body 带 `permissionMode`（default 时省略字段）；创建成功后同步写 `setSessionMode(新sessionId, mode)` 再进聊天页。
4. **chat.js**：mode 初始化自 `getSessionMode(sessionId)`（组件按 sessionId key 重挂）；composer-options 行加 ModePill + ModeSheet；消息 POST 带 `permissionMode`（default 省略）；`ws:run` started 帧带合法 permissionMode 时同步本地状态与持久化（字段缺席不降级）；topbar `.badge.bypass` 常驻徽标。

## 自查清单（均已核）

- 新建会话带模式 ✓（body 构造 + create deps 含 mode）
- 继续消息带模式 ✓（doSend body + deps 含 mode）
- default 不发字段 ✓（与旧 daemon 兼容）
- bypass 确认 ✓（Chrome 430px 实测弹出，红色标题+警示文案+取消/启用）
- 徽标条件渲染 ✓（mode === 'bypassPermissions'）
- localStorage 异常回退 ✓（try/catch + 白名单）
- ws:run 同步 ✓（PERMISSION_MODES 白名单过滤）

## 偏离卡面

无。卡面明确不做的 composer 组件合并复用未做（记录在 PROGRESS.md）。

## 遗留

- 真机验收（Xcode 重建装机）由用户执行：四模式选择、bypass 确认与徽标、模式跨消息记忆。
