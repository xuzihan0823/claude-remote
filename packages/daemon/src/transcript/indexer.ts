// 会话索引器：扫描 <projectsDir>/<编码目录>/<sessionId>.jsonl 产出 SessionSummary。
// 对数据源只读。projectsDir 由调用方注入（默认值在调用侧给 ~/.claude/projects）。
//
// 标题流式扫描完整转录，预览保持有界尾读。摘要只在文件状态改变时重新扫描。

import { createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { isCustomTitleType, stripWrapperTags } from "./reader.js";
import type { SessionSummary } from "./types.js";

const TITLE_MAX_CHARS = 60;
const PREVIEW_MAX_CHARS = 80;
const PREVIEW_INITIAL_TAIL_BYTES = 64 * 1024;
const PREVIEW_MAX_TAIL_BYTES = 1024 * 1024;
const SUMMARY_CACHE_SIZE = 4096;
const summaryCache = new Map<string, { signature: string; summary: SessionSummary | undefined }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 折叠空白成单行后按 Unicode code point 截断，超长补省略号。 */
function toSingleLineTruncated(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) return collapsed;
  return `${chars.slice(0, maxChars).join("")}…`;
}

function textBlocksJoined(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

/** 首条"真实 user 文本"：非 sidechain、非 isMeta、剥包裹标签后非空；纯 tool_result 行不算。 */
function realUserText(o: Record<string, unknown>): string {
  if (o.type !== "user" || o.isSidechain === true || o.isMeta === true) return "";
  const message = isRecord(o.message) ? o.message : undefined;
  if (message === undefined) return "";
  const content = message.content;
  const raw = typeof content === "string" ? content : textBlocksJoined(content);
  return stripWrapperTags(raw).trim();
}

/** 最后一条主链消息的展示文本：text 优先，无 text 时降级到工具/思考摘要。 */
function previewText(o: Record<string, unknown>): string {
  const message = isRecord(o.message) ? o.message : undefined;
  if (message === undefined) return "";
  const content = message.content;
  if (typeof content === "string") return stripWrapperTags(content).trim();
  if (!Array.isArray(content)) return "";
  const text = stripWrapperTags(textBlocksJoined(content)).trim();
  if (text !== "") return text;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "tool_use" && typeof part.name === "string") return `[工具] ${part.name}`;
    if (part.type === "tool_result") return "[工具结果]";
    if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking.trim();
  }
  return "";
}

interface HeadInfo {
  cwd: string;
  title: string;
  customTitle: string;
  /** 发起该会话的客户端（取首个带 cwd 的行上的 entrypoint）；旧版本无此字段时为 ""。 */
  entrypoint: string;
}

// 官方登录的 Claude 桌面端会话：手机端走第三方供应商，不应列出也不应接管这些会话。
// 第三方模式的桌面端是 "claude-desktop-3p"，与 CLI 一样保留。
const HIDDEN_ENTRYPOINTS = new Set(["claude-desktop"]);

