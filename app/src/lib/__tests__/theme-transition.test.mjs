import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createThemeTransition,
  interpolatePalette,
  mixParsedColor,
  parseColor,
} from '../theme-transition.js';

const LIGHT = {
  bg: '#FAF9F6',
  sheet: '#FAF9F6',
  card: '#FFFFFF',
  ink: '#3A3630',
  glassTint: 'rgba(255, 253, 249, 0.54)',
  glassPressed: 'rgba(58, 54, 48, 0.08)',
  syntax: {
    keyword: '#B0452A',
    string: '#4E7A36',
  },
};

const DARK = {
  bg: '#141414',
  sheet: '#1C1C1C',
  card: '#282828',
  ink: '#E8E7E2',
  glassTint: 'rgba(38, 37, 35, 0.58)',
  glassPressed: 'rgba(255, 255, 255, 0.10)',
  syntax: {
    keyword: '#E8916F',
    string: '#A8C98A',
  },
};

function makeHarness({ initialDark = false, duration = 280, reduceMotion = false } = {}) {
  let clock = 1000;
  let nextId = 1;
  const queue = new Map();
  const snapshots = [];

  const transition = createThemeTransition({
    lightPalette: LIGHT,
    darkPalette: DARK,
    initialDark,
    duration,
    now: () => clock,
    raf: (cb) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    caf: (id) => {
      queue.delete(id);
    },
    isReduceMotion: () => reduceMotion,
  });

  transition.subscribe((snap) => snapshots.push(snap));

  const stepFrame = (dt = 16) => {
    clock += dt;
    const entries = [...queue.entries()];
    queue.clear();
    for (const [, cb] of entries) cb(clock);
  };

  return { transition, snapshots, queue, stepFrame };
}

test('parseColor and mixParsedColor interpolate hex and premultiplied rgba smoothly', () => {
  const fromHex = parseColor('#ffffff');
  const toHex = parseColor('#000000');
  assert.equal(mixParsedColor(fromHex, toHex, 0), '#ffffff');
  assert.equal(mixParsedColor(fromHex, toHex, 0.5), '#808080');
  assert.equal(mixParsedColor(fromHex, toHex, 1), '#000000');

  const fromRgba = parseColor('rgba(255, 253, 249, 0.54)');
  const toRgba = parseColor('rgba(38, 37, 35, 0.58)');
  const mid = parseColor(mixParsedColor(fromRgba, toRgba, 0.5));
  assert.ok(mid && !mid.hex);
  assert.ok(mid.r > 38 && mid.r < 255);
  assert.equal(mid.a, 0.56);
});

test('interpolatePalette preserves object identity at endpoints and interpolates nested tokens', () => {
  assert.equal(interpolatePalette(LIGHT, DARK, 0), LIGHT);
  assert.equal(interpolatePalette(LIGHT, DARK, 1), DARK);
  const mid = interpolatePalette(LIGHT, DARK, 0.5);
  assert.notEqual(mid.bg, LIGHT.bg);
  assert.notEqual(mid.bg, DARK.bg);
  assert.notEqual(mid.syntax.keyword, LIGHT.syntax.keyword);
  assert.notEqual(mid.syntax.keyword, DARK.syntax.keyword);
});

test('light -> dark -> light transitions smoothly across frames and settles on exact palette', () => {
  const h = makeHarness({ initialDark: false, duration: 200 });
  assert.equal(h.transition.getSnapshot().colors, LIGHT);

  h.transition.setDark(true);
  assert.equal(h.transition.getSnapshot().dark, true);
  assert.equal(h.queue.size, 1);

  h.stepFrame(50);
  const midToDark = h.transition.getSnapshot();
  assert.ok(midToDark.progress > 0 && midToDark.progress < 1);
  assert.notEqual(midToDark.colors.bg, LIGHT.bg);
  assert.notEqual(midToDark.colors.bg, DARK.bg);

  while (h.queue.size > 0) h.stepFrame(50);
  const settledDark = h.transition.getSnapshot();
  assert.equal(settledDark.dark, true);
  assert.equal(settledDark.progress, 1);
  assert.equal(settledDark.colors, DARK);

  // Switch back dark -> light
  h.transition.setDark(false);
  h.stepFrame(50);
  const midToLight = h.transition.getSnapshot();
  assert.ok(midToLight.progress > 0 && midToLight.progress < 1);

  while (h.queue.size > 0) h.stepFrame(50);
  const settledLight = h.transition.getSnapshot();
  assert.equal(settledLight.dark, false);
  assert.equal(settledLight.progress, 0);
  assert.equal(settledLight.colors, LIGHT);
});

test('reversing mid-transition continues smoothly from the current progress without jumping', () => {
  const h = makeHarness({ initialDark: false, duration: 240 });
  h.transition.setDark(true);
  h.stepFrame(80);
  const beforeReverse = h.transition.getSnapshot().progress;
  assert.ok(beforeReverse > 0.2 && beforeReverse < 0.9);

  // Reverse back to light mid-flight
  h.transition.setDark(false);
  assert.equal(h.transition.getSnapshot().progress, beforeReverse, 'must not jump when reversing');

  h.stepFrame(30);
  const afterFirstReverseFrame = h.transition.getSnapshot().progress;
  assert.ok(afterFirstReverseFrame < beforeReverse && afterFirstReverseFrame > 0);

  while (h.queue.size > 0) h.stepFrame(40);
  assert.equal(h.transition.getSnapshot().progress, 0);
  assert.equal(h.transition.getSnapshot().colors, LIGHT);
});

test('reduceMotion or animate: false switches immediately without scheduling frames', () => {
  const reduced = makeHarness({ initialDark: false, reduceMotion: true });
  reduced.transition.setDark(true);
  assert.equal(reduced.queue.size, 0);
  assert.equal(reduced.transition.getSnapshot().colors, DARK);

  const manual = makeHarness({ initialDark: true, reduceMotion: false });
  manual.transition.setDark(false, { animate: false });
  assert.equal(manual.queue.size, 0);
  assert.equal(manual.transition.getSnapshot().colors, LIGHT);
});
