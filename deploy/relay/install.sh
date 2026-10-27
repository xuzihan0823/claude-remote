#!/usr/bin/env bash
# claude-remote relay 一行安装 / 升级脚本（重复执行即升级，密钥与证书保持不变）。
#
#   curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash
#   curl -fsSL …/install.sh | sudo bash -s -- --domain relay.example.com
#
# 参数（全部可省略；省略时沿用上次安装的值，首次安装用默认值）：
#   --domain <域名>          默认用服务器公网 IP 生成 <ip>.sslip.io
#   --https-port <端口>      默认 443
#   --cert <fullchain> --key <私钥>   使用已有证书（如 acme.sh DNS 验证签发），不自动申请
#   --auto-cert              取消之前设置的 --cert/--key，改回自动申请证书
#   --version <标签>         镜像版本，默认 latest
#   --image <镜像名>         默认 ghcr.io/xuzihan0823/claude-remote-relay（拉不动时可换成镜像站地址）

set -euo pipefail

INSTALL_DIR=/opt/claude-remote-relay
ENV_FILE=$INSTALL_DIR/.env
OVERRIDE_FILE=$INSTALL_DIR/docker-compose.override.yml
RAW_BASE=${RELAY_RAW_BASE:-https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay}
DEFAULT_IMAGE=ghcr.io/xuzihan0823/claude-remote-relay
HEALTH_TIMEOUT_S=180

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m警告：\033[0m%s\n' "$*" >&2; }
die() {
  printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2
  exit 1
}

arg_domain="" arg_port="" arg_cert="" arg_key="" arg_version="" arg_image="" auto_cert=0

need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "参数 $1 需要一个值"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) need_value "$@"; arg_domain=$2; shift 2 ;;
    --https-port) need_value "$@"; arg_port=$2; shift 2 ;;
    --cert) need_value "$@"; arg_cert=$2; shift 2 ;;
    --key) need_value "$@"; arg_key=$2; shift 2 ;;
    --auto-cert) auto_cert=1; shift ;;
    --version) need_value "$@"; arg_version=$2; shift 2 ;;
    --image) need_value "$@"; arg_image=$2; shift 2 ;;
    -h | --help)
      sed -n '2,15p' "$0" 2>/dev/null || true
      exit 0
      ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# ---------- 环境检查 ----------

[ "$(id -u)" -eq 0 ] || die "需要 root 权限，请用 sudo bash 执行"

case "$(uname -m)" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "不支持的 CPU 架构：$(uname -m)（镜像只提供 amd64 与 arm64）" ;;
esac

if [ -r /etc/os-release ]; then
  os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
  case "$os_id" in
    ubuntu | debian) ;;
    *) warn "本脚本主要在 Debian/Ubuntu 上验证，当前系统 ${os_id:-未知}，将尽力继续" ;;
  esac
fi

command -v curl >/dev/null || die "需要 curl"

# ---------- 合并参数与已有配置 ----------

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

is_upgrade=0
[ -f "$ENV_FILE" ] && is_upgrade=1

secret=$(env_get RELAY_SECRET)
domain=${arg_domain:-$(env_get RELAY_DOMAIN)}
https_port=${arg_port:-$(env_get RELAY_HTTPS_PORT)}
https_port=${https_port:-443}
version=${arg_version:-$(env_get RELAY_VERSION)}
version=${version:-latest}
image=${arg_image:-$(env_get RELAY_IMAGE)}
image=${image:-$DEFAULT_IMAGE}
cert_file=$(env_get RELAY_CERT_FILE)
key_file=$(env_get RELAY_KEY_FILE)

if [ "$auto_cert" -eq 1 ]; then
  [ -z "$arg_cert$arg_key" ] || die "--auto-cert 不能和 --cert/--key 同时使用"
  cert_file="" key_file=""
elif [ -n "$arg_cert$arg_key" ]; then
  [ -n "$arg_cert" ] && [ -n "$arg_key" ] || die "--cert 和 --key 必须同时提供"
  cert_file=$(realpath "$arg_cert" 2>/dev/null) || die "证书文件不存在：$arg_cert"
  key_file=$(realpath "$arg_key" 2>/dev/null) || die "私钥文件不存在：$arg_key"
fi

if [ -n "$cert_file" ]; then
  for f in "$cert_file" "$key_file"; do
    [ -f "$f" ] || die "证书文件不存在：$f"
    case "$f" in
      *[[:space:]\"\']*) die "证书路径不能包含空格或引号：$f" ;;
    esac
  done
fi

case "$https_port" in
  '' | *[!0-9]*) die "--https-port 必须是 1-65535 的整数：$https_port" ;;
esac
[ "$https_port" -ge 1 ] && [ "$https_port" -le 65535 ] || die "--https-port 超出范围：$https_port"

