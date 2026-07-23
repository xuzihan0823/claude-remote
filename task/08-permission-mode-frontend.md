# T4 权限模式·前端全链路

> 2026-07-22。后端已完成并测试通过（sdk-bridge 透传、daemon 白名单校验、runner started 事件广播 permissionMode）。本卡只做前端。

## 目标
四种权限模式（标准 default / 自动编辑 acceptEdits / 规划 plan / Bypass bypassPermissions）在手机端可选、可记忆、随请求发给 daemon；bypass 有二次确认与聊天页常驻徽标。

## 文件所有权（只许改这四个）
- `web/core/modes.js`
- `web/ui/components/mode-sheet.js`
- `web/ui/components/composer.js`
- `web/ui/screens/chat.js`

**不许动** `web/style.css`（样式由主窗口提供，见「CSS 契约」）、不动 home.js、不动 core/api.js、不动 packages/。

## 后端契约（已实现，勿改）
- `POST /api/sessions` body 可带 `permissionMode`（四值白名单，非法 400 invalid_permission_mode）。
- `POST /api/sessions/:id/messages` body 同上。
- WS `ws:run` 帧 `state:'started'` 时**可能**带 `permissionMode` 字段（仅当该轮显式指定时才有；缺席≠default，不要据缺席降级本地状态）。ws.js 已原样转发整帧。

## 实现要求

### 1. core/modes.js
保留 PERMISSION_MODES 与 MODE_KEY，新增：
```js
getSessionMode(sessionId)   // localStorage `${MODE_KEY}:${sessionId}`，校验在 PERMISSION_MODES 内，否则 'default'
setSessionMode(sessionId, mode)
getNewSessionMode()         // localStorage MODE_KEY（新会话记住上次选择），同样校验
setNewSessionMode(mode)
```
localStorage 读写用 try/catch 包住（Safari 隐私模式会抛），失败静默回退 'default'。

### 2. mode-sheet.js
- 删掉「UI 占位」注释。
- ModeSheet 内部处理 bypass 二次确认：点选 bypassPermissions 时不立即 onSelect，先渲染确认层；确认→ onSelect('bypassPermissions') + onClose()；取消→回到 sheet（或直接关闭均可，选实现简单的）。其余三个模式点选即 onSelect + onClose（现行为）。
- 确认层 DOM 结构（类名必须一致，样式主窗口已备）：
```html
<div class="confirm-overlay" onClick=取消></div>
<div class="confirm-card" role="alertdialog" aria-modal="true">
  <div class="confirm-title">启用 Bypass 模式？</div>
  <div class="confirm-text">Claude 将不再请求任何审批，直接执行所有操作（含文件修改与命令执行）。仅在完全信任当前任务时使用。</div>
  <div class="confirm-actions">
    <button type="button" class="btn">取消</button>
    <button type="button" class="btn confirm-danger">启用</button>
  </div>
</div>
```
- ModePill：mode !== 'default' 时加 class `active`（`class="mode-pill${mode !== 'default' ? ' active' : ''}"`）。

### 3. composer.js（NewChatComposer，新建会话）
- `useState(getNewSessionMode)` 初始化 mode。
- 选择模式后 `setNewSessionMode(mode)`。
- POST body：`...(mode !== 'default' ? { permissionMode: mode } : {})`。
- 创建成功后 `setSessionMode(result.sessionId, mode)`（在 onCreated 调用之前，同步执行）。

### 4. chat.js（聊天页）
- `const [mode, setMode] = useState(() => getSessionMode(sessionId))`（组件按 sessionId key 重挂，初始化器可靠）。
- composer-options 行（ModelPicker 旁）加 ModePill；点开 ModeSheet；选择后 setMode + setSessionMode(sessionId, m)。sheet 的 open 状态本地 useState。
- doSend body：`...(mode !== 'default' ? { permissionMode: mode } : {})`。
- ws:run started 带 permissionMode 且在白名单内时：setMode + setSessionMode 同步（别的端/别的轮改了模式要跟上）；字段缺席时不动本地状态。
- topbar `.topbar-sub` 内、StatusBadge 旁：`mode === 'bypassPermissions'` 时渲染 `<span class="badge bypass">Bypass</span>`（常驻徽标）。

## CSS 契约（主窗口负责实现，你只管用类名）
`.confirm-overlay` `.confirm-card` `.confirm-title` `.confirm-text` `.confirm-actions` `.btn.confirm-danger` `.badge.bypass` `.mode-pill.active`

## 验收
1. `node --check` 四个文件全过。
2. 逻辑自查清单写进报告：新建会话带模式、继续消息带模式、default 不带字段、bypass 确认、徽标条件、localStorage 校验回退、ws:run 同步。
3. 不做的：不碰 style.css，不重构 chat 内联 composer 为共享组件（本轮明确不做）。

## 报告
完成后写 `reports/08-permission-mode-frontend.md`：做了什么、偏离卡面之处、遗留问题。
