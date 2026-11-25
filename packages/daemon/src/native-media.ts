import { realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { NativeMediaInput } from "@claude-remote/agent-bridge";
import { FileAccessError, IMAGE_FILE_LIMIT_BYTES, isSensitivePath, openRequestedFile } from "./session-file-access.js";

const UPLOAD_SIGNATURES = {
  ".png": { mediaType: "image/png", matches: (bytes: Buffer) => bytes.subarray(0, 8).equals(PNG_HEADER) },
  ".jpg": { mediaType: "image/jpeg", matches: isJpeg },
  ".jpeg": { mediaType: "image/jpeg", matches: isJpeg },
  ".gif": { mediaType: "image/gif", matches: (bytes: Buffer) => /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6)) },
  ".webp": { mediaType: "image/webp", matches: (bytes: Buffer) =>
    bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP" },
  ".pdf": { mediaType: "application/pdf", matches: (bytes: Buffer) => /^%PDF-\d\.\d/.test(bytes.toString("latin1", 0, 8)) },
} as const;

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isJpeg(bytes: Buffer): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export async function loadNativeAttachments(uploadsDir: string, paths: readonly string[]): Promise<NativeMediaInput[]> {
  if (paths.length === 0) return [];
  const configuredRoot = resolve(uploadsDir);
  let root: string;
  try { root = await realpath(configuredRoot); } catch { throw new FileAccessError("file_not_found"); }

  const attachments: NativeMediaInput[] = [];
  let remaining = IMAGE_FILE_LIMIT_BYTES;
  for (const path of paths) {
    if (!isAbsolute(path) || resolve(path) !== path || /[\\\p{Cc}]/u.test(path)) throw new FileAccessError("invalid_path");
    const suffix = relative(configuredRoot, path);
    if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new FileAccessError("file_not_found");
    }
    if (isSensitivePath(path)) throw new FileAccessError("sensitive_file");

    const file = await openRequestedFile(root, suffix, remaining, true);
    try {
      const extension = extname(file.path).toLowerCase();
      if (!Object.hasOwn(UPLOAD_SIGNATURES, extension)) throw new FileAccessError("unsupported_media_type");
      const { mediaType, matches } = UPLOAD_SIGNATURES[extension as keyof typeof UPLOAD_SIGNATURES];
      const buffer = Buffer.allocUnsafe(file.stats.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > remaining) throw new FileAccessError("payload_too_large");
      if (length === 0 || length !== file.stats.size) throw new FileAccessError("file_not_found");
      const bytes = buffer.subarray(0, length);
      if (!matches(bytes)) throw new FileAccessError("unsupported_media_type");
      const data = bytes.toString("base64");
      attachments.push(mediaType === "application/pdf" ? { mediaType, data, title: basename(file.path) } : { mediaType, data });
      remaining -= length;
    } finally {
      await file.handle.close();
    }
  }
  return attachments;
}
