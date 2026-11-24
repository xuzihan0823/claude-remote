// sessionId → JSONL 文件定位与 cwd 提取（HTTP 层胶水）。
//
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export function isSafeSessionId(value: string): boolean {
  return value.length > 0 && value !== "." && !value.includes("..") && !/[\/\\\p{Cc}]/u.test(value);
}

/** 定位会话文件；拒绝符号链接和非普通文件。 */
export async function resolveSessionFile(projectsDir: string, sessionId: string): Promise<string> {
  if (isSafeSessionId(sessionId)) {
    const root = await realpath(projectsDir);
    const dirents = await readdir(root, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const candidate = join(root, dirent.name, `${sessionId}.jsonl`);
      try {
        if ((await lstat(candidate)).isFile() && await realpath(candidate) === candidate) return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
      }
    }
  }
  throw Object.assign(new Error("session file not found"), { code: "ENOENT" });
}

const CWD_SCAN_MAX_LINES = 200;

/** 头部流式扫首个带 cwd 字段的行，拿到即断流。没有则 ""。 */
export async function readSessionCwd(file: string): Promise<string> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of lines) {
      seen += 1;
      if (seen > CWD_SCAN_MAX_LINES) break;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const o: unknown = JSON.parse(trimmed);
        if (typeof o === "object" && o !== null && !Array.isArray(o)) {
          const cwd = (o as Record<string, unknown>).cwd;
          if (typeof cwd === "string" && cwd !== "") return cwd;
        }
      } catch {
        // 坏行跳过
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return "";
}
