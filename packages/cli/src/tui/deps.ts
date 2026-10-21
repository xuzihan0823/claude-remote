// TUI 的外部依赖接口：真实实现由 main 装配，测试注入假实现。

import { closeSync, openSync, readSync, statSync } from "node:fs";

import type { Api, EventStream, ServerFrame, SessionSummary } from "../api.js";
import {
  copyToClipboard,
  openUrl,
  pairInfo,
  snapshot,
  terminalQr,
  waitHealthy,
  type Context,
  type DaemonSnapshot,
} from "../daemon-control.js";
import { connectEvents } from "../api.js";

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
  openWeb: () => string;
  readLogTail: (maxLines: number) => string[];
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
    control: {
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
    },
    pair: async () => {
      const info = pairInfo(ctx);
      if (info === undefined) return undefined;
      return { qr: await terminalQr(info), bases: info.bases };
    },
    openWeb: () => {
      const url = `${ctx.env.baseUrl}/`;
      openUrl(url);
      const copied = ctx.env.token !== undefined && copyToClipboard(ctx.env.token);
      return copied ? "已打开浏览器，token 已复制到剪贴板" : `已打开 ${url}`;
    },
    readLogTail: (n) => readTailLines(ctx.env.logFile, n),
  };
}

export type { DaemonSnapshot, SessionSummary };
