# 详细部署文档

本文档说明如何手动完成主机端（macOS / Linux）初始化、网络通道打通与 iPhone 客户端安装。如果你想让主机上的 AI Agent 帮你自动完成配置，可以直接复制 [README](../README.md#快速开始) 中的「Agent 自动化部署提示词」。

---

## 前置条件

- **主机（Mac 或 Linux 服务器）**：macOS / Linux（暂不支持原生 Windows）、**Node.js ≥ 22.13.0**（`interactions` 包依赖内置 `node:sqlite`）、已安装并登录 **Claude Code CLI**
- **iPhone**：从 [GitHub Releases](https://github.com/xuzihan0823/claude-remote/releases/latest) 获取 `.ipa` 安装包并使用自签工具安装（如需自行修改手机端代码，也可使用 Mac 上的 **Xcode** 从 `app/` 编译安装）
- **远程网络（跨 Wi-Fi 使用时二选一）**：
  - **无额外服务器**：主机与 iPhone 安装 **Tailscale** 并登录同一账号
  - **有公网 Linux 服务器**：部署一份自建 **Relay**（支持无域名 IP 证书）

---

## 第一步：主机端安装与初始化

```sh
npm install -g @anyyu/claude-remote
cr
```

首次运行 `cr` 没有检测到 `BRIDGE_TOKEN` 时会自动执行初始化：
- 生成随机 `BRIDGE_TOKEN` 并写入 `~/.claude-remote/config.env`
- 自动探测本机 `claude` 可执行文件路径（支持 PATH、login shell、Homebrew、nvm/fnm/volta/bun 等）
- 启动 daemon 并进入 `cr` 全屏控制台

> 默认模式下，daemon 随 `cr` 一起启停（打开 `cr` 启动，退出即停）。
> - **macOS** 如需后台常驻与开机自启，可执行 `cr config set autostart on`（通过 `launchd` 托管）。
> - **Linux 服务器**暂不支持 `autostart`（无 `launchd`），建议在 `tmux` / `screen` 中运行 `cr`，或使用 `cr up` 在前台托管 daemon。

---

## 第二步：打通连接方式（可同时启用）

手机会把直连地址和 Relay 地址视作同一台主机的多个通道，**能直连时优先直连，不通时自动走 Relay**。

### 方案 A：Tailscale Serve（无需额外服务器）

1. 在主机和 iPhone 上安装 Tailscale，并连接同一个 Tailscale 网络。
2. 保持主机上的 `cr` 运行（或 macOS 已开启 `autostart` 并运行 `cr up`），在另一个终端运行：

   ```sh
   cr pair --tailscale
   ```

3. 首次使用 Serve 时，按 Tailscale 提示在浏览器开启 HTTPS，再扫终端二维码。

daemon 可以保持默认的 `127.0.0.1`。命令会复用已经指向 daemon 的私有 HTTPS Serve 地址，或在 Tailscale 的 443、8443 端口中选一个空闲端口。已配对且在线的手机会自动收到新地址。

Tailscale 会自动处理直连和 DERP 中继，手机使用同一个 HTTPS 地址。也配置了自建 Relay 时，在 App 的「设置 → 设备 → 设备详情 → 通道偏好」选择「Relay」「Tailscale」或「自动」。切换当前设备的通道时，App 会先试连，再保存偏好。

> 只在同一个 Wi-Fi 下使用时，也可以用 `cr config set host 0.0.0.0` 开启局域网直连。默认随 `cr` 启停时，重开 `cr` 使设置生效，再运行 `cr pair`。

### 方案 B：自建公网 Relay（有 Linux 服务器时）

在公网 Linux 服务器（以 Debian / Ubuntu 为主要验证目标）上执行一行安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash
```

脚本会自动安装 Docker、拉取镜像、启动 Relay 与 Caddy（支持直接用公网 IP 申请 HTTPS 证书），并在最后打印一条接入命令，复制到你的主机执行即可：

```sh
cr relay add https://<RELAY_HOST> <密钥>
```

- 支持同时接入多台自有 Relay 容灾；配置热加载生效，无需重启正在进行的会话。
- 已配对手机完整连接一次（或热加载同步后）会自动获取新 Relay 地址，无需重新扫码。
- 端口放行（443 / 80）、自定义域名与国内未备案服务器指引详见 [deploy/relay/README.md](../deploy/relay/README.md)。

---

## 第三步：安装 iPhone 客户端

### 方式一：下载 `.ipa` 自签安装（推荐）

1. 前往 [GitHub Releases](https://github.com/xuzihan0823/claude-remote/releases/latest) 下载最新的 `.ipa` 文件。
2. 使用你常用的 iOS 自签 / 侧载工具（如 AltStore、SideStore、Sideloadly、TrollStore 或其他自签工具）对 `.ipa` 重签并安装到 iPhone。
3. 若使用个人 Apple ID 免费自签，请在 iPhone「设置 → 通用 → VPN 与设备管理」中信任对应开发者证书后再打开 App。

### 方式二：从源码编译安装（开发者）

<details>
<summary><strong>展开查看 Xcode 源码构建步骤</strong></summary>

<br />

`app/` 使用原生模块（如 `expo-camera`、`expo-dev-client`、`react-native-mmkv`、`react-native-webview`），不能直接用 Expo Go 运行，需在 Mac 上编译安装：

```sh
git clone https://github.com/xuzihan0823/claude-remote.git
cd claude-remote/app
npm install
npx expo run:ios --device
```

- 首次构建需在 Xcode 中选择你自己的 **Apple Developer Signing Team**，并按需修改不冲突的 **Bundle Identifier**。
- 首次安装真机前请保持 iPhone 解锁（锁屏可能触发 `kAMDMobileImageMounterDeviceLocked` 报错）。
- 若要打 Release 包，可直接使用 `app/ios/` 工程配合 `xcodebuild` 构建签名安装。

</details>

---

## 第四步：扫码配对

如果第二步执行 `cr pair --tailscale` 时已经完成扫码，可以直接开始使用。需要再次显示配对码时，在主机终端运行（或在 `cr` 全屏控制台里按 `p`）：

```sh
cr pair
```

使用 iPhone 相机扫码（或在 App 内「添加设备」扫码），即可完成配对并同步候选连接地址。

---

## 常用排查命令

- `cr status`：查看 daemon、launchd（macOS）、Tailscale / Relay 通道与当前会话数
- `cr logs`：实时查看 daemon 日志
- `cr setup`：重新探测 `claude` 路径并检查初始化状态

更多命令与架构说明见 [README](../README.md) 与 [架构说明](architecture.md)。

## 更新 iOS 第三方许可

iOS 构建会把仓库根目录的 `LICENSE` 和 [第三方许可声明](../app/THIRD-PARTY-NOTICES.txt) 复制进 App。更新依赖时，用 Release 模式的 Metro source map 核对实际打包的 npm 模块，再结合 CocoaPods 的 acknowledgements 和产物中的预编译框架更新声明。库没有随安装包附许可文本时，从对应版本的上游源码取原文。发布 `.ipa` 时随 Release 提供同一份第三方声明。
