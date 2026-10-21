#!/bin/zsh
# launchd 入口：在仓库根目录以前台方式运行 daemon（launchd 负责常驻与崩溃重启）。
#
# 为什么需要这层包装：
#   - launchd 进程没有交互 shell 的 PATH，node / pnpm / claude 可能找不到；
#   - BRIDGE_TOKEN 优先取仓库 .env，其次取菜单栏 App 存在 Keychain 的 token，
#     这样 launchd、菜单栏 App、终端手工启动三种方式用的是同一个 token。
#
# 由 scripts/launchd/install.sh 生成的 LaunchAgent 调用；也可手工运行做冒烟测试。

set -u

SCRIPT_DIR="${0:A:h}"
REPO_DIR="${CLAUDE_REMOTE_REPO:-${SCRIPT_DIR:h:h}}"

# launchd 下 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin。补齐常见安装位置。
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/Library/pnpm:$PATH"
# nvm / fnm 用户：login shell 不一定会加载它们，这里尽力而为。
if [[ -s "$HOME/.nvm/nvm.sh" ]] && ! command -v node >/dev/null 2>&1; then
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

cd "$REPO_DIR" || {
  echo "[run-daemon] 无法进入仓库目录 $REPO_DIR（若在 ~/Desktop 或 ~/Documents 下，需在「隐私与安全性 → 完全磁盘访问」里给 /bin/zsh 授权，或把仓库移出这些目录）" >&2
  exit 78 # EX_CONFIG：launchd 仍会按 ThrottleInterval 重试
}

for bin in node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[run-daemon] 找不到 $bin，PATH=$PATH" >&2
    exit 78
  fi
done

# token：已有环境变量 > .env > Keychain（菜单栏 App 写入的 service=claude-remote / account=bridge-token）
if [[ -z "${BRIDGE_TOKEN:-}" ]] && ! grep -Eq '^[[:space:]]*BRIDGE_TOKEN=[^[:space:]]+' .env 2>/dev/null; then
  keychain_token="$(/usr/bin/security find-generic-password -s claude-remote -a bridge-token -w 2>/dev/null || true)"
  if [[ -n "$keychain_token" ]]; then
    export BRIDGE_TOKEN="$keychain_token"
  fi
fi

if [[ -z "${CLAUDE_BIN:-}" ]] && command -v claude >/dev/null 2>&1; then
  export CLAUDE_BIN="$(command -v claude)"
fi

echo "[run-daemon] $(date '+%F %T') starting in $REPO_DIR (node $(node --version))"
TSX="$REPO_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "[run-daemon] 缺少 $TSX，请先在仓库根目录执行 pnpm install" >&2
  exit 78
fi
# 直接 exec tsx（等价于 pnpm dev，少一层 pnpm 进程）：tsx 会把 SIGTERM 转给 daemon，
# 走 index.ts 里的优雅退出（关 WS、abort 活跃 run、关 sqlite）。
exec "$TSX" packages/daemon/src/index.ts
