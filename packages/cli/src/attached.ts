// 「随 cr 运行」模式（开机自启关闭时的默认）：daemon 是 cr 拉起的子进程，cr 退出就一起停。
//
// - 子进程放在独立进程组（detached），终端里按 Ctrl-C（比如 o 接管会话时在 claude 里中断）不会误伤它；
// - 换来的代价是关终端时它收不到 SIGHUP，所以由 cr 在 exit / SIGHUP / SIGTERM / SIGINT 时主动 SIGTERM；
// - pid 写进 pidFile：cr 被 kill -9 留下的孤儿，下次启动时认领回来，退出时照样停掉；
// - 另一个 cr 已经拉起的 daemon（pidFile 指向的进程仍归那个 cr）不重复启动，也不由本进程停止。

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { LaunchProgram } from "./launchd.js";

export interface AttachedOptions {
  program: () => LaunchProgram;
  logFile: string;
  pidFile: string;
  /** daemon 是否已经在响应（任何来源）。 */
  healthy: () => Promise<boolean>;
  waitHealthy: () => Promise<boolean>;
  spawnImpl?: typeof spawn;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

interface PidRecord {
  pid: number;
  owner: number; // 拉起它的 cr 进程 pid
}

export class AttachedDaemon {
  /** 前台在跑 claude（o 接管）时为 true：那时的 SIGINT 是给 claude 的，不能顺手停 daemon、退出 cr。 */
  static foregroundChild = false;
  readonly #opts: AttachedOptions;
  readonly #kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  #child: ChildProcess | undefined;
  #ownedPid: number | undefined;
  #hooked = false;

  constructor(opts: AttachedOptions) {
    this.#opts = opts;
    this.#kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  }

  get ownedPid(): number | undefined {
    return this.#ownedPid;
  }

  #alive(pid: number): boolean {
    try {
      this.#kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  #readPid(): PidRecord | undefined {
    try {
      const rec = JSON.parse(readFileSync(this.#opts.pidFile, "utf8")) as Partial<PidRecord>;
      if (typeof rec.pid === "number" && typeof rec.owner === "number") return rec as PidRecord;
    } catch {
      // 没有或损坏
    }
    return undefined;
  }

  #writePid(pid: number): void {
    mkdirSync(dirname(this.#opts.pidFile), { recursive: true });
    writeFileSync(this.#opts.pidFile, JSON.stringify({ pid, owner: process.pid } satisfies PidRecord));
  }

  #clearPid(): void {
    const rec = this.#readPid();
    if (rec === undefined || rec.pid === this.#ownedPid) rmSync(this.#opts.pidFile, { force: true });
  }

  /** 确保 daemon 在跑。返回 "started" | "adopted" | "shared"（别的 cr 或手工起的）。 */
  async ensure(): Promise<"started" | "adopted" | "shared" | "owned"> {
    if (this.#ownedPid !== undefined && this.#alive(this.#ownedPid)) return "owned";
    const rec = this.#readPid();
    if (rec !== undefined && this.#alive(rec.pid)) {
      if (!this.#alive(rec.owner) || rec.owner === process.pid) {
        // 孤儿（拉起它的 cr 已经没了）：认领
        this.#own(rec.pid);
        this.#writePid(rec.pid);
        return "adopted";
      }
      return "shared";
    }
    if (await this.#opts.healthy()) return "shared";
    await this.start();
    return "started";
  }

  async start(): Promise<boolean> {
    const program = this.#opts.program();
    mkdirSync(dirname(this.#opts.logFile), { recursive: true });
    const fd = openSync(this.#opts.logFile, "a");
    try {
      const child = (this.#opts.spawnImpl ?? spawn)(program.args[0] as string, program.args.slice(1), {
        cwd: existsSync(program.workingDir) ? program.workingDir : undefined,
        env: { ...process.env, ...program.env },
        stdio: ["ignore", fd, fd],
        detached: true,
      });
      this.#child = child;
      if (child.pid === undefined) throw new Error(`无法启动 daemon：${program.args.join(" ")}`);
      this.#own(child.pid);
      this.#writePid(child.pid);
      child.on("exit", () => {
        if (this.#child === child) {
          this.#child = undefined;
          if (this.#ownedPid === child.pid) {
            this.#clearPid();
            this.#ownedPid = undefined;
          }
        }
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    return this.#opts.waitHealthy();
  }

  #own(pid: number): void {
    this.#ownedPid = pid;
    if (this.#hooked) return;
    this.#hooked = true;
    process.on("exit", () => this.#stopSync());
    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (signal === "SIGINT" && AttachedDaemon.foregroundChild) return;
        this.#stopSync();
        process.exit(signal === "SIGINT" ? 130 : 129);
      });
    }
  }

  #stopSync(): void {
    const pid = this.#ownedPid;
    if (pid === undefined) return;
    try {
      this.#kill(pid, "SIGTERM");
    } catch {
      // 已退出
    }
    this.#clearPid();
    this.#ownedPid = undefined;
  }

  /** 停止本进程拥有（或可认领）的 daemon，等它退出（最多 15 秒）。 */
  async stop(): Promise<boolean> {
    let pid = this.#ownedPid;
    if (pid === undefined) {
      const rec = this.#readPid();
      if (rec !== undefined && this.#alive(rec.pid)) pid = rec.pid;
    }
    if (pid === undefined) return false;
    try {
      this.#kill(pid, "SIGTERM");
    } catch {
      // 已退出
    }
    for (let i = 0; i < 75 && this.#alive(pid); i += 1) await new Promise((r) => setTimeout(r, 200));
    if (this.#alive(pid)) {
      try {
        this.#kill(pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
    if (this.#ownedPid === pid) this.#ownedPid = undefined;
    rmSync(this.#opts.pidFile, { force: true });
    return true;
  }

  async restart(): Promise<boolean> {
    await this.stop();
    return this.start();
  }
}
