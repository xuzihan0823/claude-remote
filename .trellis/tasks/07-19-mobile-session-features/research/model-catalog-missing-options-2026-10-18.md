# 手机端模型目录缺项排查（2026-10-18）

## 范围

用户要求先排查 claude-remote 读取本机模型配置、手机端模型列表不完整的原因。本轮不修改业务代码，不启动模型推理请求，不重启服务。

## 已确认的根因

`packages/daemon/src/model-config.ts:18-23,60-79` 仅把四个固定别名 `fable`、`opus`、`sonnet`、`haiku` 映射到 `settings.env.ANTHROPIC_DEFAULT_*_MODEL`，再按需补充 `settings.model`，完全没有读取 `settings.modelPicker.options`。

本机 `~/.claude/settings.json` 的 `modelPicker.options` 当前含 25 个不同的模型 ID，每项使用 `model`、`label`、`description` 字段。该列表包含路由组以及多个服务来源的模型。所有 25 个 ID 都能通过现有 `MODEL_ID_PATTERN`，所以缺项不是模型 ID 格式校验造成的。

运行中的 daemon 在本机端口 8788。使用项目已有凭据请求 `GET /api/models`，收到 HTTP 200，内容为：

| alias | id |
| --- | --- |
| fable | fable |
| opus | codex/gpt-6.1-sol |
| sonnet | codex/gpt-6.1-sol |
| haiku | codex/gpt-6.1-sol |

`defaultModel` 为 `codex/gpt-6.1-sol`。本机未配置 `ANTHROPIC_DEFAULT_FABLE_MODEL`，因此第一项退回字面别名 `fable`；其余三个别名在设置文件里确实都映射到同一个 ID。接口返回的四行只覆盖 `modelPicker.options` 中的一个模型，遗漏另外 24 个。

直接执行项目现有 `readModelCatalog()` 和 `isKnownModel()` 再次验证：目录长度为 4，25 个配置模型中的 24 个被视为 unknown。未发送任何创建会话或消息 POST。

## 下游链路核对

独立只读调查确认：

- `packages/daemon/src/server.ts:234-237,313-315` 的模型路由调用读取器后直接返回目录，无分页或条目截断。
- `web/core/api.js:119-126` 请求并缓存接口目录；Web 的 `web/ui/hooks.js:43-51` 和 RN 的 `app/src/lib/useModelCatalog.js:8-16` 在挂载及 WebSocket 重连时刷新。
- Web 的 `web/ui/components/model-picker.js:33-51`、RN 的 `app/src/components/composer/ModelSheet.js:21-45` 直接遍历目录；滚动容器限制可见高度，但没有丢弃模型项。
- 目录缓存位于 JS 模块变量，不是持久化存储；网络失败时保留空列表或旧列表。没有客户端硬编码四模型回退列表。
- 当前选择器优先展示 `id`，没有使用目录的 `displayName`；长 ID 单行省略，这是名称可读性问题，与此次数量缺项不同。

## 次要观察与边界

读取器忽略进程环境中的别名映射、项目级设置及桌面应用的其他配置来源；当前会话继承的模型映射也与磁盘设置不同。这是配置一致性的后续核对点，不作为本次缺项的根因。

当前调查证明的是本机配置项没有进入目录接口，不证明各个提供方模型当前可正常推理；本轮没有发起付费模型调用。

## 建议修复方向

在 daemon 目录读取器中支持 `modelPicker.options`，将 `model` 投影为 ID、`label` 投影为显示名称，保留既有 ID 校验及只投影安全字段的约束。处理重复模型和别名兼容，并在缺少选择器配置时保留现有别名回退。随后验证目录、POST 模型校验和手机端展示使用同一份结果。显示名称与长列表滚动需要在后续修复时一并核对。

## 验证方式

- 对本机设置仅提取模型相关字段，未输出认证信息。
- 对运行中 daemon 发起一次经过认证的 GET，逐项比较配置模型和接口模型。
- 调用现有读取器及模型识别函数，验证遗漏计数与白名单行为。
- 检查原生/Web 的目录获取、刷新、缓存及列表渲染代码。
- 初次排查未修改业务代码，因此当时未执行编译、测试套件或手机安装。

## 用户授权修复后的结果

用户随后明确要求修复。后端读取器现已优先读取有效 picker options，按完整 ID 去重并保留标签/顺序；空或无有效 picker 保留旧目录行为。有效 picker 分支解析默认别名映射，内置别名仍可作为旧客户端输入。GET 和 POST 继续共用读取/校验，无需修改客户端。

验证结果：daemon 测试 97/97 通过，工作区 `pnpm typecheck` 通过。HTTP 集成使用临时设置和 fake SDK，确认新会话/续聊都能传递列表末项模型、未知模型仍被拒绝、省略 model 继续跟随 Mac 默认；没有真实模型推理调用。

对真实本机配置读取器检查为 25/25、零遗漏和重复，输出仅包含安全字段。确认 58 个现有会话均无 daemon-driving run 后，以 SIGTERM 优雅停止旧进程并使用本机预览服务管理器启动修复版本。启动时使用基础系统环境，避免继承当前桌面会话注入的模型映射；项目 `.env` 和 Mac 模型设置均未修改。

重启后的实时 `GET /api/models` 返回 25 项，与本机 picker 的 ID、label 和顺序完全一致；默认仍为 `codex/gpt-6.1-sol`。未鉴权请求返回 401，health 正常。手机/Web 共用的 `web/core/api.js` 实测读取 25 项，每一项都能被 `modelValue` / `findModel` 正确识别，默认名解析正确。未重建或安装手机 App，未做真机视觉验收。
