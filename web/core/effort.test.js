import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

const originalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};

const { saveConn } = await import('./api.js');
const { upsertDevice, setCurrentDevice } = await import('./devices.js');
const {
  EFFORT_LEVELS,
  buildCapabilitiesPath,
  clearSessionEffort,
  createCapabilitiesLoader,
  effortLabel,
  effortSelection,
  getSessionEffort,
  isValidEffortLevel,
  modelEffortTriggerLabel,
  normalizeCapabilities,
  setSessionEffort,
  syncSessionEffortRevision,
} = await import('./effort.js');

beforeEach(() => {
  values.clear();
  saveConn('http://mac-a.local:8788', 'tok-a');
});

after(() => {
  globalThis.localStorage = originalStorage;
  globalThis.fetch = originalFetch;
});

test('effort levels and labels cover default and five standard levels', () => {
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(effortLabel(''), '跟随默认');
  assert.equal(effortLabel('low'), '低');
  assert.equal(effortLabel('medium'), '中');
  assert.equal(effortLabel('high'), '高');
  assert.equal(effortLabel('xhigh'), '超高');
  assert.equal(effortLabel('max'), '最大');
  assert.equal(isValidEffortLevel('xhigh'), true);
  assert.equal(isValidEffortLevel(''), false);
  assert.equal(isValidEffortLevel('ultra'), false);
});

test('buildCapabilitiesPath omits model when empty and includes cwd/sessionId and refresh=1', () => {
  assert.equal(
    buildCapabilitiesPath({ cwd: '/work/repo', model: '' }),
    '/api/model-capabilities?cwd=%2Fwork%2Frepo',
  );
  assert.equal(
    buildCapabilitiesPath({ cwd: '/work/repo', model: 'opus', refresh: true }),
    '/api/model-capabilities?cwd=%2Fwork%2Frepo&model=opus&refresh=1',
  );
  assert.equal(
    buildCapabilitiesPath({ sessionId: 'sess-1', model: 'provider/m1' }),
    '/api/model-capabilities?sessionId=sess-1&model=provider%2Fm1',
  );
});

test('normalizeCapabilities preserves opaque revision, canonical level order, and thinkingEnabled', () => {
  const caps = normalizeCapabilities({
    status: 'known',
    effortLevels: ['max', 'low', 'invalid', 'high'],
    source: 'magpie',
    revision: 'opaque:rev/v1#abc',
    thinkingEnabled: true,
  });
  assert.deepEqual(caps.effortLevels, ['low', 'high', 'max']);
  assert.equal(caps.revision, 'opaque:rev/v1#abc');
  assert.equal(caps.source, 'magpie');
  assert.equal(caps.thinkingEnabled, true);
  assert.equal(caps.loaded, true);

  const disabled = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'high'],
    revision: 'rev-2',
    thinkingEnabled: false,
  });
  assert.equal(disabled.thinkingEnabled, false);

  const unsupported = normalizeCapabilities({
    status: 'unsupported',
    effortLevels: ['low'],
    revision: 'rev-3',
  });
  assert.deepEqual(unsupported.effortLevels, []);
});

test('effortSelection validates known, unknown manual 5 levels, unsupported, and thinkingEnabled=false', () => {
  const known = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium', 'high'],
    revision: 'r1',
    thinkingEnabled: true,
  });

  // Default '' is always allowed and omits effort field
  const def = effortSelection(known, '');
  assert.equal(def.status, 'default');
  assert.equal(def.canSend, true);
  assert.equal(def.sendEffort, undefined);

  // Supported level
  const ok = effortSelection(known, { effort: 'high', revision: 'r1' });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.canSend, true);
  assert.equal(ok.sendEffort, 'high');

  // Unsupported level on a known model blocks send and never silently downgrades
  const badLevel = effortSelection(known, { effort: 'max', revision: 'r1' });
  assert.equal(badLevel.status, 'unavailable');
  assert.equal(badLevel.canSend, false);
  assert.equal(badLevel.effort, 'max');
  assert.equal(badLevel.sendEffort, undefined);

  // Unknown capability status allows all 5 manual levels
  const unknown = normalizeCapabilities({
    status: 'unknown',
    effortLevels: [],
    revision: 'r1',
    thinkingEnabled: true,
  });
  for (const level of EFFORT_LEVELS) {
    const manual = effortSelection(unknown, { effort: level, revision: 'r1' });
    assert.equal(manual.status, 'manual');
    assert.equal(manual.canSend, true);
    assert.equal(manual.sendEffort, level);
  }

  // Unsupported model blocks non-empty effort but allows default ''
  const unsupported = normalizeCapabilities({
    status: 'unsupported',
    effortLevels: [],
    revision: 'r1',
    thinkingEnabled: true,
  });
  assert.equal(effortSelection(unsupported, { effort: 'low', revision: 'r1' }).canSend, false);
  assert.equal(effortSelection(unsupported, { effort: 'low', revision: 'r1' }).status, 'unavailable');
  assert.equal(effortSelection(unsupported, '').canSend, true);

  // thinkingEnabled === false blocks non-empty effort even when status is unknown or known
  const noThinking = normalizeCapabilities({
    status: 'unknown',
    effortLevels: [],
    revision: 'r1',
    thinkingEnabled: false,
  });
  const blockedThinking = effortSelection(noThinking, { effort: 'medium', revision: 'r1' });
  assert.equal(blockedThinking.status, 'thinking_disabled');
  assert.equal(blockedThinking.canSend, false);
  assert.equal(effortSelection(noThinking, '').canSend, true);
});

