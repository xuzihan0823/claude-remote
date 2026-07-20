# 扫码配对方案 + 两项体验修复（2026-07-20 晚定稿，2026-07-21 实施）

> 结论先看 §0；明天按 §4 顺序动手。本文取代口头讨论，是配对功能的唯一方案文档。

## 0. 今晚诊断结论（证据链）

### 0.1 「一直连接中」——已定位，环境已修复

用户截图实为 **SetupGate 连接配置页**（不是聊天页）：「连接中…」是提交按钮的 busy 态文案（`web/app.js` ConnForm，`busy ? '连接中…' : submitLabel`）。

- **根因 A（环境，今晚已修）**：Mac 端 Tailscale 处于 **stopped** 状态，手机打到 `100.64.0.10:8788` 的请求进入黑洞（无 RST、无 ICMP，fetch 长挂）。已执行 `Tailscale up` 恢复；实测 `mac`(100.64.0.10) 与 `iphone183`(100.64.0.20) 均在网，Mac ping 手机 88ms（走局域网直连 192.168.1.10），两个地址的 `/api/health` 均返回 200：
  - `http://100.64.0.10:8788` ✅（Tailscale）
  - `http://192.168.1.5:8788` ✅（局域网 en0）
- **根因 B（代码，明日修）**：`web/app.js` 的 `api()` fetch **没有超时**。黑洞地址会挂 60s+ 且无任何报错，按钮长期「连接中…」，「退出重进」自然无效。
- **排除项**：daemon 自身 WS 正常（loopback 握手实测 OPEN、subscribe 正常）；前端 ws 重连状态机审阅无 bug；token 鉴权路径正常。

### 0.2 「拉起键盘整页上顶」——已定位

截图证据：iOS 状态栏（22:51/电量）直接压在 token 输入框上、页面底部露出黑条 → 整页被向上平移且未复位。

- **根因**：项目**未安装 `@capacitor/keyboard`**（package.json 可证）。键盘行为完全是 WKWebView 默认逻辑：聚焦输入框时 WebKit 在滚动层内部 `setContentOffset` 把内容顶上去「露出输入框」；叠加本项目 `html,body{position:fixed}` + `--vvh` 布局收缩 + `scrollEnabled:false`（用户无法手动滚回），推移量无人复位 → 整页卡在上顶位置。
- 07-20 白天的橡皮筋修复（scrollEnabled:false + position:fixed）没有引入此 bug，但让它**无法自愈**（以前能手滑回来）。

## 1. 键盘修复方案（明日 P0）

1. `pnpm add -w -D @capacitor/keyboard`（Capacitor 8 官方插件，SPM 支持；先 `npx cap ls` 确认插件被识别）。
2. `capacitor.config.ts` 显式配置（不依赖默认值）：
   ```ts
   plugins: { Keyboard: { resize: 'native' } }
   ```
   机制：键盘弹出时**原生缩小 WKWebView frame**，输入框天然在可视区内，WebKit 不再有「scroll-to-reveal」推页动作；`--vvh` 机制继续成立（visualViewport 高度 = 缩小后的 webview 高度）。
3. `npx cap sync ios` + xcodebuild 重建（改 config/装插件后必须 sync+重建）。
4. **Plan B**（若 native 模式仍有推页或动画割裂）：`resize: 'none'`（键盘纯悬浮、webview 不动）+ 监听 `keyboardWillShow/Hide` 事件把 `keyboardHeight` 写入 CSS 变量 `--kb`，composer `translateY(-var(--kb))`、消息区加等量 padding-bottom。

**验收标准**（连接页 + 聊天页，模拟器 + 真机）：
- 键盘弹出：顶栏不动、状态栏不与内容重叠、composer 紧贴键盘上沿、消息区可滚且贴底逻辑正常；
- 键盘收起：布局完全复位，无残留偏移、无底部黑条；
- 橡皮筋（07-20 修复项）不回归。

## 2. 连接体验修复（明日 P0）

1. `api()` 加 AbortController 超时：`/api/health` 8s、普通请求 20s、上传 60s；超时抛 `network_timeout`。
2. SetupGate 错误文案区分：`连接超时（Mac 不可达）：检查 Mac 上 daemon 是否在跑、Tailscale 是否开启` vs `token 不正确`。
3. **多候选地址**：localStorage 增加 `bridge_bases`（JSON 数组，与扫码配对共用）。`tryConnect` 顺序探测各候选（每个带超时），首个成功者设为当前 `bridge_base`。手动配置仍是单地址，不受影响。

## 3. 扫码配对方案（核心，明日 P1 起步）

### 3.1 目标场景

Mac 上看到一个二维码 → iPhone 相机扫码 → 弹「在 Claude Remote 中打开」→ app 自动填好地址+token、自动连上。同时把「把 app 给别人用」的首次配置门槛降到扫一下。

### 3.2 QR 载荷 v1（自包含，扫码时不需要任何服务器可达）

```
claude-remote://setup?v=1&token=<BRIDGE_TOKEN>&bases=<url1>,<url2>[,<url3>]
```

