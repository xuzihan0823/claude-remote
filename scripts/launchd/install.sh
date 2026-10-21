#!/bin/bash
# 把 daemon（以及可选的 cloudflared named tunnel）装成 launchd LaunchAgent。
#
# 解决的问题：nohup 起的 daemon / cloudflared 会随终端会话或 agent 会话一起消失
# （PROGRESS.md 2026-07-31「坑 3」：先 1033 无活跃隧道，再 502 源站不可达）。
# LaunchAgent 由 launchd 托管：登录即起、崩溃自动拉起、与任何终端会话无关。
#
# 用法：
#   scripts/launchd/install.sh install [--tunnel]   安装并启动（--tunnel 同时托管 cloudflared）
#   scripts/launchd/install.sh uninstall            停止并移除
#   scripts/launchd/install.sh restart              重启 daemon（及已安装的 tunnel）
#   scripts/launchd/install.sh status               查看状态
#   scripts/launchd/install.sh logs                 tail 日志
#
# 环境变量：
#   CLAUDE_REMOTE_TUNNEL   cloudflared 隧道名（默认 claude-remote）
#   CLOUDFLARED_BIN        cloudflared 路径（默认自动探测）
#
# 注意 macOS 只自带 bash 3.2，本脚本不使用 bash 4 语法。

set -euo pipefail

DAEMON_LABEL="com.claude-remote.daemon"
TUNNEL_LABEL="com.claude-remote.tunnel"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/claude-remote"
DOMAIN="gui/$(id -u)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER="$SCRIPT_DIR/run-daemon.sh"

daemon_plist="$AGENTS_DIR/$DAEMON_LABEL.plist"
tunnel_plist="$AGENTS_DIR/$TUNNEL_LABEL.plist"

log() { printf '[launchd] %s\n' "$*"; }
die() { printf '[launchd] 错误：%s\n' "$*" >&2; exit 1; }

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

daemon_port() {
  local port=""
  if [ -f "$REPO_DIR/.env" ]; then
    port="$(grep -E '^[[:space:]]*BRIDGE_PORT=' "$REPO_DIR/.env" | tail -n1 | cut -d= -f2 | tr -d '[:space:]"' || true)"
  fi
  printf '%s' "${port:-8787}"
}

is_loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

bootout() {
  if is_loaded "$1"; then
    launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
    # bootout 是异步的，等它真正卸载，避免紧接着 bootstrap 报 "service already loaded"
    local i=0
    while is_loaded "$1" && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  fi
}

bootstrap() {
  bootout "$1"
  launchctl bootstrap "$DOMAIN" "$2"
  launchctl enable "$DOMAIN/$1" 2>/dev/null || true
}

# 端口已被非 launchd 实例（nohup / 终端 pnpm dev）占用时先停掉，否则新实例会 EADDRINUSE 反复重启。
stop_stray_listener() {
  local port="$1" pids
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  log "端口 $port 已被进程 $(echo $pids | tr '\n' ' ')占用（多半是 nohup 起的旧 daemon），发送 SIGTERM"
  kill $pids 2>/dev/null || true
  local i=0
  while [ -n "$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)" ] && [ $i -lt 50 ]; do
    sleep 0.2; i=$((i + 1))
  done
  [ -z "$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)" ] || die "端口 $port 仍被占用，请手动处理"
}

stop_stray_tunnel() {
  local name="$1" pids
  pids="$(pgrep -f "cloudflared.*tunnel.*run.*$name" 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  log "发现非 launchd 托管的 cloudflared（$(echo $pids | tr '\n' ' ')），发送 SIGTERM"
  kill $pids 2>/dev/null || true
  sleep 1
}

write_daemon_plist() {
  local runner repo logdir
  runner="$(xml_escape "$RUNNER")"
  repo="$(xml_escape "$REPO_DIR")"
  logdir="$(xml_escape "$LOG_DIR")"
  cat >"$daemon_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$DAEMON_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- 以 login shell 运行，加载 ~/.zprofile 里的 Homebrew 等 PATH -->
    <string>/bin/zsh</string>
    <string>-l</string>
    <string>$runner</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repo</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_REMOTE_REPO</key>
    <string>$repo</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- 任何原因退出都重启（含 exit 0）；用户主动停止请走 install.sh uninstall 或菜单栏 App -->
  <key>KeepAlive</key>
  <true/>
  <!-- 崩溃循环时最少间隔 10 秒再拉起，避免刷爆日志 -->
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- daemon 收到 SIGTERM 后会关 WS、等活跃 run settle；给足时间再 SIGKILL -->
  <key>ExitTimeOut</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$logdir/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>$logdir/daemon.log</string>
</dict>
</plist>
EOF
  plutil -lint "$daemon_plist" >/dev/null
}

