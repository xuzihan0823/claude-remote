# T1 状态层抽离

## 目标
将 `web/app.js`（1581 行单文件）的状态层代码剥离成 `web/core/` 下的纯 TS/JS 模块，同时建立 `web/ui/` 目录结构。**行为零变化**，所有现有功能完整保留。

## 范围
仅动 `web/app.js`（拆分）、`web/index.html`（script 指向改为 `./ui/app.js`）、`web/style.css`（不动内容，只是引用方和构建方式确认）。不动 `packages/`、不动 daemon、不动 iOS 壳。

## 目标文件结构
```
web/
  index.html                 ← script src 改为 ./ui/app.js
  core/                      ← 纯 JS，零 DOM，export，可迁 RN
    api.js                   ← api()、probeBase/probeBases、ApiError、normalizeBase、saveConn、connHost、wsEndpoint、connErrMsg、apiTimeoutMs、TOKEN_KEY、BASE_KEY、BASES_KEY、loadBases/saveBases
    ws.js                    ← ws IIFE（connect/reconnect/subscribe/unsubscribe/start/stop/state），依赖 bus.js
    bus.js                   ← bus 对象 + useBus + toast 函数
    store.js                 ← sessionCache、pendingSessionMessages、modelCache、cacheSessions、fetchSessions、fetchModels、modelValue/modelLabel/modelMainName/findModel/resolveDefaultName
    modes.js                 ← 权限模式定义（见 T4），此阶段仅创建占位文件导出 PERMISSION_MODES 常量数组和 MODE_KEY
  ui/
    app.js                   ← 路由 + App 壳（从 app.js 底部搬来），import 全部 core 和 component
    screens/
      home.js                ← StartScreen（含 NewChatComposer、ProjectPicker、ModelPicker）
      chat.js                ← Chat（含 MessageRow、Countdown、ApprovalCard、ApprovalLayer 等）
      settings.js            ← SettingsPage
      pair.js                ← PairPage
      setup.js               ← SetupGate + PairConfirm
    components/
      composer.js            ← 此阶段可为 home.js 的 NewChatComposer 拆出或暂留 home.js
      markdown.js            ← Markdown 组件
      toast.js               ← ToastLayer
      conn-bar.js            ← ConnBar
      sidebar.js             ← Sidebar
      spark.js               ← Spark SVG 组件
```

## 关键约束
- **无构建器**：原生 ES module import，浏览器直接运行，无 bundler/transpiler
- `index.html` 的 preact-htm 引入方式不变（从 `./vendor/preact-htm-standalone.module.js` 导入），所有文件顶部用相对路径 import preact
- `html`、`render`、`useState` 等 preact hooks 在每个需要它们的文件顶部 import
- `bus.js` 必须是单例（ES module 天然单例）；ws.js 同理
- 工具函数（escapeHtml、relTime、fmtClock、fmtBytes、cwdTail、truncate、toolSummary、msgKey、cmpMsg、STATUS_LABEL、STATUS_DOT）可放 `ui/utils.js`
- `web/style.css` 文件不拆，但 index.html 的 link 路径不变（style.css 在 web/ 根）
- 修改后运行 `node --check` 对每个 .js 文件校验语法（无 tsc 可用于纯 JS）

## 验收标准
1. `node --check web/ui/app.js web/ui/screens/*.js web/ui/components/*.js web/core/*.js` 全部无语法错误
2. Chrome 手机视口（430px）打开 http://127.0.0.1:8788 能正常渲染：首页问候、抽屉打开、会话进入聊天、设置页可用
3. 无 console.error（除非 daemon 未运行）
4. 文件行数分布合理（无超过 400 行的文件）

## 注意事项
- `Spark`、`Markdown`、`ToastLayer`、`ConnBar` 等被多处引用的组件必须各自独立导出
- `App` 组件底部的 `render(html\`<${App} />\`, ...)` 保留在 `ui/app.js`
- `parseSetupLink` 和 `PairConfirm` 可跟随 App 或放 setup.js
- `useVVH` hook 可放 `ui/hooks.js` 或内联 ui/app.js

## 并行规则
此任务是所有后续任务的地基，T1 完成且验收通过后才能开始 T2/T3/T4-前端。
