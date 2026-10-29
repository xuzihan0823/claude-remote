# 自建 relay

relay 让手机在没有 Tailscale、也不和 Mac 在同一 Wi-Fi 时，经你自己的公网服务器连到 Mac。Mac 主动连出到 relay，不需要公网 IP，也不开放入站端口。手机会把直连地址和 relay 地址当成同一台设备的多个通道，能直连时优先直连，直连不通时自动走 relay。

没有服务器就用 Tailscale，不需要 relay。两者可以同时启用。

## 安全须知

relay 会在服务器上解开 HTTPS，会话内容（消息、代码、附件）对 relay 所在的服务器可见。请只部署在你自己信任的服务器上。

relay 不保存任何会话数据，也不知道 Mac 的 `BRIDGE_TOKEN`；手机带的 token 原样交给 Mac 上的 daemon 校验。配对接口（会返回 token 的 `/api/pair-info` 和配对二维码）经 relay 访问一律 403，只能在 Mac 本机打开。

## 一行安装

在一台 Linux 服务器（以 Debian / Ubuntu 为主要验证目标，amd64 或 arm64）上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash
```

有自己的域名（已解析到这台服务器）时：

```bash
curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash -s -- --domain relay.example.com
```

不想把网上的脚本直接交给 root 执行，可以先下载、看完再执行：

```bash
curl -fsSLO https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh
```

```bash
less install.sh
```

```bash
sudo bash install.sh --domain relay.example.com
```

脚本会按需安装 Docker，在 `/opt/claude-remote-relay/` 写入配置，拉取预构建镜像，启动 relay 与 Caddy（自动 HTTPS），生成接入密钥，最后打印一条命令，复制到 Mac 上执行即可：

```bash
cr relay add https://relay.example.com <密钥>
```

之后在 Mac 上执行 `cr pair` 重新扫码，或者直接打开手机 App——已配对的手机连上 Mac 后会自动拿到 relay 地址。

### 参数

| 参数 | 说明 |
|---|---|
| `--domain <域名>` | 不传时用服务器公网 IP 生成 `<ip>.sslip.io` |
| `--https-port <端口>` | 默认 443 |
| `--cert <fullchain> --key <私钥>` | 使用已有证书，不自动申请 |
| `--auto-cert` | 取消之前的 `--cert/--key`，改回自动申请 |
| `--version <标签>` | 镜像版本，默认 `latest` |
| `--image <镜像名>` | 默认 `ghcr.io/xuzihan0823/claude-remote-relay` |

参数省略时沿用上次安装的值。

### 端口与安全组

云厂商的安全组（或 `ufw` 等防火墙）需要放行 HTTPS 端口（默认 TCP 443）。HTTPS 端口不是 443 且自动申请证书时，还需要放行 TCP 80 用于证书验证。

## 升级

重复执行安装命令即可。脚本会保留密钥和证书，拉取新镜像后重启；已接入的 Mac 会自动重连，手机上不需要任何操作。

## 卸载

```bash
cd /opt/claude-remote-relay && sudo docker compose down -v
```

```bash
sudo rm -rf /opt/claude-remote-relay
```

然后在 Mac 上执行 `cr relay remove`。

## 关于 sslip.io

不传 `--domain` 时，脚本用 `1-2-3-4.sslip.io` 这样的域名，它总是解析到对应 IP，免去买域名和配 DNS。适合先试用：sslip.io 不在公共后缀列表里，所有 sslip.io 子域共用 Let's Encrypt 对同一主域的签发额度，偶尔会签发失败（Caddy 会自动改用 ZeroSSL 重试）。长期使用建议换成自己的域名：

```bash
curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash -s -- --domain relay.example.com
```

换域名后需要在 Mac 上用新地址重新执行一次 `cr relay add`。

## 国内未备案的服务器

国内云服务器上，未备案的域名访问 80/443 端口会被拦截，所以既不能用 443 端口，也不能用 80 端口完成证书验证。做法是：用自己的域名，通过 DNS 验证签发证书，再用一个高位端口提供 HTTPS。sslip.io 在这种情况下不可用。

以阿里云 DNS 为例，用 [acme.sh](https://github.com/acmesh-official/acme.sh) 签发证书：

```bash
curl https://get.acme.sh | sh -s email=you@example.com
```

```bash
export Ali_Key="…" Ali_Secret="…"
```

```bash
~/.acme.sh/acme.sh --issue --dns dns_ali -d relay.example.com
```

```bash
mkdir -p /etc/claude-remote-relay/certs
```

```bash
~/.acme.sh/acme.sh --install-cert -d relay.example.com --fullchain-file /etc/claude-remote-relay/certs/fullchain.pem --key-file /etc/claude-remote-relay/certs/privkey.pem --reloadcmd "cd /opt/claude-remote-relay && docker compose restart caddy"
```

然后用已有证书和高位端口安装（记得在安全组放行这个端口）：

```bash
sudo bash install.sh --domain relay.example.com --https-port 8443 --cert /etc/claude-remote-relay/certs/fullchain.pem --key /etc/claude-remote-relay/certs/privkey.pem
```

acme.sh 每 60 天自动续期，续期后通过 `--reloadcmd` 重启 Caddy 加载新证书。

国内服务器拉取 GHCR 镜像较慢时，可以用 `--image` 指定镜像加速地址；Docker 安装慢时，可以先按云厂商文档装好 Docker，再执行安装脚本。

## 轮换密钥

relay 密钥泄露的后果是别人可以在你的 relay 上注册新设备，但无法冒充或读取已接入 Mac 的流量（每台 Mac 有自己的设备私钥）。需要轮换时：

```bash
sudo sed -i '/^RELAY_SECRET=/d' /opt/claude-remote-relay/.env
```

再执行一次安装命令，会生成新密钥并打印新的 `cr relay add` 命令，在每台 Mac 上重新执行一次即可。设备私钥不变，手机里保存的 relay 地址不需要更新。

## 不用 Docker 部署

已有反向代理（nginx / Caddy）的服务器可以参考 [relay.service](relay.service) 用 systemd 直接运行 relay，反向代理把请求转发到 `127.0.0.1:8790`，并开启 WebSocket 支持、关闭响应缓冲。

## 镜像

镜像由 GitHub Actions（`.github/workflows/relay-image.yml`）在推送 `relay-v*` 标签或手动触发时构建，支持 amd64 与 arm64，发布到 `ghcr.io/xuzihan0823/claude-remote-relay`。fork 本仓库后可以在安装时用 `--image` 指向自己的镜像。
