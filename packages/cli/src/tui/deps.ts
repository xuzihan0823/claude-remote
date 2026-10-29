// TUI 的外部依赖接口：真实实现由 main 装配，测试注入假实现。

import { closeSync, openSync, readSync, statSync } from "node:fs";

import type { Api, EventStream, ServerFrame, SessionSummary } from "../api.js";
import {
  autostartEnabled,
  pairInfo,
  snapshot,
  terminalQr,
  waitHealthy,
  type Context,
  type DaemonSnapshot,
} from "../daemon-control.js";
import { connectEvents } from "../api.js";
import { readConfig, rotateToken, setConfig, type ConfigField, type ConfigValue } from "../config.js";

export type ApiLike = Pick<Api, "search" | "messages" | "send" | "abort" | "decide" | "pending">;

export interface TuiDeps {
  baseUrl: string;
  api: ApiLike | undefined;
  snapshot: () => Promise<DaemonSnapshot>;
  connect: ((handlers: { onFrame: (f: ServerFrame) => void; onConnection?: (up: boolean) => void }) => EventStream) | undefined;
  control: {
    available: boolean;
    up: () => Promise<boolean>;
    down: () => Promise<void>;
    restart: () => Promise<boolean>;
  };
  pair: () => Promise<{ qr: string; bases: string[] } | undefined>;
  readLogTail: (maxLines: number) => string[];
  config: {
    read: () => ConfigValue[];
    /** raw 为展示单位；空字符串恢复默认。校验失败抛错。 */
    set: (field: ConfigField, raw: string) => void;
    rotateToken: () => void;
  };
}

/** 读文件尾部若干行（只读最后 256KB，日志再大也不卡）。 */
export function readTailLines(file: string, maxLines: number): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, "r");
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function realDeps(ctx: Context): TuiDeps {
  const darwin = process.platform === "darwin";
  return {
    baseUrl: ctx.env.baseUrl,
    api: ctx.api,
    snapshot: () => snapshot(ctx),
    connect:
      ctx.env.token === undefined
        ? undefined
        : (handlers) => connectEvents(ctx.env.baseUrl, ctx.env.token as string, handlers),
    control: autostartEnabled(ctx.env)
      ? {
          available: darwin,
          up: async () => {
            await ctx.launchd.up();
            return waitHealthy(ctx);
          },
          down: () => ctx.launchd.down(),
          restart: async () => {
            await ctx.launchd.restart();
            return waitHealthy(ctx);
          },
        }
      : {
          // 随 cr 运行：启停的是 cr 拉起的子进程
          available: true,
          up: async () => {
            if (await ctx.attached.ensure() !== "started") return waitHealthy(ctx);
            return true;
          },
          down: async () => {
            await ctx.attached.stop();
          },
          restart: () => ctx.attached.restart(),
        },
    pair: async () => {
      const info = pairInfo(ctx);
      if (info === undefined) return undefined;
      return { qr: await terminalQr(info), bases: info.bases };
    },
    readLogTail: (n) => readTailLines(ctx.env.logFile, n),
    config: {
      read: () => readConfig(ctx.env.envFile),
      set: (field, raw) => setConfig(ctx.env.envFile, field, raw),
      rotateToken: () => void rotateToken(ctx.env.envFile),
    },
  };
}

export type { ConfigField, ConfigValue, DaemonSnapshot, SessionSummary };
