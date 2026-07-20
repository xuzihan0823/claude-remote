// One-shot maintenance script: make SDK-spawned Claude sessions visible in the
// Mac terminal's `claude /resume` list again.
//
// Background:
//   The claude-remote daemon starts Claude sessions via @anthropic-ai/claude-agent-sdk.
//   The CLI subprocess records its entrypoint as `"sdk-cli"` in the JSONL session
//   transcript, and the Mac terminal's `claude` binary hides any session whose
//   entrypoint ∈ {sdk-cli, sdk-ts, sdk-py} from `/resume`.
//
// Fix going forward:
//   sdk-bridge.ts now sets CLAUDE_CODE_ENTRYPOINT=claude-remote via SDK options.env,
//   which the CLI preserves verbatim (it only rewrites "cli"/"local_agent").
//
// Fix for history (this script):
//   Rewrite every occurrence of the byte string `"entrypoint":"sdk-cli"` to
//   `"entrypoint":"cli-sdk"` inside ~/.claude/projects/**/*.jsonl.
//
//   This is an equal-length byte rewrite ("sdk-cli" and "cli-sdk" are both 7 chars),
//   so the file size is unchanged and the daemon's file-watcher sees no length
//   delta. The new value is not in the CLI's hide-set, so historical sessions
//   become resumable.
//
// Safety:
//   - Default mode is DRY RUN: prints counts only, writes nothing.
//   - Pass --apply to actually rewrite files in place.
//   - Files larger than 100MB are skipped with a warning (avoid pathological reads).
//   - Files modified within the last 15 minutes are skipped in --apply mode:
//     a session being actively appended to could lose lines in the read->write
//     window (writeFile truncates). Re-run later for those.
//   - Before writing, we assert Buffer.byteLength(newContent) === Buffer.byteLength(oldContent).
//     If they differ (shouldn't, but defensive), the file is skipped with a warning.
//
// Usage:
//   node scripts/unhide-sdk-sessions.mjs            # dry run
//   node scripts/unhide-sdk-sessions.mjs --apply    # rewrite in place

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const NEEDLE = Buffer.from(`"entrypoint":"sdk-cli"`, "utf8");
const REPLACEMENT = `"entrypoint":"cli-sdk"`;
const MAX_BYTES = 100 * 1024 * 1024; // 100MB
const RECENT_MS = 15 * 60 * 1000; // skip files modified within 15 min in --apply mode

const apply = process.argv.includes("--apply");

async function listJsonlFiles() {
  const out = [];
  let top;
  try {
    top = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch (err) {
    console.error(`error reading ${PROJECTS_DIR}: ${err.message}`);
    return out;
  }
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    const subDir = join(PROJECTS_DIR, entry.name);
    let entries;
    try {
      entries = await readdir(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.isFile() && f.name.endsWith(".jsonl")) {
        out.push(join(subDir, f.name));
      }
    }
  }
  return out;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

async function main() {
  const files = await listJsonlFiles();
  if (files.length === 0) {
    console.log(`no .jsonl files under ${PROJECTS_DIR}`);
    return;
  }
  console.log(`mode: ${apply ? "APPLY (rewrite in place)" : "DRY RUN (no writes)"}`);
  console.log(`scanning ${files.length} file(s) under ${PROJECTS_DIR}`);
  console.log("---");

  let totalHits = 0;
  let touched = 0;
  let skipped = 0;

  for (const path of files) {
    let st;
    try {
      st = await stat(path);
    } catch (err) {
      console.log(`${path}: stat failed: ${err.message}`);
      skipped++;
      continue;
    }
    if (st.size > MAX_BYTES) {
      console.log(`${path}: SKIP (${st.size} bytes > ${MAX_BYTES} limit)`);
      skipped++;
      continue;
    }

    let buf;
    try {
      buf = await readFile(path);
    } catch (err) {
      console.log(`${path}: read failed: ${err.message}`);
      skipped++;
      continue;
    }

    const hits = countOccurrences(buf, NEEDLE);
    if (hits === 0) {
      continue;
    }

    console.log(`${path}: ${hits} 处`);
    totalHits += hits;

    if (!apply) {
      continue;
    }

    if (Date.now() - st.mtimeMs < RECENT_MS) {
      console.log(`  SKIP: modified within last 15 min (likely being written; re-run later)`);
      skipped++;
      continue;
    }

    const newContent = buf.toString("utf8").split(NEEDLE.toString("utf8")).join(REPLACEMENT);
    const newBuf = Buffer.from(newContent, "utf8");
    if (newBuf.byteLength !== buf.byteLength) {
      console.log(`  WARNING: byte length changed (${buf.byteLength} -> ${newBuf.byteLength}), skipping ${path}`);
      skipped++;
      continue;
    }
    try {
      await writeFile(path, newBuf);
      touched++;
    } catch (err) {
      console.log(`  WARNING: write failed: ${err.message}`);
      skipped++;
    }
  }

  console.log("---");
  console.log(`total occurrences: ${totalHits}`);
  if (apply) {
    console.log(`files rewritten: ${touched}`);
    console.log(`files skipped: ${skipped}`);
  } else {
    console.log("(dry run; pass --apply to rewrite in place)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
