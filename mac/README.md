# Claude Remote for Mac

macOS 14+ 的 SwiftUI 菜单栏辅助程序。它以子进程方式管理本仓库的 daemon，并复用 daemon 的配对页面。

## 构建与运行

```sh
cd mac
swift build
swift run
```

默认启动命令是：

```sh
pnpm --dir /Users/mac/Desktop/claude-remote --filter daemon dev
```

启动命令、HTTP 端口和手动选择的 `claude` 路径均通过 `UserDefaults` 持久化。首次启动会在 Keychain 的 service `claude-remote` 中创建并保存 32 字节随机 hex `BRIDGE_TOKEN`。

## 已知限制

- 当前为 Swift Package 可执行程序，尚未打包为 `.app`；`SMAppService.mainApp` 的开机自启注册需要完成 app bundle、签名和安装后才会成功。
- 默认命令面向开发环境，发布版仍需将 Node 运行时与 daemon 打包进 app。
- 未运行 GUI 验证；请在带有图形会话的 macOS 中执行 `swift run`。