- `bases` 顺序：Tailscale IP → 局域网 IP → `<hostname>.local`（mDNS，能拿到就带上）；URL 逐个 encodeURIComponent。
- app 收到后：逐个 `GET /api/health`（带 §2 超时）→ 首个成功者连接，并把**完整候选表**存入 `bridge_bases`（今后某条路挂了自动切换，正是今晚 Tailscale 停摆这种故障的自愈路径）。

### 3.3 手机端改动

1. `ios/App/App/Info.plist` 注册 URL scheme：`CFBundleURLTypes` → `claude-remote`。
2. `pnpm add -w -D @capacitor/app`，前端监听 `appUrlOpen` → 解析 setup URL → **弹确认卡**（展示目标地址；已有配置时提示将被覆盖——防恶意二维码静默换 token）→ 确认后走 §3.2 探测连接。
3. SetupGate 增加一行引导：「Mac 端打开配对页，用相机扫码即可」。
4. **明日第一个验证点（写大段代码前）**：注册 scheme + 重建装机后，先用系统相机扫一张含 `claude-remote://setup?...` 的二维码，确认 iOS 26 会弹打开横幅。若横幅不可靠 → 切换 B 案：二维码改装 `http://<lan-ip>:8788/pair` 落地页，页内大按钮跳 `claude-remote://` 深链（Safari 内点击深链是可靠路径），并保留手动复制方式兜底。

### 3.4 Mac 端·阶段 A（明日，零原生代码）

1. daemon 新增 `GET /api/pair-info` → `{ bases: string[], token }`：**仅允许 loopback**（校验 socket remoteAddress ∈ 127.0.0.1/::1），不走 Bearer；非本机请求一律 403。token 不会经网络外泄。
2. daemon 启动时枚举候选地址：Tailscale 接口 IP（100.64/10 段）+ en0 局域网 IP + `<hostname>.local`，注入 pair-info 与终端输出。
3. 终端打印 ASCII 二维码（`qrcode` 一个依赖，terminal 与 SVG 双输出）+ 文本候选地址；`GET /api/pair-qr.svg`（同样 loopback-only）输出 SVG。
4. web UI 新增 `#/pair` 页：`<img src="/api/pair-qr.svg">` 大图 + 候选地址列表 + token 显隐按钮 + 「仅限 Mac 本机打开」提示（pair-info 403 时显示该提示）。
5. Mac 使用方式：`pnpm dev` 后终端直接见码；或浏览器开 `http://127.0.0.1:8788/#/pair`。

### 3.5 Mac 端·阶段 B（后续）：SwiftUI 菜单栏 App「Claude Remote for Mac」

- `MenuBarExtra` 常驻菜单栏：管理 daemon 子进程（或 launchd 项）、状态灯、点开即弹二维码窗口（WKWebView 加载 `127.0.0.1:8788/#/pair`，或 CoreImage `CIQRCodeGenerator` 原生绘制）、「在浏览器打开完整界面」入口。
- 这就是用户要的「Mac 上装同样的 app」：聊天界面复用同一套 web UI，Mac 版差异 = 常驻守护 + 二维码配对入口。
- **被否选项**：Capacitor→Mac Catalyst（官方不支持 Catalyst，壳能力缺失风险高）；Electron（为二维码+守护引入百 MB 级运行时，过重）；Tauri（引入全新工具链，收益不成比例）。

### 3.6 安全考量

- 二维码即凭据：配对页/pair-info 仅 loopback 可读、二维码按需打开；提醒用户不要把配对页截图外传。
- token 轮换：改 `.env` 重启 daemon → 手机端 401 → 自动回到 SetupGate → 重新扫码即可。
- `appUrlOpen` 覆盖已有配置前必须用户确认（见 §3.3.2）。

## 4. 明日执行顺序

0. （建议）先做 git 首次 commit 存底——仓库目前**零提交**，全部文件 untracked，改动前无回滚点。
1. **P0** 键盘：装插件 → config → sync+重建 → 模拟器连接页/聊天页回归（§1 验收标准）。
2. **P0** 相机扫码横幅 5 分钟验证（§3.3.4，决定主案/B 案路线）。
3. **P0** `api()` 超时 + SetupGate 错误文案（§2）。
4. **P1** daemon：pair-info + 地址枚举 + 终端二维码 + `/api/pair-qr.svg`（§3.4.1–3）。
5. **P1** 前端：`#/pair` 页 + scheme 注册 + `appUrlOpen` + 多候选连接（§3.3、§3.4.4）。
6. 全链路验收：Mac 显码 → 手机相机扫码 → 自动连上 → 聊天、键盘、审批全正常；关掉 Mac Tailscale 再试局域网自动切换。

可拆任务卡（待用户同意再生成）：(a) iOS 壳+键盘+scheme；(b) daemon pair-info+QR；(c) 前端 pair 页+多候选/超时。(a)(b) 文件无重叠可并行，(c) 依赖 (b) 的契约先行。

## 5. 运维注意

- Mac Tailscale 必须保持运行：今晚已 `Tailscale up`；建议在 Tailscale 菜单栏设置里勾选登录自启，避免复发。
- daemon 常驻（launchd）归入阶段 B；当前仍 `pnpm dev` 手动起。
