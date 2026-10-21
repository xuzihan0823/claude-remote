#!/usr/bin/env node
// cr 启动器：用 tsx 直接运行 TypeScript 源码（与 daemon 一致，无构建步骤）。
// 可以被软链到 ~/.local/bin/cr（cr setup 会做），这里按真实路径定位源码。
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const self = realpathSync(fileURLToPath(import.meta.url));
// 显式指定本包 tsconfig（jsx: react-jsx），否则 tsx 会用当前目录的 tsconfig
register({ tsconfig: join(dirname(self), "../tsconfig.json") });
const { main } = await import(pathToFileURL(join(dirname(self), "../src/main.tsx")).href);
await main(process.argv.slice(2), self);
