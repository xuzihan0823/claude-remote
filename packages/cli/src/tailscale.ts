import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { normalizeTailscaleServeUrl, TAILSCALE_SERVE_URL } from "@claude-remote/daemon/pair";

import { Api } from "./api.js";
import { editEnvFile, removeDotenvKey } from "./config.js";
import type { Context } from "./daemon-control.js";
import { upsertDotenv } from "./env.js";

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
}

function findPrivateServeBase(config: ServeConfig, target: string): string | undefined {
  for (const [hostPort, site] of Object.entries(config.Web ?? {})) {
    const port = hostPort.split(":").at(-1) ?? "";
    if (!config.TCP?.[port]?.HTTPS || config.AllowFunnel?.[hostPort]) continue;
    const handlers = site.Handlers ?? {};
    const proxy = handlers["/"]?.Proxy;
    if (proxy === undefined || proxy.replace(/^http:\/\/localhost:/, "http://127.0.0.1:").replace(/\/$/, "") !== target) continue;
    // Reuse a root proxy only when another mount cannot intercept Claude Remote requests.
    if (Object.keys(handlers).length !== 1) continue;
    const base = normalizeTailscaleServeUrl(`https://${hostPort}`);
    if (base !== undefined) return base;
  }
  return undefined;
}

function availableServePort(config: ServeConfig): number | undefined {
  const configs = [config, ...Object.values(config.Foreground ?? {})];
  return [443, 8443].find((port) => configs.every((entry) => {
    const sites = [...Object.keys(entry.Web ?? {}), ...Object.keys(entry.AllowFunnel ?? {})];
    return !entry.TCP?.[port] && !sites.some((hostPort) => hostPort.endsWith(`:${port}`));
  }));
}

function serveStatus(bin: string, env: NodeJS.ProcessEnv): ServeConfig {
  try {
    const stdout = execFileSync(bin, ["serve", "status", "--json"], { env, encoding: "utf8", timeout: 5_000 });
    return (JSON.parse(stdout) as ServeConfig | null) ?? {};
  } catch {
    throw new Error("无法读取 Tailscale Serve 状态。请在 Mac 上打开 Tailscale、连接到 tailnet 后重试。");
  }
}

export async function configureTailscaleServe(ctx: Context): Promise<void> {
  const { port, token, envFile } = ctx.env;
  if (token === undefined) throw new Error("没有找到 BRIDGE_TOKEN，先运行 cr");
  const target = `http://127.0.0.1:${port}`;
  const api = new Api(target, token, 2_000);
  try {
    if (!(await api.health()).ok) throw new Error("unexpected health response");
  } catch {
    throw new Error("Serve 连不到本机 daemon。请保持 cr 运行。如果此前绑定了 Tailscale IP，请用 cr config set host 127.0.0.1，生效后再试。");
  }

  const appBin = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const env = { ...process.env, TAILSCALE_BE_CLI: "1" };
  let bin = "tailscale";
  let status = spawnSync(bin, ["status", "--json", "--peers=false"], { env, encoding: "utf8", timeout: 5_000 });
  if ((status.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && existsSync(appBin)) {
    bin = appBin;
    status = spawnSync(bin, ["status", "--json", "--peers=false"], { env, encoding: "utf8", timeout: 5_000 });
  }
  if ((status.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new Error("未找到 Tailscale。请先安装 Tailscale 并连接到 tailnet。");
  }
  let backendState: unknown;
  try {
    if (status.status === 0) backendState = (JSON.parse(status.stdout) as { BackendState?: string } | null)?.BackendState;
  } catch { /* 由下方提示恢复 Tailscale。 */ }
  if (backendState !== "Running") throw new Error("Tailscale 尚未连接。请在 Mac 上连接 Tailscale 后重试。");
  const current = serveStatus(bin, env);
  let base = findPrivateServeBase(current, target);
  if (base === undefined) {
    const httpsPort = availableServePort(current);
    if (httpsPort === undefined) throw new Error("Tailscale Serve 的 443 和 8443 端口已占用。请先为 daemon 配置一个独立的 HTTPS Serve 地址，再重试。");
    const result = spawnSync(bin, ["serve", "--bg", `--https=${httpsPort}`, target], { env, stdio: "inherit" });
    if (result.status !== 0) throw new Error("Tailscale Serve 配置未完成。请根据上方提示处理后重试。");
    base = findPrivateServeBase(serveStatus(bin, env), target);
    if (base === undefined) throw new Error("没有找到指向 daemon 的私有 HTTPS Serve 地址。");
  }

  const serveBase = base;
  editEnvFile(envFile, (config) => upsertDotenv(removeDotenvKey(config, TAILSCALE_SERVE_URL), TAILSCALE_SERVE_URL, serveBase));
  try {
    await api.refreshChannels();
  } catch {
    console.log("Serve 地址已保存。若已配对的手机没有显示 Tailscale，请更新并重启 Mac 上的 daemon，再从手机重新连接。");
  }
}
