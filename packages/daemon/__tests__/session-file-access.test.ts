// 文件接口的路径边界：用真实目录和符号链接验证，不 mock 文件系统。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { fileTypeOf, parseRange, resolveRequestedFile } from "../src/session-file-access.js";

let root: string;
let workspace: string;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cr-file-access-")));
  workspace = join(root, "a", "b");
  await mkdir(join(workspace, "sub"), { recursive: true });
  await mkdir(join(workspace, ".git"));
  await mkdir(join(root, "a", "bc"));
  await writeFile(join(workspace, "page.html"), "<h1>ok</h1>");
  await writeFile(join(workspace, "sub", "含 空格.md"), "# hi");
  await writeFile(join(workspace, ".git", "config"), "x");
  await writeFile(join(workspace, ".env.local"), "SECRET=1");
  await writeFile(join(workspace, "server.pem"), "x");
  await writeFile(join(root, "a", "bc", "neighbor.txt"), "x");
  await writeFile(join(root, "outside.txt"), "x");
  await symlink(join(root, "outside.txt"), join(workspace, "out-link.txt"));
  await symlink(join(root, "a", "bc"), join(workspace, "out-dir"));
  await symlink(join(workspace, ".env.local"), join(workspace, "innocent.txt"));
  await symlink(join(workspace, "page.html"), join(workspace, "inner-link.html"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function rejects(cwd: string, path: string | null, code: string): Promise<void> {
  await assert.rejects(resolveRequestedFile(cwd, path), { code }, `${String(path)} 应为 ${code}`);
}

test("相对、绝对和含空格的路径都解析到真实文件", async () => {
  assert.equal((await resolveRequestedFile(workspace, "page.html")).path, join(workspace, "page.html"));
  assert.equal((await resolveRequestedFile(workspace, join(workspace, "page.html"))).path, join(workspace, "page.html"));
  assert.equal((await resolveRequestedFile(workspace, "sub/含 空格.md")).path, join(workspace, "sub", "含 空格.md"));
  assert.equal((await resolveRequestedFile(workspace, "inner-link.html")).path, join(workspace, "page.html"));
});

test("工作目录本身是符号链接时，相对路径照常解析到真实文件", async () => {
  const link = join(root, "cwd-link");
  await symlink(workspace, link);
  assert.equal((await resolveRequestedFile(link, "page.html")).path, join(workspace, "page.html"));
});

test("空路径和含空字符的路径是 invalid_path", async () => {
  await rejects(workspace, null, "invalid_path");
  await rejects(workspace, "", "invalid_path");
  await rejects(workspace, "a\0.txt", "invalid_path");
});

test("工作目录外的文件也能读：../ 跳出、绝对路径、指向目录外的符号链接", async () => {
  const outside = join(root, "outside.txt");
  for (const path of ["../../outside.txt", outside, "out-link.txt"]) {
    assert.equal((await resolveRequestedFile(workspace, path)).path, outside, path);
  }
  assert.equal((await resolveRequestedFile(workspace, "out-dir/neighbor.txt")).path, join(root, "a", "bc", "neighbor.txt"));
});

test("不存在的文件是 file_not_found", async () => {
  await rejects(workspace, join(root, "missing.txt"), "file_not_found");
  await rejects(workspace, "missing.txt", "file_not_found");
  await rejects(join(root, "gone"), "page.html", "file_not_found");
});

test("工作目录缺失时只认绝对路径，相对路径不解析到后台进程目录", async () => {
  assert.equal((await resolveRequestedFile("", join(workspace, "page.html"))).path, join(workspace, "page.html"));
  await rejects("", "page.html", "invalid_path");
});

test("目录、FIFO 等非普通文件不能读", async () => {
  await rejects(workspace, "sub", "file_not_found");
  await rejects(workspace, ".", "file_not_found");
  execFileSync("mkfifo", [join(workspace, "pipe")]);
  await rejects(workspace, "pipe", "file_not_found");
});

test("敏感文件按规则拒绝，含大小写变体、符号链接和 .. 绕路", async () => {
  for (const path of [
    ".env", ".env.local", ".ENV", ".git/config", ".GIT/config", "sub/../.git/config", ".ssh/config",
    "server.pem", "SERVER.PEM", "tls.key", "id_rsa", "id_rsa.pub", ".npmrc", ".netrc", "sub/.env",
  ]) {
    await rejects(workspace, path, "sensitive_file");
  }
  await rejects(workspace, "innocent.txt", "sensitive_file");
});

test("文件名只是包含敏感词时不误伤", async () => {
  await writeFile(join(workspace, "env.txt"), "x");
  await writeFile(join(workspace, "monkey.ts"), "x");
  await writeFile(join(workspace, ".gitignore"), "x");
  await resolveRequestedFile(workspace, "env.txt");
  await resolveRequestedFile(workspace, "monkey.ts");
  await resolveRequestedFile(workspace, ".gitignore");
});

test("工作目录外的敏感文件同样拒绝", async () => {
  const dir = join(root, "sensitive");
  await mkdir(join(dir, ".ssh"), { recursive: true });
  await writeFile(join(dir, ".env"), "x");
  await writeFile(join(dir, ".ssh", "config"), "x");
  await rejects(workspace, join(dir, ".env"), "sensitive_file");
  await rejects(workspace, join(dir, ".ssh", "config"), "sensitive_file");
});

test("previewKind 按扩展名判断，大小写无关，未知类型为 none", () => {
  assert.equal(fileTypeOf("/a/PAGE.HTML").previewKind, "html");
  assert.equal(fileTypeOf("/a/x.png").previewKind, "image");
  assert.equal(fileTypeOf("/a/x.ts").previewKind, "text");
  assert.equal(fileTypeOf("/a/x.md").previewKind, "markdown");
  assert.equal(fileTypeOf("/a/x.pdf").previewKind, "pdf");
  assert.equal(fileTypeOf("/a/x.zip").previewKind, "none");
  assert.equal(fileTypeOf("/a/Makefile").previewKind, "none");
});

test("parseRange：截断、后缀、超范围和无法识别的写法", () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=90-1000", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-1000", 100), { start: 0, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange("bytes=5-2", 100), null);
  assert.equal(parseRange("bytes=0-1,3-4", 100), null);
  assert.equal(parseRange("items=0-1", 100), null);
});
