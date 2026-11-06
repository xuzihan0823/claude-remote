import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectSystemLocale, getLocale, resolveLocale, setLocale, t } from './i18n.js';
import { en as enComponents } from './locales/en/components.js';
import { en as enComposer } from './locales/en/composer.js';
import { en as enCore } from './locales/en/core.js';
import { en as enChat } from './locales/en/chat.js';
import { en as enHome } from './locales/en/home.js';
import { en as enMisc } from './locales/en/misc.js';
import { en as enSettings } from './locales/en/settings.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const EN = { ...enComponents, ...enComposer, ...enCore, ...enChat, ...enHome, ...enMisc, ...enSettings };
const HAN = /[\u4e00-\u9fff]/;

test('默认中文，未知词条与缺词条原样返回', () => {
  setLocale('zh');
  assert.equal(getLocale(), 'zh');
  assert.equal(t('设置'), '设置');
  setLocale('en');
  assert.equal(t('这不是一个真实词条'), '这不是一个真实词条');
  assert.equal(t('设置'), 'Settings');
});

test('参数插值：命中的英文和回退的中文都替换占位符', () => {
  setLocale('zh');
  assert.equal(t('{n} 个对话', { n: 3 }), '3 个对话');
  setLocale('en');
  assert.equal(t('{n} 个对话', { n: 3 }), '3 conversations');
  assert.equal(t('缺词 {x}', { x: 7 }), '缺词 7');
});

test('resolveLocale：显式选中文/英文，system 走系统语言', () => {
  assert.equal(resolveLocale('zh'), 'zh');
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('system'), detectSystemLocale());
});

test('setLocale 只接受已知语言，非法值回落中文', () => {
  setLocale('en');
  setLocale('ja');
  assert.equal(getLocale(), 'zh');
});

// 完整性扫描：所有 t('中文…') 的静态词条都必须出现在英文词典里，
// 避免切到英文后出现中文残留。注释、词典文件本身和测试文件不扫。
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('t() 的静态中文词条都有英文翻译', () => {
  const files = [
    ...walk(join(REPO, 'web', 'core')),
    ...walk(join(REPO, 'app', 'src')),
  ].filter((p) => !p.includes(`${sep}locales${sep}`) && !p.endsWith('i18n.js') && !p.endsWith('.test.js'));
  const missing = [];
  const re = /(?:^|[^A-Za-z0-9_$.])t\(\s*(['"])([^'"]*)\1/g;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      for (const m of line.matchAll(re)) {
        const key = m[2];
        if (!HAN.test(key) || key in EN) continue;
        missing.push(`${file.replace(`${REPO}${sep}`, '')}:${i + 1} ${key}`);
      }
    });
  }
  assert.deepEqual(missing, []);
});