async function scanMetadata(filePath: string, sessionId: string, size: number): Promise<HeadInfo> {
  if (size === 0) return { cwd: "", title: "", customTitle: "", entrypoint: "" };
  const stream = createReadStream(filePath, { encoding: "utf8", end: size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = "";
  let title = "";
  let customTitle = "";
  let entrypoint = "";
  try {
    for await (const line of lines) {
      if (cwd !== "" && title !== "" && !line.includes('"customTitle"')) continue;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let o: unknown;
      try {
        o = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(o)) continue;
      if (isCustomTitleType(o.type)) {
        if (o.isSidechain !== true && (o.sessionId === undefined ||
          (typeof o.sessionId === "string" && o.sessionId.toLowerCase() === sessionId.toLowerCase())) &&
          typeof o.customTitle === "string" && !/\p{Cc}/u.test(o.customTitle) && o.customTitle.trim() !== "") {
          customTitle = o.customTitle.trim();
        }
        continue;
      }
      if (cwd === "" && typeof o.cwd === "string" && o.cwd !== "") {
        cwd = o.cwd;
        if (typeof o.entrypoint === "string") entrypoint = o.entrypoint;
        if (HIDDEN_ENTRYPOINTS.has(entrypoint)) break;
      }
      if (title === "") {
        const text = realUserText(o);
        if (text !== "") title = toSingleLineTruncated(text, TITLE_MAX_CHARS);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { cwd, title, customTitle, entrypoint };
}

/** 尾部块读最后一条非 sidechain、非 isMeta 的 user/assistant 行，提取预览文本。 */
async function scanLastPreview(filePath: string, fileSize: number): Promise<string> {
  if (fileSize === 0) return "";
  const handle = await open(filePath, "r");
  try {
    let tailBytes = PREVIEW_INITIAL_TAIL_BYTES;
    for (;;) {
      const readBytes = Math.min(tailBytes, fileSize);
      const start = fileSize - readBytes;
      const buffer = Buffer.alloc(readBytes);
      await handle.read(buffer, 0, readBytes, start);
      const lines = buffer.toString("utf8").split("\n");
      // 非从文件头起读时，首段可能是被截断的半行，丢弃
      const firstIndex = start === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= firstIndex; i -= 1) {
        const trimmed = (lines[i] ?? "").trim();
        if (trimmed === "") continue;
        let o: unknown;
        try {
          o = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!isRecord(o)) continue;
        if (o.isSidechain === true || o.isMeta === true) continue;
        if (o.type !== "user" && o.type !== "assistant") continue;
        const text = previewText(o);
        if (text !== "") return toSingleLineTruncated(text, PREVIEW_MAX_CHARS);
      }
      if (readBytes >= fileSize || tailBytes >= PREVIEW_MAX_TAIL_BYTES) return "";
      tailBytes *= 4;
    }
  } finally {
    await handle.close();
  }
}

export async function readSessionSummary(filePath: string): Promise<SessionSummary | undefined> {
  const stats = await lstat(filePath);
  if (!stats.isFile()) return undefined;
  const signature = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  const cached = summaryCache.get(filePath);
  if (cached?.signature === signature) return cached.summary;

  const sessionId = basename(filePath, ".jsonl");
  const metadata = await scanMetadata(filePath, sessionId, stats.size);
  const summary: SessionSummary | undefined = HIDDEN_ENTRYPOINTS.has(metadata.entrypoint) ? undefined : {
    sessionId,
    cwd: metadata.cwd,
    projectDirName: basename(dirname(filePath)),
    title: metadata.customTitle || metadata.title || "(空会话)",
    lastPreview: await scanLastPreview(filePath, stats.size),
    lastActiveAt: Math.round(stats.mtimeMs),
    sizeBytes: stats.size,
    status: "idle",
  };
  summaryCache.delete(filePath);
  summaryCache.set(filePath, { signature, summary });
  if (summaryCache.size > SUMMARY_CACHE_SIZE) {
    const oldest = summaryCache.keys().next().value;
    if (oldest !== undefined) summaryCache.delete(oldest);
  }
  return summary;
}

/**
 * 列出 projectsDir 下所有会话摘要（跳过官方桌面端会话），按 lastActiveAt 降序。
 * 目录不存在返回空数组；status 本卡固定 "idle"（真实状态由 03 卡覆盖）。
 */
export async function listSessions(projectsDir: string): Promise<SessionSummary[]> {
  let root: string;
  let projectDirs;
  try {
    root = await realpath(projectsDir);
    projectDirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const summaries: SessionSummary[] = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const dirPath = join(root, projectDir.name);
    let files;
    try {
      files = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue; // 目录消失/无权限：跳过该项目目录
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file.name);
      try {
        const summary = await readSessionSummary(filePath);
        if (summary !== undefined) summaries.push(summary);
      } catch {
        continue; // 文件消失等瞬态错误：跳过该文件
      }
    }
  }
  summaries.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return summaries;
}
