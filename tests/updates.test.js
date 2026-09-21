'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const helpers = require('./helpers');

const dir = helpers.freshUserData('updates');
const paths = require('../src/paths');
const state = require('../src/state');
const updates = require('../src/updates');
const { isNewer, parseVersion, fetchLatest, createUpdater, RELEASES_URL, DOWNLOAD_PAGE } = updates;

after(() => helpers.cleanup(dir));

describe('isNewer', () => {
  test('numeric semver compare', () => {
    assert.equal(isNewer('1.1.0', '1.0.0'), true);
    assert.equal(isNewer('1.0.0', '1.0.0'), false);
    assert.equal(isNewer('1.0.10', '1.0.9'), true);
    assert.equal(isNewer('1.0.9', '1.0.10'), false);
    assert.equal(isNewer('2.0.0', '1.9.9'), true);
    assert.equal(isNewer('1.0.0', '1.0.1'), false);
  });

  test('tolerates a v prefix and pre-release suffixes', () => {
    assert.equal(isNewer('v1.0.1', '1.0.0'), true);
    assert.equal(isNewer('1.0.1', 'v1.0.0'), true);
    assert.equal(isNewer('1.0.1-beta.1', '1.0.0'), true);
  });

  test('unparseable versions are never newer', () => {
    assert.equal(isNewer('garbage', '1.0.0'), false);
    assert.equal(isNewer('1.0.0', 'garbage'), false);
    assert.equal(isNewer('', ''), false);
    assert.equal(isNewer(null, undefined), false);
    assert.equal(isNewer('1.0', '0.9.9'), false, 'two-part versions do not parse');
  });

  test('parseVersion', () => {
    assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseVersion(' 1.2.3 '), [1, 2, 3]);
    assert.equal(parseVersion('1.2'), null);
  });
});

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  fn.calls = calls;
  return fn;
}
const okJson = body => async () => ({ ok: true, json: async () => body });

describe('fetchLatest (fetch mocked)', () => {
  test('resolves tag, version and html_url from the GitHub payload; sends only a UA and Accept', async () => {
    const f = fakeFetch(okJson({ tag_name: 'v1.2.0', html_url: 'https://github.com/aarushkandukoori/grayout/releases/tag/v1.2.0' }));
    const r = await fetchLatest({ fetchImpl: f, currentVersion: '1.0.0' });
    assert.deepEqual(r, { tag: 'v1.2.0', version: '1.2.0', url: 'https://github.com/aarushkandukoori/grayout/releases/tag/v1.2.0' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, RELEASES_URL);
    assert.equal(RELEASES_URL, 'https://api.github.com/repos/aarushkandukoori/grayout/releases/latest');
    assert.deepEqual(f.calls[0].opts.headers, { 'User-Agent': 'Grayout/1.0.0', Accept: 'application/vnd.github+json' });
    assert.ok(f.calls[0].opts.signal instanceof AbortSignal);
    assert.equal(f.calls[0].opts.method, undefined, 'a plain GET');
    assert.equal(f.calls[0].opts.body, undefined);
  });

  test('missing html_url falls back to the releases page', async () => {
    const r = await fetchLatest({ fetchImpl: fakeFetch(okJson({ tag_name: 'v9.9.9' })) });
    assert.equal(r.url, DOWNLOAD_PAGE);
  });

  test('non-2xx, bad payload, or a thrown error → null, never throws', async () => {
    assert.equal(await fetchLatest({ fetchImpl: fakeFetch(async () => ({ ok: false, status: 403, json: async () => ({}) })) }), null);
    assert.equal(await fetchLatest({ fetchImpl: fakeFetch(okJson({ message: 'Not Found' })) }), null);
    assert.equal(await fetchLatest({ fetchImpl: fakeFetch(okJson(null)) }), null);
    assert.equal(await fetchLatest({ fetchImpl: fakeFetch(async () => { throw new Error('ENOTFOUND'); }) }), null);
    assert.equal(await fetchLatest({ fetchImpl: fakeFetch(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })) }), null);
  });
});

