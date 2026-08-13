# 14 · RN P2-E：Composer 全量（发送/停止/附件/模型/模式）（可并行）

## 目标

Home 与 Chat 共用的 composer 浮岛：发送、停止、附件先传后发、模型 pill+sheet、模式 pill+sheet+bypass 确认、每会话模式记忆。

## 文件所有权（只写这些）

- `app/src/components/composer/` 整个目录：`ChatComposer.js`（覆盖现有桩，**契约见桩内注释，不得更改 props 签名**，可新增可选 prop `onStatusConflict(status)`）、`NewChatComposer.js`、共用内部组件（如 `ComposerCard.js`）、`ModelSheet.js`、`ModeSheet.js`、`ModePill.js` 等自行组织
- `app/src/lib/useModelCatalog.js`（移植 web/ui/hooks.js 的 useModelCatalog：fetchModels + bus 'ws-open'/'models-cached'）

## 规格（行为照抄 web，视觉对齐 ios-ui-redesign：浮岛 24px 圆角、pill、底部 sheet）

**ChatComposer**（对照 web/ui/screens/chat.js 的 composer 部分）：
- canSend = status==='idle' && !sendBusy；disabledReason 文案照抄（发送中…/终端驾驶中，暂不可发送/Claude 正在运行…/状态获取中…）
- isRunning 时顶部 runbar：「Claude 正在运行… [停止]」；停止 = POST `/api/sessions/:id/abort`（body 带 activeRunId），404/409/no_active_run/already_finished 视为已结束（onStopped()+toast '运行已结束'），成功 onStopped()+toast '已停止当前运行'，其它错误 toast
- 输入框：TextInput multiline，自动增高至 132 上限（onContentSizeChange），placeholder=canSend?'输入消息…':disabledReason
- 发送：附件先传（`/api/sessions/:id/upload?filename=`，逐个），路径块拼进文本（文案照抄 web：`[手机端上传的附件，已保存在本机，可直接读取]`），POST messages `{text, model?(override 时), permissionMode?(mode!=='default' 时)}`；成功 onSent(text)、清 draft/附件；409 → toast 占用原因 + 调 onStatusConflict(e.data.status)；413 → '附件过大（上限 25MB）'
- 底部工具行：+（附件）、ModelPicker pill、ModePill、「仅本轮/跟随 Mac 默认」note、发送 ↑ / 停止 ■ 圆钮（accent 底）

**NewChatComposer** `{ projects, onCreated }`（对照 web/ui/components/composer.js）：
- cwd = projects[0]（web 同款，无项目选择 UI）；draft 空或 busy 时禁发
- 附件走 `/api/upload`（新建会话专用端点）；POST `/api/sessions` `{cwd, text, model?, permissionMode?}`；成功 `setSessionMode(result.sessionId, mode)` + onCreated(result, body)；错误分支文案照抄（409/413/unknown_model/unknown_cwd）
- 模式初值 getNewSessionMode()，选择时 setNewSessionMode
- placeholder「今天想做什么？」

**附件选取**（两个 composer 共用）：+ 按钮弹 iOS ActionSheet（用 RN 自带 `ActionSheetIOS` 或自绘小 sheet）：拍照（expo-image-picker launchCameraAsync，try/catch 包住——权限串 P3 才进 Info.plist，失败 toast 提示暂不可用）/ 相册（launchImageLibraryAsync，allowsMultipleSelection）/ 文件（expo-document-picker getDocumentAsync multiple）。取到 `{uri, name, size}` 列表渲染 chips（名称截断 24 + fmtBytes + ✕ 删除）。上传体：`const blob = await (await fetch(uri)).blob()` 后走 core `api()`（body=blob，Content-Type application/octet-stream——api() 的 60s 上传超时/鉴权/错误语义全部复用）。**注意 Expo 57 picker API 若与你认知不符，以保守可用为准并在报告标注。**

**ModelSheet/ModelPicker**（对照 web/ui/components/model-picker.js）：pill 显示 `选中 modelMainName / 默认·defName`；点开 @gorhom/bottom-sheet 的 `BottomSheetModal`（App 根已挂 BottomSheetModalProvider）：首项「跟随 Mac 默认（当前 x）」+ models 列表（主行 modelMainName、副行 别名 alias、选中 ✓）。数据用 `useModelCatalog()`。

**ModeSheet/ModePill**（对照 web/ui/components/mode-sheet.js）：四模式（标准/自动编辑/规划/Bypass+副行说明照抄）；从非 bypass 切到 bypass 时 `Alert.alert('启用 Bypass 模式？', '<web 确认文案>', [取消, 启用(style destructive)])`；ModePill 非 default 高亮（accent 边）。

## 参考（只读）

web/ui/screens/chat.js、web/ui/components/{composer,model-picker,mode-sheet}.js、web/core/{api,modes,bus}.js、app/src/components/composer/ChatComposer.js（桩内契约）、app/src/lib/format.js（fmtBytes/truncate）、app/src/theme.js、app/src/App.js。

## 约束

- core 从 `../../../../web/core/*.js`（composer/ 目录深 4 级）import；不新增依赖；JS；文案照抄 web；不要运行 expo/metro/xcodebuild。
- 不改 HomeScreen/ChatScreen（主窗口负责接线）。

## 交付

文件清单 + 关键决策 + 未决问题。