test('session effort memory associates with device and opaque revision, marking config/device changes as stale', () => {
  const devA = upsertDevice({ bases: ['http://mac-a.local:8788'], base: 'http://mac-a.local:8788', token: 'tok-a', name: 'Mac A' });
  const devB = upsertDevice({ bases: ['http://mac-b.local:8788'], base: 'http://mac-b.local:8788', token: 'tok-b', name: 'Mac B' });
  setCurrentDevice(devA.id);
  saveConn('http://mac-a.local:8788', 'tok-a');

  setSessionEffort('s-1', { effort: 'xhigh', model: 'opus', revision: 'rev-initial-opaque' });
  setSessionEffort('s-2', { effort: 'low', model: 'sonnet', revision: 'rev-s2' });

  // Switching between sessions preserves each session's effort
  const s1 = getSessionEffort('s-1');
  assert.equal(s1.effort, 'xhigh');
  assert.equal(s1.model, 'opus');
  assert.equal(s1.revision, 'rev-initial-opaque');
  assert.equal(s1.stale, false);
  assert.equal(getSessionEffort('s-2').effort, 'low');

  // Matching revision is valid
  const capsSame = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    revision: 'rev-initial-opaque',
  });
  assert.equal(effortSelection(capsSame, s1).status, 'ok');
  assert.equal(effortSelection(capsSame, s1).canSend, true);

  // Opaque revision change marks selection stale and blocks send
  const capsChanged = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    revision: 'rev-after-settings-edit',
  });
  const staleByRev = effortSelection(capsChanged, s1);
  assert.equal(staleByRev.status, 'stale');
  assert.equal(staleByRev.reason, 'revision_changed');
  assert.equal(staleByRev.canSend, false);
  assert.equal(
    modelEffortTriggerLabel({ models: [], loaded: true }, 'opus', capsChanged, s1),
    'opus · 超高（需重选）',
  );

  // Switching device marks previously saved effort for that session as stale
  setCurrentDevice(devB.id);
  saveConn('http://mac-b.local:8788', 'tok-b');
  const s1OnDevB = getSessionEffort('s-1');
  assert.equal(s1OnDevB.effort, 'xhigh');
  assert.equal(s1OnDevB.stale, true);
  assert.equal(s1OnDevB.staleReason, 'device_changed');
  const staleByDev = effortSelection(capsSame, s1OnDevB);
  assert.equal(staleByDev.status, 'stale');
  assert.equal(staleByDev.reason, 'device_changed');
  assert.equal(staleByDev.canSend, false);

  // Clearing effort restores default and unblocks send
  clearSessionEffort('s-1');
  assert.equal(getSessionEffort('s-1').effort, '');
  assert.equal(effortSelection(capsChanged, getSessionEffort('s-1')).canSend, true);
});

test('syncSessionEffortRevision binds initial revision once loaded and detects later revision drift', () => {
  setSessionEffort('s-fast', { effort: 'high', model: 'opus', revision: '' });
  const firstCaps = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium', 'high'],
    revision: 'bound-rev-1',
  });
  const synced = syncSessionEffortRevision('s-fast', firstCaps, { model: 'opus' });
  assert.equal(synced.revision, 'bound-rev-1');

  const driftedCaps = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium', 'high'],
    revision: 'bound-rev-2',
  });
  const afterDrift = syncSessionEffortRevision('s-fast', driftedCaps, { model: 'opus' });
  assert.equal(afterDrift.revision, 'bound-rev-1');
  assert.equal(effortSelection(driftedCaps, afterDrift).status, 'stale');
});

test('createCapabilitiesLoader discards stale responses across model, cwd/session, and connection changes', async () => {
  const pending = [];
  let conn = { baseUrl: 'http://mac-a:8788', token: 'tok-1' };
  let devKey = 'dev-a';
  const loader = createCapabilitiesLoader({
    apiImpl: (path) => new Promise((resolve, reject) => {
      pending.push({ path, resolve, reject });
    }),
    getConn: () => conn,
    getDeviceKey: () => devKey,
  });

  // 1. Model change supersedes in-flight request
  const pOpus = loader.load({ sessionId: 's1', model: 'opus' });
  const pHaiku = loader.load({ sessionId: 's1', model: 'haiku' });
  assert.equal(pending.length, 2);
  pending[0].resolve({ status: 'known', effortLevels: ['low', 'high', 'max'], revision: 'r-opus' });
  assert.equal(await pOpus, null);
  assert.equal(loader.getState().loaded, false);

  pending[1].resolve({ status: 'unsupported', effortLevels: [], revision: 'r-haiku' });
  const haikuState = await pHaiku;
  assert.equal(haikuState.status, 'unsupported');
  assert.equal(loader.getState().revision, 'r-haiku');

  // 2. Connection/device change invalidates in-flight request
  const pBeforeSwitch = loader.load({ cwd: '/repo/a', model: 'sonnet' });
  conn = { baseUrl: 'http://mac-b:8788', token: 'tok-2' };
  devKey = 'dev-b';
  pending[2].resolve({ status: 'known', effortLevels: ['low'], revision: 'r-old-conn' });
  assert.equal(await pBeforeSwitch, null);
  assert.equal(loader.getState().loaded, false);
});
