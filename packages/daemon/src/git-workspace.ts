import { execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isSensitivePath } from "./session-file-access.js";

const MAX_DIFF_BYTES = 128 * 1024;
const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_PATHSPEC_BYTES = 64 * 1024;
const NOT_A_REPO = { isGitRepo: false } as const;

interface ChangedFile {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export type GitWorkspace = typeof NOT_A_REPO | {
  isGitRepo: true;
  branch: string;
  dirty: boolean;
  files: ChangedFile[];
  diff: string;
  truncated: boolean;
};

interface GitResult {
  output: Buffer;
  state: "ok" | "limit" | "not_repo" | "no_match" | "failed";
}

function git(cwd: string, args: string[], signal: AbortSignal, maxBuffer = MAX_STATUS_BYTES): Promise<GitResult> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  });
  return new Promise((resolve) => {
    const child = execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd, env, signal, killSignal: "SIGKILL", encoding: "buffer", maxBuffer,
    }, (error, stdout, stderr) => {
      if (!error) resolve({ output: stdout, state: "ok" });
      else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve({ output: stdout, state: "limit" });
      else if (error.code === 128 && /not a git repository/i.test(stderr.toString("utf8"))) resolve({ output: stdout, state: "not_repo" });
      else if (error.code === 1 && stderr.length === 0) resolve({ output: stdout, state: "no_match" });
      else resolve({ output: stdout, state: "failed" });
    });
    child.stdin?.end();
  });
}

export async function readGitWorkspace(cwd: string, clientSignal: AbortSignal): Promise<GitWorkspace | undefined> {
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(3_000)]);
  const location = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
  if (location.state === "not_repo") return NOT_A_REPO;
  if (location.state !== "ok") return undefined;
  const root = location.output.toString("utf8").replace(/\n$/, "");
  if (!root) return undefined;

  const [name, commit, config] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
    git(root, ["rev-parse", "--verify", "HEAD"], signal),
    git(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."], signal),
  ]);
  if (signal.aborted) return undefined;
  const branch = name.state === "ok" ? name.output.toString("utf8").trimEnd()
    : commit.state === "ok" ? commit.output.toString("ascii").trim().slice(0, 7) : undefined;
  if (!branch || (config.state !== "ok" && config.state !== "no_match")) return undefined;

  // Diff/status can apply a repository's clean filter to a worktree file.
  // Disable each configured filter before reading file contents.
  const filters = new Set(config.output.toString("utf8").split("\0")
    .map((key) => /^filter\.(.+)\.(?:clean|process|smudge|required)$/.exec(key)?.[1])
    .filter((name): name is string => name !== undefined));
  const flags = [...filters].flatMap((filter) => [
    "-c", `filter.${filter}.clean=`, "-c", `filter.${filter}.process=`,
    "-c", `filter.${filter}.smudge=`, "-c", `filter.${filter}.required=false`,
  ]);
  const status = await git(root, [...flags, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all",
    "--ignore-submodules=dirty"], signal);
  if (status.state !== "ok") return undefined;
  const files: ChangedFile[] = status.output.toString("utf8").split("\0").flatMap((line) => {
    if (line.length < 4) return [];
    const path = line.slice(3);
    const status = line.slice(0, 2);
    return isSensitivePath(path) ? [] : [{ path, status }];
  });
  const paths: string[] = [];
  let pathBytes = 0;
  let truncated = false;
  for (const file of files) {
    if (file.status === "??") continue;
    const path = `:(top,literal)${file.path}`;
    pathBytes += Buffer.byteLength(path) + 1;
    if (pathBytes > MAX_PATHSPEC_BYTES) { truncated = true; break; }
    paths.push(path);
  }
  const base = { isGitRepo: true as const, branch, dirty: status.output.length > 0, files };
  if (paths.length === 0) return { ...base, diff: "", truncated };

  const head = commit.state === "ok" ? commit.output.toString("ascii").trim()
    : await git(root, ["hash-object", "-t", "tree", "--stdin"], signal).then((result) =>
      result.state === "ok" ? result.output.toString("ascii").trim() : "");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) return undefined;
  const diffFlags = [...flags, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--submodule=short"];
  const [patch, stats] = await Promise.all([
    git(root, [...diffFlags, "--patch", head, "--", ...paths], signal, MAX_DIFF_BYTES),
    git(root, [...diffFlags, "--numstat", "-z", head, "--", ...paths], signal),
  ]);
  if (patch.state !== "ok" && patch.state !== "limit") return undefined;
  if (stats.state === "ok") {
    const byPath = new Map(files.map((file) => [file.path, file]));
    for (const line of stats.output.toString("utf8").split("\0")) {
      const parsed = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(line);
      const file = parsed?.[3] === undefined ? undefined : byPath.get(parsed[3]);
      if (parsed && file) {
        file.additions = Number(parsed[1]);
        file.deletions = Number(parsed[2]);
      }
    }
  }
  return { ...base, diff: new StringDecoder("utf8").write(patch.output.subarray(0, MAX_DIFF_BYTES)),
    truncated: truncated || patch.state === "limit" || patch.output.length > MAX_DIFF_BYTES };
}
