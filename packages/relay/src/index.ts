// relay 入口：读配置 → 启动 → SIGINT/SIGTERM 优雅退出。不打印密钥。

import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ConfigError, loadConfig } from "./config.js";
import { startRelay } from "./server.js";

export { ConfigError, loadConfig, type RelayConfig } from "./config.js";
export { CLOSE_REPLACED, DEFAULT_TIMINGS, startRelay, type RelayHandle, type RelayOptions, type RelayTimings } from "./server.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return process.env.RELAY_VERSION?.trim() || "unknown";
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[relay] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const relay = await startRelay({ ...config, version: readVersion() });
  console.log(`[relay] listening on http://${relay.host.includes(":") ? `[${relay.host}]` : relay.host}:${relay.port}`);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[relay] ${signal} received, shutting down`);
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// 作为库被 import（测试、daemon）时不启动
if (isEntry()) {
  main().catch((error: unknown) => {
    console.error("[relay] fatal:", error);
    process.exit(1);
  });
}
