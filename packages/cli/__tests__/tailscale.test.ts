import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { makeContext, pairInfo } from "../src/daemon-control.js";
import { loadCliEnv, readDotenv } from "../src/env.js";
import { configureTailscaleServe } from "../src/tailscale.js";

test("首次配对跳过 Funnel 端口，保存私有 Serve 地址；重复配对复用已有配置", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cr-tailscale-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.writeHead(req.headers.authorization === "Bearer test-token" ? 200 : 401);
    res.end(JSON.stringify({ ok: true }));
  }).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const target = `http://127.0.0.1:${addr.port}`;

  const envFile = join(dir, ".env");
  await writeFile(envFile, `BRIDGE_PORT=${addr.port}\nBRIDGE_TOKEN=test-token\n`);
  const host = "mac.example.ts.net";
  const expectedBase = `https://${host}:8443`;
  const configFile = join(dir, "serve.json");
  await writeFile(configFile, JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: target } } } },
    AllowFunnel: { [`${host}:443`]: true },
  }));
  const callsFile = join(dir, "serve-calls");
  await writeFile(join(dir, "tailscale"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "status") {
  console.log(JSON.stringify({ BackendState: "Running" }));
} else if (args[1] === "status") {
  console.log(fs.readFileSync(${JSON.stringify(configFile)}, "utf8"));
} else {
  fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
  const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, "utf8"));
  config.TCP[8443] = { HTTPS: true };
  config.Web[${JSON.stringify(`${host}:8443`)}] = { Handlers: { "/": { Proxy: args.at(-1) } } };
  fs.writeFileSync(${JSON.stringify(configFile)}, JSON.stringify(config));
}
`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  const ctx = makeContext(loadCliEnv({ env: {}, install: { mode: "repo", root: dir } }));
  await configureTailscaleServe(ctx);
  await configureTailscaleServe(ctx);
  assert.equal(readDotenv(envFile).TAILSCALE_SERVE_URL, expectedBase);
  assert.deepEqual(pairInfo(ctx)?.bases, [expectedBase]);
  assert.deepEqual(JSON.parse((await readFile(callsFile, "utf8")).trim()), ["serve", "--bg", "--https=8443", target]);
  assert.deepEqual(paths, ["GET /api/health", "POST /api/channels/refresh", "GET /api/health", "POST /api/channels/refresh"]);
});
