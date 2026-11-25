import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { forkSession, renameSession } from "@claude-remote/agent-bridge";
import { claudeProjectsDir } from "./config.js";

export interface SessionOperations {
  rename(file: string, sessionId: string, title: string): Promise<void>;
  fork(file: string, sessionId: string, title?: string): Promise<{ sessionId: string }>;
}

async function verifySdkTarget(file: string, sessionId: string): Promise<void> {
  const projectsDir = await realpath(claudeProjectsDir());
  if (dirname(dirname(file)) !== projectsDir || basename(file) !== `${sessionId}.jsonl`) {
    throw new Error("Session is outside the SDK transcript store");
  }

  // SDK lookup without dir also searches symlinked projects. Require exactly one match
  // so that it can only select the file already validated by the daemon.
  const entries = await readdir(projectsDir);
  for (const entry of entries) {
    const candidate = join(projectsDir, entry, `${sessionId}.jsonl`);
    if (candidate === file) continue;
    try {
      await lstat(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    throw new Error("Ambiguous SDK session ID");
  }

  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size === 0 || await realpath(file) !== file) {
      throw new Error("Invalid SDK transcript");
    }
    const lastByte = Buffer.alloc(1);
    if ((await handle.read(lastByte, 0, 1, stats.size - 1)).bytesRead !== 1 || lastByte[0] !== 0x0a) {
      throw new Error("Incomplete SDK transcript");
    }
  } finally {
    await handle.close();
  }
}

export const sdkSessionOperations: SessionOperations = {
  async rename(file, sessionId, title) {
    await verifySdkTarget(file, sessionId);
    await renameSession(sessionId, title);
  },
  async fork(file, sessionId, title) {
    await verifySdkTarget(file, sessionId);
    return forkSession(sessionId, title === undefined ? undefined : { title });
  },
};
