import assert from "node:assert/strict";
import { test } from "node:test";

import { displayWidth, fit, projectName, relativeTime } from "../src/format.js";

test("displayWidth：中文/emoji 占 2 列", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("重连"), 4);
  assert.equal(displayWidth("a重b"), 4);
});

test("fit：按显示宽度截断补齐，不切半个宽字符", () => {
  assert.equal(fit("abc", 5), "abc  ");
  assert.equal(fit("修复连接检测", 7), "修复连…");
  assert.equal(displayWidth(fit("修复连接检测", 8)), 8);
  assert.equal(fit("a\n  b", 10, false), "a b");
});

test("relativeTime / projectName", () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeTime(now - 10_000, now), "刚刚");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5 分钟前");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3 小时前");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 天前");
  assert.equal(projectName("/Users/mac/code/claude-remote"), "claude-remote");
  assert.equal(projectName(""), "(未归类)");
});
