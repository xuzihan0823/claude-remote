// 设置页的 navigate('X') 必须都在 SettingsNavigator 里注册过：RN 运行时才报错，这里静态兜底。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = new URL('../../screens/settings/', import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const nav = readFileSync(join(dir, 'SettingsNavigator.js'), 'utf8');
const registered = new Set([...nav.matchAll(/<Stack\.Screen name="(\w+)"/g)].map((m) => m[1]));

test('设置页 navigate 的目标都已注册', () => {
  assert.ok(registered.has('SettingsHome'));
  const missing = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/navigate\('(\w+)'/g)) if (!registered.has(m[1])) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('注册的每个页面组件都有对应文件并导出', () => {
  for (const m of nav.matchAll(/import \{ (\w+) \} from '\.\/(\w+)\.js'/g)) {
    const [, name, file] = m;
    if (file === 'ui') continue;
    const src = readFileSync(join(dir, `${file}.js`), 'utf8');
    assert.match(src, new RegExp(`export function ${name}\\b`), `${file}.js 应导出 ${name}`);
  }
});

test('Settings 以 modal sheet 方式挂在主 stack 上', () => {
  const app = readFileSync(new URL('../../App.js', import.meta.url), 'utf8');
  assert.match(app, /name="Settings" component=\{SettingsNavigator\} options=\{\{ presentation: 'modal' \}\}/);
});
