// sessionId → JSONL 文件定位与 cwd 提取（HTTP 层胶水）。
//
// 定位逻辑与 SessionWatcher.#resolveFile 一致：遍历 projectsDir 下项目目录找
// `<sessionId>.jsonl`。cwd 从文件头部行内字段读取（决策：不从目录名反解），
// 拿到即断流；整个文件没有 cwd 时返回 ""（调用方决定回退值）。

import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

/** 定位会话文件；不存在时抛 code=ENOENT 错误（HTTP 层转 404）。 */
export async function resolveSessionFile(projectsDir: string, sessionId: string): Promise<string> {
  const name = `${sessionId}.jsonl`;
  const dirents = await readdir(projectsDir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const candidate = join(projectsDir, dirent.name, name);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // 该项目目录下没有，继续
    }
  }
  const error = new Error(`session file not found: ${sessionId}`);
  (error as NodeJS.ErrnoException).code = "ENOENT";
  throw error;
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

const WRITE_TOOL_PATH_KEY: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** 只解析父目录：文件写入后被换成符号链接时，真实路径和记录对不上，不算写过。 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

async function transcriptWroteFile(file: string, target: string): Promise<boolean> {
  const name = basename(target);
  const escapedName = JSON.stringify(name).slice(1, -1);
  const pending = new Set<string>();
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(escapedName) && ![...pending].some((id) => line.includes(id))) continue;
      let record: { type?: unknown; message?: { content?: unknown } } | null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const blocks = record?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks as Array<Record<string, unknown> | null>) {
        if (record?.type === "assistant" && block?.type === "tool_use") {
          const key = WRITE_TOOL_PATH_KEY[String(block.name)];
          const path = key === undefined ? undefined : (block.input as Record<string, unknown> | null)?.[key];
          if (typeof path !== "string" || !isAbsolute(path) || basename(path) !== name) continue;
          if ((await canonicalPath(path)) === target) pending.add(String(block.id));
        } else if (record?.type === "user" && block?.type === "tool_result" && pending.has(String(block.tool_use_id))) {
          if (block.is_error !== true) return true;
          pending.delete(String(block.tool_use_id));
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return false;
}

/** 按结构化的工具调用判断，且要求调用成功：对话正文提到路径、被拒绝的写入都不算。子 Agent 的记录一并查。 */
export async function sessionWroteFile(sessionFile: string, target: string): Promise<boolean> {
  const subagentsDir = join(dirname(sessionFile), basename(sessionFile, ".jsonl"), "subagents");
  const subagents = await readdir(subagentsDir).catch(() => [] as string[]);
  const transcripts = [
    sessionFile,
    ...subagents.filter((name) => name.endsWith(".jsonl")).map((name) => join(subagentsDir, name)),
  ];
  for (const transcript of transcripts) {
    if (await transcriptWroteFile(transcript, target)) return true;
  }
  return false;
}