describe('createUpdater with the real state module', () => {
  state._reset();
  try { fs.unlinkSync(paths.STATE_PATH); } catch {}
  let enabled = true;
  const seen = [];
  const f = fakeFetch(okJson({ tag_name: 'v1.2.0', html_url: 'https://github.com/aarushkandukoori/grayout/releases/tag/v1.2.0' }));
  const u = createUpdater({ currentVersion: '1.0.0', isEnabled: () => enabled, state, onAvailable: info => seen.push(info), fetchImpl: f });

  test('disabled: no request, no state write', async () => {
    enabled = false;
    assert.deepEqual(await u.check(), { checked: false });
    assert.equal(f.calls.length, 0);
    assert.equal(state.get().lastUpdateCheck, 0);
    assert.equal(u.getAvailable(), null);
  });

  test('manual check bypasses the setting', async () => {
    const r = await u.check({ manual: true });
    assert.equal(f.calls.length, 1);
    assert.equal(r.checked, true);
    assert.equal(r.newer, true);
    assert.equal(r.latest.version, '1.2.0');
    assert.equal(seen.length, 1);
    assert.equal(u.getAvailable().version, '1.2.0');
  });

  test('lastUpdateCheck is persisted to state.json with mode 0600', () => {
    assert.ok(state.get().lastUpdateCheck > 0);
    assert.ok(fs.existsSync(paths.STATE_PATH));
    assert.equal(helpers.fileMode(paths.STATE_PATH), 0o600);
    assert.equal(JSON.parse(fs.readFileSync(paths.STATE_PATH, 'utf8')).lastUpdateCheck, state.get().lastUpdateCheck);
  });

  test('dismiss hides that version from automatic checks but not manual ones', async () => {
    enabled = true;
    u.dismiss();
    assert.equal(u.getAvailable(), null);
    assert.equal(state.get().dismissedVersion, '1.2.0');
    await u.check();
    assert.equal(seen.length, 1, 'dismissed version announced again');
    assert.equal(u.getAvailable(), null);
    await u.check({ manual: true });
    assert.equal(seen.length, 2);
    assert.equal(u.getAvailable().version, '1.2.0');
  });

  test('a newer-than-dismissed version is announced automatically', async () => {
    const f2 = fakeFetch(okJson({ tag_name: 'v1.3.0' }));
    const seen2 = [];
    const u2 = createUpdater({ currentVersion: '1.0.0', isEnabled: () => true, state, onAvailable: i => seen2.push(i), fetchImpl: f2 });
    await u2.check();
    assert.equal(seen2.length, 1);
    assert.equal(seen2[0].version, '1.3.0');
  });

  test('same or older release: checked but not newer, onAvailable not called', async () => {
    const seen3 = [];
    const u3 = createUpdater({ currentVersion: '1.2.0', isEnabled: () => true, state, onAvailable: i => seen3.push(i), fetchImpl: f });
    const r = await u3.check();
    assert.deepEqual({ checked: r.checked, newer: r.newer }, { checked: true, newer: false });
    assert.equal(seen3.length, 0);
    assert.equal(u3.getAvailable(), null);
  });

  test('network failure: { checked: false } and the timestamp still moves', async () => {
    const before = state.get().lastUpdateCheck;
    await new Promise(r => setTimeout(r, 2));
    const u4 = createUpdater({ currentVersion: '1.0.0', isEnabled: () => true, state, onAvailable: () => {}, fetchImpl: fakeFetch(async () => { throw new Error('offline'); }) });
    assert.deepEqual(await u4.check(), { checked: false });
    assert.ok(state.get().lastUpdateCheck > before);
  });

  test('a throwing onAvailable does not break check()', async () => {
    const u5 = createUpdater({ currentVersion: '1.0.0', isEnabled: () => true, state: null, onAvailable: () => { throw new Error('ui gone'); }, fetchImpl: f });
    const r = await u5.check();
    assert.equal(r.newer, true);
    assert.equal(u5.getAvailable().version, '1.2.0');
  });

  test('start(): first check after 60 s, then every 24 h; stop() ends it', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const f6 = fakeFetch(okJson({ tag_name: 'v1.2.0' }));
    const u6 = createUpdater({ currentVersion: '1.0.0', isEnabled: () => true, state: null, onAvailable: () => {}, fetchImpl: f6 });
    u6.start();
    t.mock.timers.tick(59 * 1000);
    assert.equal(f6.calls.length, 0);
    t.mock.timers.tick(1000);
    assert.equal(f6.calls.length, 1);
    t.mock.timers.tick(24 * 3600 * 1000);
    assert.equal(f6.calls.length, 2);
    u6.stop();
    t.mock.timers.tick(48 * 3600 * 1000);
    assert.equal(f6.calls.length, 2);
  });
});

describe('state module (used by the updater and the daily cap)', () => {
  test('bumpChecks counts within the local day and persists', () => {
    state._reset();
    try { fs.unlinkSync(paths.STATE_PATH); } catch {}
    assert.equal(state.checksToday(), 0);
    assert.equal(state.bumpChecks(), 1);
    assert.equal(state.bumpChecks(), 2);
    assert.equal(state.checksToday(), 2);
    assert.equal(state.get().dayCounter.day, state.localDay());
    assert.ok(state.get().firstRunAt > 0);
    state._reset();
    assert.equal(state.checksToday(), 2, 'reloaded from disk');
    assert.deepEqual(state.get().onboarding, { completed: false, step: 1 });
  });

  test('a stale day counter resets to zero', () => {
    state.update(s => { s.dayCounter = { day: '2000-01-01', checks: 500 }; });
    assert.equal(state.checksToday(), 0);
    assert.equal(state.bumpChecks(), 1);
  });

  test('a corrupt state.json is tolerated', () => {
    state._reset();
    fs.writeFileSync(paths.STATE_PATH, '{ nope');
    assert.deepEqual(state.get().dayCounter, { day: '', checks: 0 });
  });
});
