#!/usr/bin/env node
// npm 包的 cr 入口（构建后为 dist/cli.js）。源码运行走 bin/cr.mjs（tsx）。
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main } from "./main.js";

await main(process.argv.slice(2), realpathSync(fileURLToPath(import.meta.url)));