detect_public_ip() {
  local url ip
  for url in https://api.ipify.org https://4.ipw.cn https://ifconfig.me/ip; do
    ip=$(curl -fsS4 --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || continue
    if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 1
}

if [ -z "$domain" ] && [ -t 0 ]; then
  read -r -p "relay 域名（留空则用服务器公网 IP 生成 sslip.io 域名）：" domain
fi
if [ -z "$domain" ]; then
  [ -z "$cert_file" ] || die "使用 --cert/--key 时必须同时指定 --domain"
  ip=$(detect_public_ip) || die "探测公网 IP 失败，请用 --domain 指定域名"
  domain="${ip//./-}.sslip.io"
  log "未指定域名，使用 $domain"
fi
[[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "域名格式不正确：$domain"

if [ -z "$secret" ]; then
  secret=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
  [ ${#secret} -eq 64 ] || die "生成密钥失败"
fi

# ---------- Docker ----------

if ! command -v docker >/dev/null; then
  log "未检测到 Docker，使用 Docker 官方脚本安装（国内服务器较慢时可先自行安装 Docker 再重新执行本脚本）"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker compose version >/dev/null 2>&1; then
  log "安装 docker compose 插件"
  if command -v apt-get >/dev/null; then
    apt-get update -qq && apt-get install -y -qq docker-compose-plugin
  elif command -v dnf >/dev/null; then
    dnf install -y -q docker-compose-plugin
  fi
  docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件，请手动安装后重试"
fi

# ---------- 端口预检（升级时端口由本服务自己占用，跳过） ----------

port_in_use() {
  command -v ss >/dev/null || return 1
  [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]
}

need_http01=0
[ -z "$cert_file" ] && [ "$https_port" != 443 ] && need_http01=1

running=""
if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
  running=$(cd "$INSTALL_DIR" && docker compose ps -q caddy 2>/dev/null || true)
fi
if [ -z "$running" ]; then
  port_in_use "$https_port" && die "端口 $https_port 已被占用，请用 --https-port 换一个端口"
  if [ "$need_http01" -eq 1 ] && port_in_use 80; then
    die "非 443 端口自动申请证书需要占用 80 端口，但 80 已被占用；可改用 --https-port 443，或用 --cert/--key 提供已有证书"
  fi
fi

# ---------- 写入安装目录 ----------

mkdir -p "$INSTALL_DIR"
umask 077

script_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi

fetch_file() {
  local name=$1 tmp
  tmp=$(mktemp "$INSTALL_DIR/.$name.XXXXXX")
  if [ -n "$script_dir" ] && [ -f "$script_dir/$name" ]; then
    cp "$script_dir/$name" "$tmp"
  else
    curl -fsSL "$RAW_BASE/$name" -o "$tmp" || {
      rm -f "$tmp"
      die "下载 $RAW_BASE/$name 失败"
    }
  fi
  chmod 644 "$tmp"
  mv "$tmp" "$INSTALL_DIR/$name"
}

log "写入配置到 $INSTALL_DIR"
fetch_file docker-compose.yml
fetch_file Caddyfile

tmp_env=$(mktemp "$INSTALL_DIR/.env.XXXXXX")
cat >"$tmp_env" <<EOF
# 由 install.sh 生成；重复执行 install.sh 会保留 RELAY_SECRET。
RELAY_IMAGE=$image
RELAY_VERSION=$version
RELAY_SECRET=$secret
RELAY_DOMAIN=$domain
RELAY_HTTPS_PORT=$https_port
RELAY_CERT_FILE=$cert_file
RELAY_KEY_FILE=$key_file
EOF
chmod 600 "$tmp_env"
mv "$tmp_env" "$ENV_FILE"

if [ -n "$cert_file" ]; then
  cat >"$OVERRIDE_FILE" <<EOF
# 由 install.sh 生成：使用已有证书。
services:
  caddy:
    environment:
      RELAY_TLS: "tls /certs/fullchain.pem /certs/privkey.pem"
    volumes:
      - "$cert_file:/certs/fullchain.pem:ro"
      - "$key_file:/certs/privkey.pem:ro"
EOF
elif [ "$need_http01" -eq 1 ]; then
  cat >"$OVERRIDE_FILE" <<EOF
# 由 install.sh 生成：HTTPS 不在 443 时，自动申请证书需要公网能访问 80 端口（HTTP-01 验证）。
services:
  caddy:
    ports:
      - "80:80"
EOF
else
  rm -f "$OVERRIDE_FILE"
fi
[ ! -f "$OVERRIDE_FILE" ] || chmod 644 "$OVERRIDE_FILE"

# ---------- 启动 ----------

cd "$INSTALL_DIR"
log "拉取镜像 $image:$version"
docker compose pull
log "启动服务"
docker compose up -d --remove-orphans

if [ "$https_port" = 443 ]; then
  public_url="https://$domain"
else
  public_url="https://$domain:$https_port"
fi

if [ -z "$cert_file" ] && [ "$is_upgrade" -eq 0 ]; then
  log "等待 relay 就绪（首次安装需要签发证书，最多 ${HEALTH_TIMEOUT_S} 秒）"
else
  log "等待 relay 就绪"
fi
healthy=0
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while [ $SECONDS -lt $deadline ]; do
  if curl -fsS --max-time 5 --resolve "$domain:$https_port:127.0.0.1" "https://$domain:$https_port/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
done

echo
if [ "$healthy" -eq 1 ]; then
  if [ "$is_upgrade" -eq 1 ]; then
    log "升级完成，已接入的 Mac 会自动重连，无需任何操作。"
  else
    log "安装完成。"
  fi
else
  warn "relay 在 ${HEALTH_TIMEOUT_S} 秒内没有就绪。常见原因：云厂商安全组没放行端口、域名没解析到本机、证书签发失败。"
  warn "查看日志：cd $INSTALL_DIR && docker compose logs --tail 50 caddy relay"
fi

echo
echo "请确认云厂商安全组 / 防火墙已放行 TCP $https_port$([ "$need_http01" -eq 1 ] && echo " 和 80")。"
echo
echo "在 Mac 上执行下面这条命令接入 relay（密钥只显示在这里，也保存在 $ENV_FILE）："
echo
echo "    cr relay add $public_url $secret"
echo

[ "$healthy" -eq 1 ] || exit 1
