# 05 · Web UI（对 mock 开发）

## 背景

手机 Safari（经 Tailscale）与桌面浏览器共用的类 Claude App 聊天界面。纯静态、免构建、离线内网可用（依赖全部 vendored，不用 CDN）。API 以 `docs/api-contract.md` 为唯一依据，本卡自带 mock server 开发自测，不依赖 daemon 进度。

## 目标

`web/` 目录：对 mock server 完整可用的会话列表 + 聊天 + 审批界面，手机视口适配，PWA 可加主屏。

## 文件所有权

- `web/**`（index.html / app.js / style.css / manifest.webmanifest / vendor/ / mock/）

## 必读上下文

- `docs/api-contract.md`（全部端点、WS 消息、RenderMessage——本卡的全部后端知识）
- `docs/design.md`（目标与暂缓项，防做多）

## 任务明细

1. **技术底座**：原生 ES modules + vendored `preact` + `htm`（standalone ESM 单文件放 `web/vendor/`）+ `marked.min.js`（markdown 渲染）。无打包、无 npm build；vendor 文件来源与版本写进报告。
2. **会话列表页**：按 lastActiveAt 排序，显示 title / cwd 尾段 / 相对时间 / 状态徽标（🟢 idle 可接管、🟡 terminal-driving、🔵 daemon-driving）；下拉刷新或定时刷新 + WS status 事件实时更新。
3. **聊天页**：
   - 消息流：user/assistant 气泡；markdown 渲染（代码块等宽+横向滚动）；`tool_use`（工具名+input 摘要，点开折叠详情）、`tool_result`（默认折叠，isError 红标）、`thinking`（默认折叠）、`meta`（灰字一行）；
   - 首屏 `GET messages` 尾部 100 条，向上滚动翻页（beforeSeq）；
   - WS `message` 事件实时追加、按 seq+blockIndex 去重；`run` 事件显示运行中状态条；
   - 输入框：status 非 idle 时置灰并显示原因（"终端驾驶中"/"运行中"）；发送 → POST → 409 时提示并刷新状态。
4. **审批卡片**：WS `approval` 事件弹入页内卡片（非浏览器 alert）：toolName + input 预览（JSON 折叠）+ 允许一次/拒绝按钮；question 类型渲染选项按钮（multiSelect 支持多选提交）+ 自由文本输入；提交 POST decision；`approval.resolved` 后卡片落章消失；expiresAt 倒计时显示。
5. **连接层**：token 从 `localStorage`（首次访问弹输入框）；WS 断线指数退避重连 + 顶部状态条；重连后重新 subscribe 并拉 messages 补缺口（seq 去重）。
6. **移动端**：viewport / safe-area / 输入框不被键盘遮挡；`manifest.webmanifest`（名称、图标可用占位、standalone display）。
7. **mock/mock-server.mjs**：`node web/mock/mock-server.mjs` 起一个实现契约的假后端（静态托管 web/ + 假会话数据 + 定时推假消息 + 每 30s 推一个假审批 + decision/messages 端点假实现），是本卡的自测环境。

## 约束

- 只动 `web/`；不引框架构建链（禁 React/Vite/Tailwind 等）；vendor 三件套之外新增依赖需在报告说明理由。
- 阶段一暂缓项（design.md）不做：新建对话、搜索、多机。

## 验收标准

`node web/mock/mock-server.mjs` 后浏览器完成全部流程：列表 → 聊天渲染（含 tool/thinking 折叠、翻页）→ 发送与 409 提示 → 审批允许/拒绝/问题作答 → 断 WS 自动重连补缺口。桌面 Safari 响应式模式（iPhone 尺寸）核对布局，报告贴关键界面截图。

## 依赖与并行

依赖 01（仓库存在即可，不依赖任何包代码）。与 02、04 并行（并行组 A）。

## 结果报告

`reports/05-web.md`：界面截图、vendor 清单与版本、对契约的疑问/偏离（06 集成时对表）、已知 UI 债。
