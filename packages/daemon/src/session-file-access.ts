// 手机读取会话文件的路径校验与类型判断。
//
// 手机本来就能让 Agent 读写这台电脑上的任意文件，所以这个接口不限目录，只拦敏感文件。
// 相对路径按会话工作目录解析，工作目录取不到时不回退到后台进程目录。

import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";

export type PreviewKind = "html" | "image" | "text" | "markdown" | "pdf" | "none";
export type FileAccessErrorCode = "invalid_path" | "sensitive_file" | "file_not_found";

const ERROR_STATUS: Record<FileAccessErrorCode, number> = {
  invalid_path: 400,
  sensitive_file: 403,
  file_not_found: 404,
};

export class FileAccessError extends Error {
  readonly code: FileAccessErrorCode;
  readonly status: number;

  constructor(code: FileAccessErrorCode) {
    super(code);
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

// macOS 默认不区分大小写，.ENV 和 .env 是同一个文件
const SENSITIVE_SEGMENT = /^(?:\.env.*|\.git|\.ssh|.*\.pem|.*\.key|id_rsa.*|\.npmrc|\.netrc)$/i;

function isSensitive(path: string): boolean {
  return path.split(sep).some((segment) => SENSITIVE_SEGMENT.test(segment));
}

export interface SessionFile {
  path: string;
  stats: Stats;
}

/** 符号链接解析后再查一次敏感规则，防止用无害的名字指向敏感文件。 */
export async function resolveRequestedFile(cwd: string, requested: string | null): Promise<SessionFile> {
  if (!requested || requested.includes("\0")) throw new FileAccessError("invalid_path");
  if (cwd === "" && !isAbsolute(requested)) throw new FileAccessError("invalid_path");

  const target = resolve(cwd, requested);
  if (isSensitive(target)) throw new FileAccessError("sensitive_file");
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new FileAccessError("file_not_found");
  }
  if (isSensitive(real)) throw new FileAccessError("sensitive_file");

  let stats: Stats;
  try {
    stats = await stat(real);
  } catch {
    throw new FileAccessError("file_not_found");
  }
  if (!stats.isFile()) throw new FileAccessError("file_not_found");
  return { path: real, stats };
}

const TEXT_MIME = "text/plain; charset=utf-8";
const TEXT_EXTENSIONS = [
  "txt", "log", "json", "jsonc", "yaml", "yml", "toml", "xml", "csv", "tsv", "ini", "conf", "cfg",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "sql", "css", "scss", "less",
  "vue", "svelte", "graphql", "proto", "diff", "patch", "svg",
];

const FILE_TYPES: Record<string, { mime: string; previewKind: PreviewKind }> = {
  html: { mime: "text/html; charset=utf-8", previewKind: "html" },
  htm: { mime: "text/html; charset=utf-8", previewKind: "html" },
  md: { mime: "text/markdown; charset=utf-8", previewKind: "markdown" },
  markdown: { mime: "text/markdown; charset=utf-8", previewKind: "markdown" },
  pdf: { mime: "application/pdf", previewKind: "pdf" },
  jpg: { mime: "image/jpeg", previewKind: "image" },
  jpeg: { mime: "image/jpeg", previewKind: "image" },
  png: { mime: "image/png", previewKind: "image" },
  gif: { mime: "image/gif", previewKind: "image" },
  webp: { mime: "image/webp", previewKind: "image" },
  heic: { mime: "image/heic", previewKind: "image" },
  heif: { mime: "image/heif", previewKind: "image" },
  ...Object.fromEntries(TEXT_EXTENSIONS.map((ext) => [ext, { mime: TEXT_MIME, previewKind: "text" as const }])),
};

export function fileTypeOf(path: string): { mime: string; previewKind: PreviewKind } {
  return FILE_TYPES[extname(path).slice(1).toLowerCase()] ?? { mime: "application/octet-stream", previewKind: "none" };
}

export function fileMeta({ path, stats }: SessionFile) {
  return { name: basename(path), path, sizeBytes: stats.size, mtimeMs: stats.mtimeMs, ...fileTypeOf(path) };
}

export type ByteRange = { start: number; end: number };

/**
 * 解析单段 Range。返回 null 表示按整个文件响应（无 Range、格式不认识、多段），
 * "unsatisfiable" 对应 416。end 超出文件时按 RFC 9110 截到末尾。
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== "" && Number(last) < start) return null;
  return start >= size ? "unsatisfiable" : { start, end };
}
