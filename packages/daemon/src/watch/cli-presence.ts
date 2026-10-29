// CliExitReleaser：终端关闭后立刻解除 terminal-driving。
//
// ActivityTracker 只看文件写入，终端退出时 CLI 还会补写 JSONL，于是要再等满 cooldown
// 才回 idle。Claude CLI 每个进程会在 ~/.claude/sessions/<pid>.json 登记自己的 sessionId，
// 退出时删除——据此判断"终端还开着没"。
//
// 只对"最近见过登记"的会话做释放：没登记文件的老版本 CLI 退回到纯 cooldown 判定，
// 不会把仍在使用的终端误判为已关闭。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ActivityTracker } from "./activity.js";

export type PidAlive = (pid: number) => boolean;

const systemPidAlive: PidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** 读取登记目录，返回仍存活的 CLI 进程所驾驶的 sessionId。目录不存在视为空。 */
export async function readLiveCliSessions(dir: string, pidAlive: PidAlive = systemPidAlive): Promise<Set<string>> {
  const live = new Set<string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return live;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const entry = JSON.parse(await readFile(join(dir, name), "utf8")) as { pid?: unknown; sessionId?: unknown };
          if (typeof entry.sessionId === "string" && typeof entry.pid === "number" && pidAlive(entry.pid)) {
            live.add(entry.sessionId);
          }
        } catch {
          // 写到一半 / 刚被删：下一轮再看
        }
      }),
  );
  return live;
}

export interface CliExitReleaserOptions {
  tracker: Pick<ActivityTracker, "terminalSessions" | "release">;
  readLive: () => Promise<Set<string>>;
  now?: () => number;
  /** 进程消失后仍认作"刚关闭"的窗口，覆盖退出前后的收尾写入。 */
  recentMs?: number;
  /** 释放后忽略收尾写入的宽限期。 */
  graceMs?: number;
}

export class CliExitReleaser {
  readonly #options: CliExitReleaserOptions;
  readonly #lastSeenLive = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: CliExitReleaserOptions) {
    this.#options = options;
  }

  start(intervalMs = 2_000): void {
    this.#timer ??= setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const { tracker, readLive, now = Date.now, recentMs = 10_000, graceMs = 3_000 } = this.#options;
      const live = await readLive();
      const at = now();
      for (const id of live) this.#lastSeenLive.set(id, at);
      for (const id of tracker.terminalSessions()) {
        if (!live.has(id) && this.#lastSeenLive.has(id)) tracker.release(id, graceMs);
      }
      for (const [id, seen] of this.#lastSeenLive) {
        if (!live.has(id) && at - seen > recentMs) this.#lastSeenLive.delete(id);
      }
    } catch (error) {
      console.warn("cli presence check failed:", error);
    } finally {
      this.#ticking = false;
    }
  }
}
