# 11 · RN P1-B：ConnectScreen + Settings + 配对确认卡（可并行，无依赖）

## 目标

连接/设置全链路视图：手填表单 + 多候选探测 + 深链配对确认 + 设置页。

## 文件所有权（只写这些）

- `app/src/screens/ConnectScreen.js`（覆盖现有桩）
- `app/src/screens/SettingsScreen.js`（覆盖现有桩）
- `app/src/components/ConnForm.js`（新建）
- `app/src/components/PairConfirm.js`（覆盖现有桩）

## 规格（行为照抄 web，视觉套 theme token）

**ConnForm** `{ initBase, initToken, busy, submitLabel, onSubmit }`：移植 `web/ui/screens/setup.js` 的 ConnForm。地址 TextInput（keyboardType url、autoCapitalize none、autoCorrect false、placeholder 与 hint 文案照抄）+ token TextInput（secureTextEntry）+ 提交按钮（accent 底白字、busy 或 token 空时禁用、busy 显示「连接中…」）。

**ConnectScreen** `{ busy, error, onSubmit }`：SetupGate 移植——居中卡片（card 底、radius.md、line 描边）：Spark logo（`import { Spark } from '../components/Spark.js'`，别的代理在写，直接 import 不要自建）+ 衬线标题 Claude Remote + 副题 + ConnForm(initBase=core 的 baseUrl, initToken='') + error 红字 + 两行帮助文案（照抄 web）。整屏包 react-native-keyboard-controller 的 `KeyboardAvoidingView`（behavior padding）防键盘遮挡；ScrollView 兜底小屏。

**SettingsScreen**（无 props，导航屏）：移植 `web/ui/screens/settings.js`。顶栏：‹ 返回（useNavigation().goBack）+ 衬线标题「设置」。三卡片区（ScrollView）：
1. 连接：ConnForm(initBase=baseUrl, initToken=token, submitLabel「保存并重新连接」)，onSubmit 用 `useConnActions().tryConnect`（`app/src/lib/conn-context.js`），成功后 `toast('已保存并重新连接','info')` + goBack。
2. 状态：mount 时 `api('/api/health')`（core）→ kv 列表：服务器=connHost()（等宽）、daemon=v{version}|未连接、Claude CLI。
3. 快速上手：四步说明文案照抄 web。
底部危险按钮「断开并清除本机凭据」→ `bus.emit('logout')`（App 处理，无需导航）。

**PairConfirm** `{ req, busy, onConfirm, onCancel, hasExisting }`：全屏 absolute 遮罩（rgba(30,26,22,0.5)）+ 居中卡片：标题「扫码配对」、副题「将连接以下 Mac 地址（按顺序探测）：」、req.bases 等宽列表、hasExisting 时红字覆盖警告、按钮 取消 / 确认连接（busy 时「连接中…」）。文案照抄 web `PairConfirm`。zIndex 需在最上层。

## 参考（只读）

`web/ui/screens/setup.js`、`web/ui/screens/settings.js`、`web/core/api.js`（api/baseUrl/token/connHost 导出）、`web/core/bus.js`（toast）、`app/src/theme.js`、`app/src/lib/conn-context.js`、`app/src/App.js`（看 props 怎么传进来）。

## 约束

- core 一律从 `../../../web/core/*.js` import，不复制逻辑；不新增依赖；不改所有权外文件；JS；文案简体中文照抄 web。
- 不要运行 expo/metro/xcodebuild。

## 交付

文件清单 + 关键实现决策 + 未决问题。
