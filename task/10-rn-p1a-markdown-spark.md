# 10 · RN P1-A：MarkdownView + Spark（可并行，无依赖）

## 目标

RN 端 Markdown 渲染器（与 web 输出一致、流式增量友好）+ 品牌芒星组件。

## 文件所有权（只写这些）

- `app/src/components/Spark.js`
- `app/src/components/markdown/MarkdownView.js`（内部辅助文件也放 `markdown/` 目录下）

## 规格

**Spark**：移植 `web/ui/components/spark.js` 的 15 条 line SVG（坐标/线宽原样），用 react-native-svg 的 `Svg/Line`。Props `{ size = 16, color, style }`，color 缺省用 `useTheme().colors.accent`，viewBox 0 0 24 24，strokeLinecap round。

**MarkdownView**：Props `{ text }`。用 vendored marked 的 lexer 产 token 树（`import { marked } from '../../../../web/vendor/marked.esm.min.js'`，metro watchFolders 已覆盖），`marked.lexer(text, { gfm: true, breaks: true })`，然后 token→RN 组件递归渲染：

- block：paragraph / heading(1-6，字号递减，1-2 用衬线) / code(等宽 Menlo、卡片底色、横向 ScrollView、圆角 sm) / blockquote(左侧 accent 竖线) / list(有序/无序/嵌套缩进) / hr / space / table(简化为等宽文本网格即可) / html(转义后当纯文本)
- inline（paragraph.tokens 递归）：text / strong / em / del / codespan(等宽+bubble 底) / link / br
- link：Text onPress → `Linking.openURL`（react-native 的 Linking），href 以 `javascript:` 开头的替换为 '#' 不打开；颜色 accent 加下划线
- 整体 try/catch，lexer 失败退回纯 `<Text>` 展示
- 基准字号 15 / lineHeight 24，颜色用 `useTheme()`，暗色自动生效
- 纯函数式：同一 text 重渲染稳定（流式场景每帧全量重渲），列表 key 用索引即可

## 参考（只读）

`web/ui/components/markdown.js`（web 的薄封装）、`web/ui/components/spark.js`、`web/style.css` 的 `.md` 段落样式、`app/src/theme.js`。

## 约束

- 不新增任何依赖；不改所有权外文件；JS（非 TS）；文案/注释简体中文，风格对齐仓库现有代码。
- 不要运行 expo/metro/xcodebuild（主窗口统一集成验证）。

## 交付

文件清单 + 关键实现决策 + 未决问题。
