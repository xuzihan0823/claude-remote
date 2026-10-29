#!/usr/bin/env node
// 构建 npm 发布包到 dist/npm/：
//   dist/cli.js     cr 命令（Ink TUI + 子命令）
//   dist/daemon.js  daemon（launchd 直接 node 运行）
//
// workspace 包（@claude-remote/*）打进 bundle；第三方依赖保持 external，作为 dependencies 由 npm 安装
// （Ink/yoga 的 wasm、Agent SDK 自带的 claude CLI 都不适合打包）。
//
// 用法：node scripts/build-npm.mjs [--name <npm 包名>]
//   发布：cd dist/npm && npm publish --access public

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "npm");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const nameArg = process.argv.indexOf("--name");
const name = nameArg > 0 ? process.argv[nameArg + 1] : process.env.NPM_NAME || "@anyu/claude-remote";
const rootPkg = readJson("package.json");
const workspacePkgs = ["cli", "daemon", "agent-bridge", "interactions"].map((p) => readJson(`packages/${p}/package.json`));

// 第三方运行时依赖：从各 workspace 包汇总（版本以第一次出现为准）
const RUNTIME_EXCLUDE = new Set(["tsx"]); // 构建后不再需要 tsx
const dependencies = {};
for (const pkg of workspacePkgs) {
  for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
    if (dep.startsWith("@claude-remote/") || RUNTIME_EXCLUDE.has(dep)) continue;
    dependencies[dep] ??= version;
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** 裸模块：workspace 包打进来，其余 external。 */
const externalizeThirdParty = {
  name: "externalize-third-party",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("node:") || args.path.startsWith("@claude-remote/")) return undefined;
      if (args.path.startsWith("/")) return undefined;
      const pkgName = args.path.startsWith("@") ? args.path.split("/").slice(0, 2).join("/") : args.path.split("/")[0];
      if (!(pkgName in dependencies)) {
        throw new Error(`${args.importer} 引用了 ${args.path}，但它不在任何 workspace 包的 dependencies 里`);
      }
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: {
    cli: join(root, "packages/cli/src/bin.ts"),
    daemon: join(root, "packages/daemon/src/index.ts"),
  },
  outdir: join(out, "dist"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  jsx: "automatic",
  chunkNames: "chunks/[name]-[hash]",
  plugins: [externalizeThirdParty],
  logLevel: "warning",
  legalComments: "none",
});


const version = rootPkg.version;
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name,
      version,
      description: "在 iPhone 上接管 Mac 里的 Claude Code 会话：终端控制台 cr + 常驻 daemon",
      type: "module",
      bin: { cr: "dist/cli.js" },
      files: ["dist", "README.md"],
      engines: { node: rootPkg.engines.node },
      os: ["darwin", "linux"],
      dependencies,
      repository: { type: "git", url: "git+https://github.com/xuzihan0823/claude-remote.git" },
      ...(rootPkg.license ? { license: rootPkg.license } : {}),
      keywords: ["claude", "claude-code", "remote", "iphone", "tui"],
    },
    null,
    2,
  )}\n`,
);

cpSync(join(root, "README.md"), join(out, "README.md"));

console.log(`✓ ${name}@${version} → ${out}`);
console.log(`  依赖：${Object.entries(dependencies).map(([k, v]) => `${k}@${v}`).join(" ")}`);
