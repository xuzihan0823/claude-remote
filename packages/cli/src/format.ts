// 终端展示用的小工具：中日韩宽字符宽度、按显示宽度截断/补齐、相对时间、状态图标。

import type { RenderMessage, SessionStatus } from "./api.js";

/** 粗略的东亚宽字符判断（CJK、全角符号、emoji 按 2 列）。 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/** 折叠空白成单行，按显示宽度截断（超出补 …），不足右侧补空格到 width。 */
export function fit(text: string, width: number, pad = true): string {
  if (width <= 0) return "";
  const single = text.replace(/\s+/g, " ").trim();
  let out = "";
  let used = 0;
  const total = displayWidth(single);
  const limit = total > width ? width - 1 : width;
  for (const ch of single) {
    const w = displayWidth(ch);
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  if (total > width) {
    out += "…";
    used += 1;
  }
  return pad ? out + " ".repeat(Math.max(0, width - used)) : out;
}

export function relativeTime(epochMs: number, now = Date.now()): string {
  const diff = Math.max(0, now - epochMs);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function formatUptime(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const STATUS_ICON: Record<SessionStatus, string> = {
  idle: "○",
  "terminal-driving": "◐",
  "daemon-driving": "●",
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "空闲",
  "terminal-driving": "终端在用",
  "daemon-driving": "运行中",
};

export function projectName(cwd: string): string {
  if (cwd === "") return "(未归类)";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** 一条渲染消息的单行/多行文本描述（TUI 与 cr show 共用）。 */
export function describeMessage(message: RenderMessage): { who: string; text: string } {
  const who = message.role === "user" ? "你" : "Claude";
  switch (message.kind) {
    case "text":
      return { who, text: message.text ?? "" };
    case "tool_use": {
      const input = message.toolInput ?? {};
      const hint =
        typeof input.command === "string"
          ? input.command
          : typeof input.file_path === "string"
            ? input.file_path
            : typeof input.pattern === "string"
              ? input.pattern
              : typeof input.description === "string"
                ? input.description
                : "";
      return { who: "工具", text: `${message.toolName ?? "?"}${hint === "" ? "" : `  ${hint}`}` };
    }
    case "tool_result":
      return { who: message.isError === true ? "工具出错" : "工具结果", text: message.text ?? "" };
    case "thinking":
      return { who: "思考", text: message.text ?? "" };
    default:
      return { who: "·", text: message.text ?? "" };
  }
}

/** 审批卡片输入的一行摘要。 */
export function summarizeInput(input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  const json = JSON.stringify(input);
  return json === undefined ? "" : json;
}
