// 演示脚本：只读列出真实 ~/.claude/projects 里最近 10 个会话，
// 供人工与 `claude --resume` 选择器比对（02 卡验收项）。
//
//   tsx packages/daemon/scripts/demo-list.ts [projectsDir]

import { homedir } from "node:os";
import { join } from "node:path";

import { listSessions } from "../src/transcript/indexer.js";

function relativeTime(epochMs: number): string {
  const deltaSeconds = Math.round((Date.now() - epochMs) / 1000);
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86400)}d ago`;
}

const projectsDir = process.argv[2] ?? join(homedir(), ".claude", "projects");
const sessions = await listSessions(projectsDir);

console.log(`projects dir: ${projectsDir}`);
console.log(`total sessions: ${sessions.length}; showing latest 10\n`);
for (const session of sessions.slice(0, 10)) {
  console.log(`· ${session.title}`);
  console.log(
    `  ${relativeTime(session.lastActiveAt)} | ${session.cwd || "(无 cwd)"} | ` +
      `${(session.sizeBytes / 1024).toFixed(1)}KB | ${session.sessionId.slice(0, 8)}`,
  );
  if (session.lastPreview !== "") console.log(`  ↳ ${session.lastPreview}`);
  console.log();
}
