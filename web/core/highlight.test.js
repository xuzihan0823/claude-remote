import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlight, normalizeLang } from './highlight.js';

const join = (parts) => parts.map((p) => p.t).join('');
const kinds = (parts, kind) => parts.filter((p) => p.k === kind).map((p) => p.t.trim());

const SAMPLES = {
  ts: 'import { a } from "./x";\n// 注释\nconst n: number = 0x1f + 2.5e3; /* 块 */\nclass Foo extends Bar { run() { return `t${n}`; } }\n',
  py: 'def f(x):\n    """doc\n    string"""\n    return x * 2  # 注释\n@dec\nclass A: pass\nprint(True, None)\n',
  sh: 'export FOO=1 # 设置\npnpm -C packages/daemon test --watch\necho "$HOME" ${PATH} url#hash\n',
  json: '{\n  "a": 1,\n  "b": [true, null, "x"],\n  "c": -2.5e3\n}',
  yaml: '# c\nname: demo\nlist:\n  - "x"\n  - 3\nflag: true # t\n',
  diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx',
  xml: '<!-- c --><div class="a" id=\'b\'>hi</div><br/>',
  css: '.a #b { color: #fff; margin: 1.5rem; } @media x {}',
  rust: 'fn main() { let s = r#"raw"#; let c = \'x\'; println!("{}", s); } #[derive(Debug)]',
  sql: 'SELECT id, name FROM users WHERE age > 18 -- 成年\nORDER BY id;',
  go: 'package main\nfunc main() { s := `raw` ; fmt.Println(s, 42) }',
};

test('各语言拼回与原文逐字一致', () => {
  for (const [lang, code] of Object.entries(SAMPLES)) assert.equal(join(highlight(code, lang)), code, lang);
});

test('任意输入也逐字一致（未闭合字符串、半截注释，模拟流式）', () => {
  for (const [lang, code] of Object.entries(SAMPLES)) {
    for (let i = 0; i <= code.length; i += 3) assert.equal(join(highlight(code.slice(0, i), lang)), code.slice(0, i), `${lang}@${i}`);
  }
});

test('ts 分类', () => {
  const p = highlight(SAMPLES.ts, 'tsx');
  assert.deepEqual(kinds(p, 'comment'), ['// 注释', '/* 块 */']);
  assert.ok(kinds(p, 'keyword').includes('const'));
  assert.ok(kinds(p, 'string').includes('"./x"'));
  assert.ok(kinds(p, 'number').some((t) => t.includes('0x1f')));
  assert.ok(kinds(p, 'type').includes('Foo'));
  assert.ok(kinds(p, 'func').includes('run'));
});

test('py 三引号、装饰器、字面量', () => {
  const p = highlight(SAMPLES.py, 'python');
  assert.ok(kinds(p, 'string').some((t) => t.startsWith('"""doc')));
  assert.ok(kinds(p, 'meta').includes('@dec'));
  assert.ok(kinds(p, 'literal').join(' ').includes('True'));
  assert.ok(kinds(p, 'comment').includes('# 注释'));
});

test('sh：变量、参数；# 只在空白后才是注释', () => {
  const p = highlight(SAMPLES.sh, 'bash');
  assert.ok(kinds(p, 'attr').includes('$HOME') === false, '"$HOME" 在字符串里');
  assert.ok(kinds(p, 'attr').includes('${PATH}'));
  assert.ok(kinds(p, 'meta').includes('-C'));
  assert.deepEqual(kinds(p, 'comment'), ['# 设置']);
});

test('json 键与值', () => {
  const p = highlight(SAMPLES.json, 'json');
  assert.deepEqual(kinds(p, 'attr'), ['"a"', '"b"', '"c"']);
  assert.ok(kinds(p, 'literal').includes('true'));
});

test('diff 增删行', () => {
  const p = highlight(SAMPLES.diff, 'patch');
  assert.ok(kinds(p, 'add').includes('+new'));
  assert.ok(kinds(p, 'del').includes('-old'));
});

test('未知语言 / 空 / 超长', () => {
  assert.deepEqual(highlight('abc', 'brainfuck'), [{ k: 'plain', t: 'abc' }]);
  assert.deepEqual(highlight('', 'js'), []);
  assert.equal(highlight('x'.repeat(70000), 'js').length, 1);
  assert.equal(normalizeLang('TypeScript'), 'ts');
  assert.equal(normalizeLang('js {1,3}'), 'js');
  assert.equal(normalizeLang(''), '');
});
