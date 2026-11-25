import type { TranscriptMediaDescriptor } from "./types.js";

const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DOCUMENT_TYPES = new Set(["application/pdf", "text/plain", "text/markdown"]);
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Length(data: string): number | undefined {
  if (data.length % 4 !== 0) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const end = data.length - padding;
  // Search once for an invalid character. Repeated regex groups can overflow on large attachments.
  const firstInvalid = data.search(/[^A-Za-z0-9+/]/);
  if (firstInvalid !== (padding ? end : -1)) return undefined;
  if (padding && (BASE64.indexOf(data.charAt(end - 1)) & (padding === 2 ? 15 : 3)) !== 0) return undefined;
  return data.length / 4 * 3 - padding;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\\x00-\x1f\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password) return value;
  } catch { /* malformed URL */ }
  return undefined;
}

interface InspectedMedia {
  descriptor: TranscriptMediaDescriptor;
  decode?: () => Buffer;
}

export function inspectMedia(block: unknown): InspectedMedia {
  const type = record(block) ? block.type : undefined;
  const category = type === "image" || type === "document" ? type : "unsupported";
  const descriptor: TranscriptMediaDescriptor = { category, status: "unsupported" };
  if (!record(block) || category === "unsupported") return { descriptor };
  if (typeof block.title === "string" && block.title) descriptor.title = block.title.slice(0, 256);
  const source = block.source;
  if (source == null) return { descriptor: { ...descriptor, status: "missing" } };
  if (!record(source)) return { descriptor };
  const kind = source.type;
  if (kind !== "base64" && kind !== "url" && kind !== "text" && kind !== "content") return { descriptor };
  descriptor.sourceType = kind;
  const mime = source.media_type;
  if (mime !== undefined) {
    const allowed = category === "image" ? IMAGE_TYPES : DOCUMENT_TYPES;
    if (typeof mime !== "string" || !allowed.has(mime)) return { descriptor };
    descriptor.mediaType = mime;
  }
  if (kind === "url") {
    if (source.url == null || source.url === "") return { descriptor: { ...descriptor, status: "missing" } };
    const url = safeUrl(source.url);
    return url ? { descriptor: { ...descriptor, status: "missing", url } } : { descriptor };
  }
  let data = kind === "content" ? source.content : source.data;
  let encoding: BufferEncoding = "base64";
  if (kind !== "base64") {
    if (category !== "document" || mime === "application/pdf") return { descriptor };
    descriptor.mediaType ??= "text/plain";
    encoding = "utf8";
    if (kind === "content" && Array.isArray(data)) {
      const texts: string[] = [];
      for (const part of data) {
        if (!record(part) || part.type !== "text" || typeof part.text !== "string") return { descriptor };
        texts.push(part.text);
      }
      data = texts.join("");
    }
  }
  if (data == null || data === "") return { descriptor: { ...descriptor, status: "missing" } };
  if (typeof data !== "string" || descriptor.mediaType === undefined) return { descriptor };
  const payload = data;
  const byteLength = encoding === "base64" ? base64Length(payload) : Buffer.byteLength(payload);
  if (byteLength === undefined) return { descriptor };
  descriptor.byteLength = byteLength;
  if (byteLength > MAX_BYTES) return { descriptor: { ...descriptor, status: "too_large" } };
  return { descriptor: { ...descriptor, status: "available" }, decode: () => Buffer.from(payload, encoding) };
}