write_tunnel_plist() {
  local bin="$1" name="$2" logdir
  logdir="$(xml_escape "$LOG_DIR")"
  cat >"$tunnel_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$bin")</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>run</string>
    <string>$(xml_escape "$name")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$logdir/tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>$logdir/tunnel.log</string>
</dict>
</plist>
EOF
  plutil -lint "$tunnel_plist" >/dev/null
}

find_cloudflared() {
  if [ -n "${CLOUDFLARED_BIN:-}" ]; then printf '%s' "$CLOUDFLARED_BIN"; return; fi
  for c in /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared; do
    [ -x "$c" ] && { printf '%s' "$c"; return; }
  done
  command -v cloudflared 2>/dev/null || true
}

wait_healthy() {
  local port="$1" i=0 code
  while [ $i -lt 40 ]; do
    # 不带 token：401 也说明 daemon 已在监听
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health" 2>/dev/null || true)"
    case "$code" in 200|401) log "daemon 已在 127.0.0.1:$port 响应（HTTP $code）"; return 0 ;; esac
    sleep 0.5; i=$((i + 1))
  done
  log "20 秒内 daemon 未响应，请看日志：$LOG_DIR/daemon.log"
  return 1
}

cmd_install() {
  local with_tunnel=0
  for arg in "$@"; do
    case "$arg" in
      --tunnel) with_tunnel=1 ;;
      *) die "未知参数 $arg" ;;
    esac
  done

  [ "$(uname)" = "Darwin" ] || die "只支持 macOS"
  [ -x "$RUNNER" ] || chmod +x "$RUNNER"
  [ -x "$REPO_DIR/node_modules/.bin/tsx" ] || die "缺少 node_modules，请先在 $REPO_DIR 执行 pnpm install"
  case "$REPO_DIR" in
    "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
      log "提示：仓库位于受 TCC 保护的目录（$REPO_DIR）。若日志出现 Operation not permitted，"
      log "      请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中添加 /bin/zsh，或把仓库移到 ~/code 之类目录后重装。"
      ;;
  esac

  mkdir -p "$AGENTS_DIR" "$LOG_DIR"
  local port
  port="$(daemon_port)"

  bootout "$DAEMON_LABEL"
  stop_stray_listener "$port"
  write_daemon_plist
  bootstrap "$DAEMON_LABEL" "$daemon_plist"
  log "已安装 $DAEMON_LABEL（日志 $LOG_DIR/daemon.log）"
  wait_healthy "$port" || true

  if [ $with_tunnel -eq 1 ]; then
    local bin name
    bin="$(find_cloudflared)"
    [ -n "$bin" ] || die "找不到 cloudflared（brew install cloudflared，或设置 CLOUDFLARED_BIN）"
    [ -f "$HOME/.cloudflared/config.yml" ] || die "缺少 ~/.cloudflared/config.yml（named tunnel 配置）"
    name="${CLAUDE_REMOTE_TUNNEL:-claude-remote}"
    bootout "$TUNNEL_LABEL"
    stop_stray_tunnel "$name"
    write_tunnel_plist "$bin" "$name"
    bootstrap "$TUNNEL_LABEL" "$tunnel_plist"
    log "已安装 $TUNNEL_LABEL（隧道 $name，日志 $LOG_DIR/tunnel.log）"
  fi
}

cmd_uninstall() {
  for label in "$DAEMON_LABEL" "$TUNNEL_LABEL"; do
    bootout "$label"
    rm -f "$AGENTS_DIR/$label.plist"
    log "已移除 $label"
  done
}

cmd_restart() {
  for label in "$DAEMON_LABEL" "$TUNNEL_LABEL"; do
    if is_loaded "$label"; then
      launchctl kickstart -k "$DOMAIN/$label"
      log "已重启 $label"
    fi
  done
}

cmd_status() {
  for label in "$DAEMON_LABEL" "$TUNNEL_LABEL"; do
    if is_loaded "$label"; then
      launchctl print "$DOMAIN/$label" | grep -E '^[[:space:]]*(state|pid|last exit code|runs) =' | sed "s/^/$label: /"
    elif [ -f "$AGENTS_DIR/$label.plist" ]; then
      echo "$label: 已安装但未加载（重新 install 即可）"
    else
      echo "$label: 未安装"
    fi
  done
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  touch "$LOG_DIR/daemon.log"
  tail -n 50 -F "$LOG_DIR"/*.log
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  uninstall) cmd_uninstall ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
