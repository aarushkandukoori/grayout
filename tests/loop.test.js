'use strict';
// Mocked end-to-end tests of the watch loop state machine (BUILD-SPEC §23).
// Every dependency is a fake that records calls; time is a fake clock.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('loop');
const { createLoop, BACKOFF_STEPS_MS, TICK_HARD_LIMIT_MS } = require('../src/loop');
const { DEFAULT_CONFIG } = require('../src/config');
const { NoKeyError } = require('../src/analyzer');

after(() => helpers.cleanup(dir));

const KEY = 'sk-ant-api03-LOOPTESTKEY-0123456789abcdef';
const T0 = 1789905600000;
const MIN = 60000;

const v = (off, conf = 'high', activity = off ? 'social media feed' : 'code editor and terminal') =>
  ({ off_task: off, confidence: conf, activity });
const ok = (verdict, extra = {}) =>
  ({ verdict, engine: 'api', usage: { input_tokens: 2268, output_tokens: 40 }, model: 'claude-haiku-4-5', ...extra });
const OFF = () => ok(v(true));
const ON = () => ok(v(false));
const withStatus = (status, message) => Object.assign(new Error(message), { status });

/** Build a loop with recording fakes and a scripted analyze(). */
function build({ cfg: cfgOver = {}, deps: depsOver = {} } = {}) {
  const cfg = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...cfgOver };
  const calls = { analyze: [], capture: 0, gray: [], paint: [], log: [], notify: [], forceOff: 0, webcam: 0, tasks: [], timers: [] };
  const script = [];
  let now = T0;
  let idle = 0;
  let frontApp = 'Code';
  let checksToday = 0;
  // createLoop copies deps at construction, so anything a test wants to swap
  // later must go through an indirection.
  let captureImpl = async n => ({ images: ['BASE64FRAME'], blank: false });
  const deps = {
    config: () => cfg,
    capture: async n => { calls.capture++; calls.lastDisplays = n; return captureImpl(n); },
    analyze: async (ctx, c) => {
      calls.analyze.push({ ctx, c });
      if (!script.length) throw new Error('test script exhausted');
      const next = script.shift();
      if (typeof next === 'function') return next(ctx);
      if (next && next.throw) throw next.throw;
      return next;
    },
    secrets: { getApiKey: () => KEY, getCanvasToken: () => 'canvas-token' },
    grayscale: { set: async on => { calls.gray.push(on); return true; }, forceOffSync: () => { calls.forceOff++; return true; }, available: () => true },
    overlays: { paint: on => calls.paint.push(on) },
    logVerdict: row => calls.log.push(row),
    state: { checksToday: () => checksToday, bumpChecks: () => ++checksToday },
    getIdleSeconds: async () => idle,
    getFrontmostApp: async () => frontApp,
    now: () => now,
    notify: (title, body) => calls.notify.push({ title, body }),
    setTimer: (fn, ms) => { calls.timers.push(ms); return { fn, ms }; },
    clearTimer: t => { calls.cleared = (calls.cleared || 0) + 1; },
    captureWebcam: async () => { calls.webcam++; return 'WEBCAMB64'; },
    gatherTasks: async (c, token) => { calls.tasks.push(token); return { canvas: ['Problem Set 4'], file: ['write report'] }; },
    ...depsOver
  };
  const loop = createLoop(deps);
  const h = {
    cfg, calls, script, loop, deps,
    get now() { return now; }, set now(t) { now = t; },
    advance(ms) { now += ms; },
    setIdle(s) { idle = s; },
    setFront(a) { frontApp = a; },
    setChecksToday(n) { checksToday = n; },
    setCapture(fn) { captureImpl = fn; },
    checksToday: () => checksToday,
    live: () => loop.getLive(),
    /** Queue responses, run one tick, then advance the clock by one interval. */
    async step(...responses) { script.push(...responses); await loop.tick(); now += cfg.checkIntervalSec * 1000; },
    async fire() { await this.step(OFF()); await this.step(OFF()); assert.equal(loop.getLive().alerting, true, 'precondition: alert on'); }
  };
  return h;
}

describe('1. strikes → alert', () => {
  test('two high-confidence off verdicts fire; one on-task verdict clears', async () => {
    const h = build();
    await h.step(OFF());
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().strikeCount, 1);
    assert.equal(h.calls.gray.includes(true), false);
    assert.equal(h.calls.paint.includes(true), false);

    await h.step(OFF());
    assert.equal(h.live().alerting, true);
    assert.equal(h.live().strikeCount, 2);
    assert.equal(h.live().alertSince, T0 + 45000);
    assert.equal(h.calls.gray.at(-1), true);
    assert.equal(h.calls.paint.at(-1), true);
    assert.equal(h.live().lastLine, 'off task: social media feed');
    assert.equal(h.live().lastActivity, 'social media feed');
    assert.equal(h.live().lastApp, 'Code');

    await h.step(ON());
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.calls.gray.at(-1), false);
    assert.equal(h.calls.paint.at(-1), false);
    assert.equal(h.live().lastLine, 'code editor and terminal');
    assert.equal(h.calls.analyze.length, 3);
    assert.equal(h.calls.capture, 3);
  });

  test('analyze receives the frames, the key, the front app, tasks and the config', async () => {
    const h = build({ cfg: { workDescription: 'thesis writing', camera: true } });
    await h.step(ON());
    const { ctx, c } = h.calls.analyze[0];
    assert.deepEqual(ctx.screenshotsB64, ['BASE64FRAME']);
    assert.equal(ctx.apiKey, KEY);
    assert.equal(ctx.frontApp, 'Code');
    assert.equal(ctx.workDescription, 'thesis writing');
    assert.deepEqual(ctx.canvasTasks, ['Problem Set 4']);
    assert.deepEqual(ctx.fileTasks, ['write report']);
    assert.equal(ctx.webcamB64, 'WEBCAMB64');
    assert.equal(c, h.cfg);
    assert.deepEqual(h.calls.tasks, ['canvas-token']);
    assert.equal(h.calls.webcam, 1);
    assert.equal(h.calls.lastDisplays, 1);
  });

  test('camera off → webcam never captured', async () => {
    const h = build();
    await h.step(ON());
    assert.equal(h.calls.webcam, 0);
    assert.equal(h.calls.analyze[0].ctx.webcamB64, null);
  });

  test('strikes setting is honored (3 strikes)', async () => {
    const h = build({ cfg: { strikes: 3 } });
    await h.step(OFF()); await h.step(OFF());
    assert.equal(h.live().alerting, false);
    await h.step(OFF());
    assert.equal(h.live().alerting, true);
  });

  test('grayscale/redFlash config gates each consequence', async () => {
    const h = build({ cfg: { grayscale: false } });
    await h.fire();
    assert.equal(h.calls.gray.includes(true), false, 'grayscale disabled');
    assert.equal(h.calls.paint.at(-1), true);
    const h2 = build({ cfg: { redFlash: false } });
    await h2.fire();
    assert.equal(h2.calls.paint.includes(true), false, 'red flash disabled');
    assert.equal(h2.calls.gray.at(-1), true);
  });

  test('the alert state is re-asserted at the start of every tick (self-heal)', async () => {
    const h = build();
    await h.fire();
    const n = h.calls.gray.length;
    h.setIdle(h.cfg.idleSkipSec); // held → early return, but applyAlertState already ran
    h.loop._state.lastIdleRecheckAt = h.now; // keep the held path from running a check
    await h.step();
    assert.equal(h.calls.gray.length, n + 1);
    assert.equal(h.calls.gray.at(-1), true);
    assert.equal(h.calls.paint.at(-1), true);
  });
});

describe('2. strike reset', () => {
  test('off(high) then off(medium) never fires', async () => {
    const h = build();
    await h.step(OFF());
    assert.equal(h.live().strikeCount, 1);
    await h.step(ok(v(true, 'medium')));
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.live().alerting, false);
    await h.step(OFF());
    assert.equal(h.live().strikeCount, 1, 'counting restarted from zero');
    assert.equal(h.live().alerting, false);
    await h.step(ok(v(true, 'low')));
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.calls.gray.includes(true), false);
  });

  test('a blank screen skips the call and resets strikes', async () => {
    const h = build();
    await h.step(OFF());
    h.setCapture(async () => ({ images: [], blank: true }));
    await h.step();
    assert.equal(h.calls.capture, 2);
    assert.equal(h.calls.analyze.length, 1);
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.live().lastLine, 'screen blank/asleep — skipping');
  });
});

describe('3. pause mid-flight', () => {
  test('a verdict that arrives after pause() is discarded', async () => {
    const h = build({ cfg: { strikes: 1 } });
    let release;
    h.script.push(() => new Promise(r => { release = r; }));
    const inflight = h.loop.tick();
    while (!release) await helpers.turns(1);
    assert.equal(h.live().analyzing, true);
    h.loop.pause();
    assert.equal(h.live().paused, true);
    assert.equal(h.live().lastLine, 'paused');
    release(OFF());
    await inflight;
    assert.equal(h.calls.log.length, 0, 'stale verdict was logged');
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.live().alerting, false);
    assert.equal(h.calls.gray.includes(true), false);
    assert.equal(h.live().analyzing, false);
    assert.equal(h.checksToday(), 0, 'stale verdict counted against the cap');
  });

  test('reload() (config change) also discards an in-flight verdict', async () => {
    const h = build({ cfg: { strikes: 1 } });
    let release;
    h.script.push(() => new Promise(r => { release = r; }));
    const inflight = h.loop.tick();
    while (!release) await helpers.turns(1);
    h.loop.reload();
    release(OFF());
    await inflight;
    assert.equal(h.calls.log.length, 0);
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().paused, false);
  });

  test('a stale error is ignored too', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    let reject;
    h.script.push(() => new Promise((_r, rj) => { reject = rj; }));
    const inflight = h.loop.tick();
    while (!reject) await helpers.turns(1);
    h.loop.pause();
    reject(withStatus(429, 'rate limited'));
    await inflight;
    assert.equal(h.live().backoffUntil, 0);
    assert.equal(h.live().errorKind, null);
  });

  test('a wedged tick is reclaimed, its late verdict is discarded, and it does not free the new lock', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    let resolveWedged;
    h.script.push(() => new Promise(r => { resolveWedged = r; }));
    const wedged = h.loop.tick();                       // tick A: hangs in analyze
    while (!resolveWedged) await helpers.turns(1);
    assert.equal(h.live().analyzing, true);

    h.now = T0 + TICK_HARD_LIMIT_MS + 1000;             // A is now older than any real check
    let resolveSecond;
    h.script.push(() => new Promise(r => { resolveSecond = r; }));
    const second = h.loop.tick();                       // tick B reclaims the lock
    while (!resolveSecond) await helpers.turns(1);
    assert.equal(h.calls.analyze.length, 2, 'B really started');

    resolveWedged(OFF());                               // A finally answers, 150 s late
    await wedged;
    assert.equal(h.calls.log.length, 0, "the stale verdict is not logged");
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().analyzing, true, 'B still owns the lock');

    resolveSecond(ON());
    await second;
    assert.equal(h.live().analyzing, false);
    assert.equal(h.calls.log.length, 1, "only B's verdict counts");
  });

  test('a loop paused for setup checks nothing until it is resumed (the onboarding contract)', async () => {
    const h = build();
    h.loop.pause('setup not finished');
    h.loop.start();
    await h.step(ON());
    assert.equal(h.calls.capture, 0, 'start() alone does not undo a pause');
    h.script.push(ON());
    await h.loop.resume();
    assert.equal(h.calls.capture, 1);
    assert.equal(h.live().paused, false);
  });

  test('while paused, tick() does nothing and checkNow() resolves without a check', async () => {
    const h = build();
    h.loop.pause();
    await h.step();
    await h.loop.checkNow();
    assert.equal(h.calls.capture, 0);
    assert.equal(h.calls.analyze.length, 0);
  });

  test('pause() clears an active alert; resume() checks immediately', async () => {
    const h = build();
    await h.fire();
    await h.loop.pause();
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.calls.gray.at(-1), false);
    assert.equal(h.calls.paint.at(-1), false);
    h.script.push(ON());
    await h.loop.resume();
    assert.equal(h.live().paused, false);
    assert.equal(h.calls.analyze.length, 3);
    assert.equal(h.live().lastLine, 'code editor and terminal');
  });

  test('pauseFor() auto-resumes once the deadline passes (min 60 s)', async () => {
    const h = build();
    h.loop.pauseFor(1000);
    assert.equal(h.live().pausedUntil, T0 + 60000, 'floor of one minute');
    h.loop.pauseFor(15 * MIN);
    assert.equal(h.live().pausedUntil, T0 + 15 * MIN);
    assert.match(h.live().lastLine, /^paused until /);
    await h.step();
    assert.equal(h.calls.capture, 0);
    h.now = T0 + 15 * MIN;
    await h.step(ON());
    assert.equal(h.live().paused, false);
    assert.equal(h.live().pausedUntil, 0);
    assert.equal(h.calls.capture, 1);
  });
});

describe('4. idle', () => {
  test('idle with alert on: held (no analyze) except one recheck per heldAlertRecheckSec', async () => {
    const h = build();
    await h.fire();
    assert.equal(h.calls.analyze.length, 2);

    h.setIdle(h.cfg.idleSkipSec);
    // The recheck clock starts from the last real check, so the first idle tick
    // while alerting HOLDS (no capture, no call); the alert stays on and is re-asserted.
    const lastCheck = h.loop._state.lastCheckAt;
    assert.equal(h.loop._state.lastIdleRecheckAt, lastCheck);
    const cap = h.calls.capture;
    await h.step();
    assert.equal(h.calls.analyze.length, 2, 'first idle tick while alerting holds');
    assert.equal(h.calls.capture, cap);
    assert.equal(h.live().alerting, true);
    assert.equal(h.live().lastLine, `idle ${h.cfg.idleSkipSec}s — checks paused (alert held)`);
    assert.equal(h.calls.gray.at(-1), true);
    await h.step();
    assert.equal(h.calls.analyze.length, 2);

    // After heldAlertRecheckSec: exactly one check; an on-task verdict restores color.
    h.now = lastCheck + h.cfg.heldAlertRecheckSec * 1000;
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 3);
    assert.equal(h.live().alerting, false);
    assert.equal(h.calls.gray.at(-1), false);

    // Idle without an alert: never a call, however long it has been.
    h.advance(60 * MIN);
    await h.step();
    await h.step();
    assert.equal(h.calls.analyze.length, 3);
    assert.equal(h.live().lastLine, `idle ${h.cfg.idleSkipSec}s — checks paused`);
  });

  test('a wrong gray still self-corrects with no input at all', async () => {
    const h = build();
    await h.fire();
    h.setIdle(3600);
    await h.step();                 // held
    assert.equal(h.live().alerting, true);
    h.now = h.loop._state.lastCheckAt + h.cfg.heldAlertRecheckSec * 1000;
    await h.step(ON());
    assert.equal(h.live().alerting, false);
  });

  test('idle below the threshold checks normally; a null idle reading is ignored', async () => {
    const h = build();
    h.setIdle(h.cfg.idleSkipSec - 1);
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 1);
    h.setIdle(null);
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2);
  });
});

describe('5. lock and wake', () => {
  test('a frontmost "loginwindow" (already locked at launch) skips capture and the call', async () => {
    const h = build({ deps: { getFrontmostApp: async () => 'loginwindow' } });
    await h.step(ON());
    assert.equal(h.calls.capture, 0);
    assert.equal(h.calls.analyze.length, 0);
    assert.equal(h.live().lastLine, 'screen locked — checks paused');
  });

  test('locked → no capture; unlock → wake grace → capture', async () => {
    const h = build();
    h.loop.setLocked(true);
    assert.equal(h.live().locked, true);
    await h.step();
    assert.equal(h.calls.capture, 0);
    assert.equal(h.live().lastLine, 'screen locked — checks paused');

    h.loop.setLocked(false);                      // wokeAt = T0 + 45 s
    assert.equal(h.live().locked, false);
    assert.equal(h.live().lastLine, 'just woke — waiting');
    await h.step();                                // still inside wakeGraceSec
    assert.equal(h.calls.capture, 0);
    assert.equal(h.live().lastLine, 'just woke — waiting');

    assert.equal(h.now, T0 + 90000);
    assert.ok(h.now - (T0 + 45000) >= h.cfg.wakeGraceSec * 1000);
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.calls.analyze.length, 1);
  });

  test('locking while alerting keeps the state; the alert is still asserted', async () => {
    const h = build();
    await h.fire();
    h.loop.setLocked(true);
    await h.step();
    assert.equal(h.live().alerting, true);
    assert.equal(h.calls.gray.at(-1), true);
    assert.equal(h.calls.analyze.length, 2);
  });

  test('onWake() starts the grace; checkNow() skips it', async () => {
    const h = build();
    h.loop.onWake();
    await h.step();
    assert.equal(h.calls.capture, 0);
    h.script.push(ON());
    await h.loop.checkNow();
    assert.equal(h.calls.capture, 1);
  });

  test('wakeGraceSec: 0 means no wait', async () => {
    const h = build({ cfg: { wakeGraceSec: 0 } });
    h.loop.setLocked(false);
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
  });
});

describe('6. watchdog', () => {
  test('an alert older than maxAlertMinutes is cleared with a generic notification', async () => {
    const h = build();
    await h.fire();
    const alertSince = h.live().alertSince;
    h.now = alertSince + h.cfg.maxAlertMinutes * MIN - 1;
    await h.step(OFF());
    assert.equal(h.live().alerting, true, 'one ms early: still on');
    assert.equal(h.calls.notify.length, 0);

    h.now = alertSince + h.cfg.maxAlertMinutes * MIN;
    const grayBefore = h.calls.gray.length;
    await h.step(OFF());
    assert.deepEqual(h.calls.notify, [{ title: 'Grayout restored color', body: 'It had been gray for 20 minutes. If that was wrong, open the dashboard.' }]);
    assert.equal(h.calls.notify[0].body.includes('social media'), false, 'no activity phrase in the notification');
    // gray: re-assert(true) → clearAlert(false) → the continuing check's setAlert(false)
    assert.deepEqual(h.calls.gray.slice(grayBefore), [true, false, false]);
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().strikeCount, 1, 'strikes restarted; the check still ran');
    assert.equal(h.calls.analyze.length, 4);
  });

  test('maxAlertMinutes is read from config', async () => {
    const h = build({ cfg: { maxAlertMinutes: 1 } });
    await h.fire();
    h.now = h.live().alertSince + MIN;
    await h.step(ON());
    assert.equal(h.calls.notify[0].body, 'It had been gray for 1 minutes. If that was wrong, open the dashboard.');
    assert.equal(h.live().lastLine, 'code editor and terminal');
  });
});

describe('7. dispute', () => {
  test('clears the alert, sets grace, logs a dispute row; no alert within grace, alert after', async () => {
    const h = build();
    await h.fire();
    const lastTs = h.live().lastVerdictTs;
    h.calls.log.length = 0;
    await h.loop.dispute();
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.calls.gray.at(-1), false);
    assert.equal(h.live().graceUntil, h.now + h.cfg.disputeGraceMin * MIN);
    assert.equal(h.live().lastLine, `okay — not grayed for ${h.cfg.disputeGraceMin} min`);
    assert.deepEqual(h.calls.log, [{ ts: h.now, type: 'dispute', ref: lastTs }]);

    await h.step(OFF());
    await h.step(OFF());
    assert.equal(h.live().strikeCount, 2, 'still judged and counted');
    assert.equal(h.live().alerting, false, 'but never fires inside grace');
    assert.equal(h.calls.gray.includes(true), h.calls.gray.slice(0, 4).includes(true) && !h.calls.gray.slice(-4).includes(true));
    assert.match(h.live().lastLine, /^social media feed \(not grayed until /);
    assert.equal(h.calls.log.filter(r => r.type !== 'dispute').length, 2, 'verdicts inside grace are logged');

    h.now = h.live().graceUntil;
    await h.step(OFF());
    assert.equal(h.live().alerting, true);
    assert.equal(h.calls.gray.at(-1), true);
  });

  test('dispute(refTs) records the given reference', async () => {
    const h = build();
    await h.loop.dispute(1234);
    assert.deepEqual(h.calls.log, [{ ts: T0, type: 'dispute', ref: 1234 }]);
    const h2 = build();
    await h2.loop.dispute();
    assert.equal(h2.calls.log[0].ref, null, 'no verdict yet → null');
  });
});

describe('8. app lists', () => {
  test('allowlisted front app: no capture, strikes reset, alert cleared', async () => {
    const h = build();
    await h.fire();
    h.setFront('zoom.us');
    await h.step();
    assert.equal(h.calls.capture, 2);
    assert.equal(h.calls.analyze.length, 2);
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.live().lastLine, 'allowlisted: zoom.us');
    assert.equal(h.calls.gray.at(-1), false);
  });

  test('matching is a case-insensitive substring of the display name', async () => {
    const h = build();
    for (const name of ['FaceTime', 'facetime', 'Microsoft Teams (work or school)', 'Discord Canary']) {
      h.setFront(name);
      await h.step();
      assert.equal(h.live().lastLine, `allowlisted: ${name}`);
    }
    assert.equal(h.calls.capture, 0);
  });

  test('neverCapture front app: no capture, strikes and alert untouched', async () => {
    const h = build();
    await h.step(OFF());
    assert.equal(h.live().strikeCount, 1);
    h.setFront('1Password 8');
    await h.step();
    assert.equal(h.calls.capture, 1);
    assert.equal(h.calls.analyze.length, 1);
    assert.equal(h.live().strikeCount, 1);
    assert.equal(h.live().lastLine, 'not watching: 1Password 8');
    assert.equal(h.live().lastApp, '1Password 8');
    h.setFront('Code');
    await h.step(OFF());
    assert.equal(h.live().alerting, true, 'the earlier strike still counted');
    h.setFront('Keychain Access');
    await h.step();
    assert.equal(h.live().alerting, true, 'alert held while in a password manager');
  });

  test('neverCapture wins over the allowlist', async () => {
    const h = build({ cfg: { alwaysAllowedApps: ['Vault'], neverCaptureApps: ['Vault'] } });
    await h.step(OFF());
    h.setFront('Vault');
    await h.step();
    assert.equal(h.live().lastLine, 'not watching: Vault');
    assert.equal(h.live().strikeCount, 1);
  });

  test('an unknown front app (null) is captured and logged as null', async () => {
    const h = build();
    h.setFront(null);
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.calls.log[0].app, null);
  });
});

describe('9. errors', () => {
  test('401 → needsKey, provider-named key_rejected line, 15-min backoff, no alert; reload() retries at once', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    await h.step({ throw: withStatus(401, '401 authentication_error: invalid x-api-key') });
    const live = h.live();
    assert.equal(live.needsKey, true);
    assert.equal(live.errorKind, 'key_rejected');
    assert.equal(live.lastLine, 'Anthropic rejected the API key — fix in Settings');
    assert.equal(live.alerting, false);
    assert.equal(live.strikeCount, 0);
    assert.equal(live.paused, false, 'not paused: the tray still says why, and a new key fixes it');
    // step() advanced the clock by one interval after the tick ran.
    assert.equal(live.backoffUntil, h.now - h.cfg.checkIntervalSec * 1000 + 15 * 60000, 'a dead key is not re-sent every tick');
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 1, 'inside the backoff no call is made');
    h.loop.reload(); // a saved key / config change clears the backoff
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2);
    assert.equal(h.live().needsKey, false, 'a working call clears needsKey');
    assert.equal(h.live().errorKind, null);
  });

  test('requiresKey() false lets a keyless engine run (maintainer CLI path)', async () => {
    const h = build({ deps: { secrets: { getApiKey: () => null, getCanvasToken: () => '' }, requiresKey: () => false } });
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.calls.analyze[0].ctx.apiKey, null);
    assert.equal(h.live().needsKey, false);
  });

  test('bad_model (404 / unknown model) gets an actionable line and a 15-min backoff', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    await h.step({ throw: withStatus(404, 'The model `gpt-9` does not exist or you do not have access to it.') });
    assert.equal(h.live().errorKind, 'bad_model');
    assert.equal(h.live().lastLine, 'model not available on this Anthropic account — check config.json');
    assert.equal(h.live().backoffUntil, h.now - h.cfg.checkIntervalSec * 1000 + 15 * 60000);
    assert.equal(h.live().needsKey, false);
  });

  test('an OpenAI insufficient_quota error takes the no_credit path (wording still says Anthropic — see report)', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    const e = withStatus(429, '429 You exceeded your current quota, please check your plan and billing details.');
    e.code = 'insufficient_quota';
    await h.step({ throw: e });
    assert.equal(h.live().errorKind, 'no_credit');
    assert.equal(h.live().backoffUntil, T0 + 15 * MIN);
    assert.equal(h.live().lastLine, 'Anthropic account has no credit — add credit at console.anthropic.com');
  });

  test('a NoKeyError from analyze reads as no_key', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    await h.step({ throw: new NoKeyError() });
    assert.equal(h.live().needsKey, true);
    assert.equal(h.live().lastLine, 'API key needed — open Settings');
  });

  test('no stored key: no capture, needsKey, an active alert is cleared', async () => {
    const h = build({ deps: { secrets: { getApiKey: () => null, getCanvasToken: () => '' } } });
    await h.step();
    assert.equal(h.calls.capture, 0);
    assert.equal(h.live().needsKey, true);
    assert.equal(h.live().lastLine, 'API key needed — open Settings');
    const h2 = build();
    await h2.fire();
    h2.deps.secrets.getApiKey = () => null;
    await h2.step();
    assert.equal(h2.live().alerting, false);
    assert.equal(h2.calls.gray.at(-1), false);
  });

  test('429 → exponential backoff 30/60/120/300/300 s; no call inside the window; success resets', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    assert.deepEqual(BACKOFF_STEPS_MS, [30000, 60000, 120000, 300000]);
    const expected = [30000, 60000, 120000, 300000, 300000];
    for (const wait of expected) {
      const at = h.now;
      await h.step({ throw: withStatus(429, '429 rate_limit_error') });
      assert.equal(h.live().backoffUntil, at + wait);
      assert.equal(h.live().errorKind, 'rate_limited');
      assert.match(h.live().lastLine, /^Anthropic busy — retrying at /);
      // inside the window: no capture, no call
      const calls = h.calls.analyze.length, caps = h.calls.capture;
      h.now = at + wait - 1;
      await h.loop.tick();
      assert.equal(h.calls.analyze.length, calls);
      assert.equal(h.calls.capture, caps);
      assert.match(h.live().lastLine, /^Anthropic busy — retrying at /);
      h.now = at + wait;
    }
    await h.step(ON());
    assert.equal(h.live().errorKind, null);
    const at = h.now;
    await h.step({ throw: withStatus(429, 'again') });
    assert.equal(h.live().backoffUntil, at + 30000, 'a success resets the backoff ladder');
  });

  test('529 / 5xx → overloaded backoff; network errors → "no connection"', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    await h.step({ throw: withStatus(529, 'overloaded_error') });
    assert.equal(h.live().errorKind, 'overloaded');
    assert.equal(h.live().backoffUntil, T0 + 30000);
    h.now = T0 + 30000;
    await h.step({ throw: new Error('getaddrinfo ENOTFOUND api.anthropic.com') });
    assert.equal(h.live().errorKind, 'network');
    assert.match(h.live().lastLine, /^no connection — retrying at /);
    assert.equal(h.live().backoffUntil, T0 + 30000 + 60000);
  });

  test('checkNow() clears the backoff and checks at once', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    await h.step({ throw: withStatus(429, 'x') });
    h.script.push(ON());
    await h.loop.checkNow();
    assert.equal(h.live().backoffUntil, 0);
    assert.equal(h.calls.analyze.length, 2);
  });

  test('no_credit → 15-minute backoff with the console.anthropic.com line; not paused (actual behavior)', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    await h.step({ throw: withStatus(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.') });
    assert.equal(h.live().errorKind, 'no_credit');
    assert.equal(h.live().lastLine, 'Anthropic account has no credit — add credit at console.anthropic.com');
    assert.equal(h.live().backoffUntil, T0 + 15 * MIN);
    // BUILD-SPEC §9 step 19 says paused = true here; the code backs off instead (see report).
    assert.equal(h.live().paused, false);
    h.now = T0 + 15 * MIN - 1;
    await h.loop.tick();
    assert.equal(h.calls.analyze.length, 1);
    h.now = T0 + 15 * MIN;
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2);
  });

  test('unknown errors show a truncated message and do not back off', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    await h.step({ throw: new Error('x'.repeat(300)) });
    assert.equal(h.live().lastLine, 'error: ' + 'x'.repeat(120));
    assert.equal(h.live().backoffUntil, 0);
    assert.equal(h.live().errorKind, 'unknown');
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2);
  });

  test('a capture failure that smells like Screen Recording sets needsScreenPermission', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    h.setCapture(async () => { throw new Error('screencapture: could not create image from display'); });
    await h.step();
    assert.equal(h.live().needsScreenPermission, true);
    assert.equal(h.live().lastLine, 'needs Screen Recording permission');
    assert.equal(h.calls.analyze.length, 0);
    assert.equal(h.live().errorKind, null, 'a permission failure is not an API error');
    h.setCapture(async () => ({ images: ['B64'], blank: false }));
    await h.step(ON());
    assert.equal(h.live().needsScreenPermission, false, 'cleared once we can see the screen again');
    // The authoritative macOS answer (fed in by main.js) also stops the loop
    // capturing at all, so we never pay for a desktop-picture-only screenshot.
    h.loop.setNeedsScreenPermission(true);
    assert.equal(h.live().needsScreenPermission, true);
    const before = h.calls.capture;
    await h.step(ON());
    assert.equal(h.calls.capture, before, 'denied: no capture attempted');
    assert.equal(h.live().lastLine, 'needs Screen Recording permission');
    h.script.push(ON());
    await h.loop.recheckPermission();
    assert.equal(h.live().needsScreenPermission, false);
    assert.equal(h.calls.capture, before + 1, 'recheck captures again');
  });

  test('a denied screen clears an active alert instead of leaving the Mac gray', async () => {
    const h = build();
    await h.fire();
    assert.equal(h.live().alerting, true);
    h.loop.setNeedsScreenPermission(true);
    await h.step();
    assert.equal(h.live().alerting, false, 'we cannot see the screen, so we cannot keep punishing');
    assert.equal(h.calls.gray.at(-1), false);
    assert.equal(h.live().lastLine, 'no screen access — color restored');
  });

  test('two consecutive failures while alerting restore color', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    await h.fire();
    await h.step({ throw: new Error('boom') });
    assert.equal(h.live().alerting, true, 'one failure: alert kept');
    assert.equal(h.live().strikeCount, 0, 'but strikes dropped');
    await h.step({ throw: new Error('boom') });
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().lastLine, 'check failing — color restored');
    assert.equal(h.calls.gray.at(-1), false);
  });

  test('a wedged tick is reclaimed after TICK_HARD_LIMIT_MS', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();
    h.loop._state.analyzing = true;
    h.loop._state.analyzingSince = T0;
    await h.step();
    assert.equal(h.calls.capture, 0, 'still within the limit: tick skipped');
    h.now = T0 + TICK_HARD_LIMIT_MS;
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.live().analyzing, false);
  });
});

describe('10. daily cap', () => {
  test('cap reached → no capture, no call, alert cleared, capHit', async () => {
    const h = build();
    await h.fire();
    h.setChecksToday(h.cfg.dailyCheckCap);
    await h.step();
    assert.equal(h.calls.capture, 2);
    assert.equal(h.calls.analyze.length, 2);
    assert.equal(h.live().capHit, true);
    assert.equal(h.live().alerting, false);
    assert.equal(h.calls.gray.at(-1), false);
    assert.equal(h.live().lastLine, `daily cap of ${h.cfg.dailyCheckCap} checks reached — resumes tomorrow`);
    h.setChecksToday(0);
    await h.step(ON());
    assert.equal(h.live().capHit, false);
    assert.equal(h.calls.analyze.length, 3);
  });

  test('every logged verdict bumps the day counter', async () => {
    const h = build({ cfg: { dailyCheckCap: 50 } });
    for (let i = 0; i < 3; i++) await h.step(ON());
    assert.equal(h.checksToday(), 3);
    h.setChecksToday(49);
    await h.step(ON());
    assert.equal(h.checksToday(), 50);
    await h.step();
    assert.equal(h.live().capHit, true);
    assert.equal(h.calls.analyze.length, 4);
  });
});

describe('11. verdict log line', () => {
  test('contains usage and cost, never the key or the frame', async () => {
    const h = build();
    await h.step(OFF());
    assert.equal(h.calls.log.length, 1);
    const row = h.calls.log[0];
    assert.deepEqual(row, {
      ts: T0, off: true, conf: 'high', activity: 'social media feed', app: 'Code', displays: 1, strikes: 1,
      engine: 'api', model: 'claude-haiku-4-5', usage: { input_tokens: 2268, output_tokens: 40 }, cost: 0.002468
    });
    const line = JSON.stringify(row);
    assert.equal(line.includes(KEY), false);
    assert.equal(line.includes('sk-ant'), false);
    assert.equal(line.includes('BASE64FRAME'), false);
    assert.equal(line.includes('canvas-token'), false);
    assert.equal(line.includes('Problem Set'), false);
    assert.equal(h.live().lastVerdictTs, T0);
  });

  test('cost is null without usage or with an unknown model; model falls back to config', async () => {
    const h = build();
    await h.step(ok(v(false), { usage: null, engine: 'cli', model: undefined }));
    assert.equal(h.calls.log[0].cost, null);
    assert.equal(h.calls.log[0].usage, null);
    assert.equal(h.calls.log[0].engine, 'cli');
    assert.equal(h.calls.log[0].model, 'claude-haiku-4-5');
    await h.step(ok(v(false), { model: 'gpt-4o' }));
    assert.equal(h.calls.log[1].cost, null);
    assert.equal(h.calls.log[1].model, 'gpt-4o');
    await h.step(ok(v(false), { usage: { input_tokens: 1000000, output_tokens: 0 }, model: 'claude-haiku-4-5-20251001' }));
    assert.equal(h.calls.log[2].cost, 1);
  });

  test('a two-display capture logs displays: 2', async () => {
    const h = build({ deps: { displays: () => 2 } });
    h.setCapture(async n => ({ images: ['A', 'B'].slice(0, n), blank: false }));
    await h.step(ON());
    assert.equal(h.calls.log[0].displays, 2);
    assert.equal(h.calls.analyze[0].ctx.screenshotsB64.length, 2);
  });
});

describe('12. change-gating', () => {
  // 8x8 average hashes; see tests/framehash.test.js for how they are built.
  const SAME = ['0f0f0f0f0f0f0f0f'];
  const NEAR = ['0f0f0f0f0f0f0f0e'];       // 1 bit away: still "unchanged"
  const DRIFT = ['0f0f0f0f0f0f0f0c'];      // 2 bits away
  const FAR = ['f0f0f0f0f0f0f0f0'];        // 64 bits away: a different screen

  /** A loop whose capture hashes to whatever the test last set. */
  function gated(cfgOver = {}) {
    let hashes = SAME;
    const h = build({ cfg: cfgOver, deps: { hashFrames: () => hashes } });
    h.setHashes = v => { hashes = v; };
    return h;
  }

  test('an unchanged screen in the same app skips the call, logs nothing and counts nothing', async () => {
    const h = gated();
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 1);
    assert.equal(h.checksToday(), 1);

    h.setHashes(NEAR);
    await h.step();                                   // no scripted verdict: a call would throw
    assert.equal(h.calls.analyze.length, 1, 'the call was skipped');
    assert.equal(h.calls.capture, 2, 'the frame is still captured — the hash is made from it');
    assert.equal(h.calls.log.length, 1, 'a skipped tick logs no verdict');
    assert.equal(h.checksToday(), 1, 'and costs nothing against the daily cap');
    assert.equal(h.calls.tasks.length, 1, 'no task gathering either');
    assert.equal(h.live().lastLine, 'no change — code editor and terminal');
    assert.equal(h.live().lastVerdictTs, T0, 'the previous verdict stands');
    assert.equal(h.loop._state.skippedChecks, 1);
  });

  test('a changed screen is checked', async () => {
    const h = gated();
    await h.step(ON());
    h.setHashes(FAR);
    await h.step(OFF());
    assert.equal(h.calls.analyze.length, 2);
    assert.equal(h.live().strikeCount, 1);
  });

  test('a new frontmost app is checked even when the pixels match', async () => {
    const h = gated();
    await h.step(ON());
    h.setFront('Safari');
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2);
    assert.equal(h.live().lastApp, 'Safari');
  });

  test('a real check is forced every forceCheckSec however still the screen is', async () => {
    const h = gated({ forceCheckSec: 180 });
    await h.step(ON());
    const lastCheck = h.loop._state.lastCheckAt;
    h.now = lastCheck + 180000 - 1;
    await h.step();
    assert.equal(h.calls.analyze.length, 1, 'one millisecond early: still skipped');
    h.now = lastCheck + 180000;
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2, 'forced');
  });

  test('while alerting nothing is ever skipped: a gray screen must be able to clear itself', async () => {
    const h = gated();
    await h.step(OFF());
    h.setHashes(FAR);                                 // a real change, so the second strike lands
    await h.step(OFF());
    assert.equal(h.live().alerting, true, 'precondition: alert on');
    assert.equal(h.calls.analyze.length, 2);

    // The screen now matches the last real check exactly — and is still checked.
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 3, 'checked despite an identical screen');
    assert.equal(h.live().alerting, false);
    assert.equal(h.calls.gray.at(-1), false);
  });

  test('skips compare against the last REAL check, so slow drift still adds up', async () => {
    const h = gated();
    await h.step(ON());
    h.setHashes(DRIFT);
    await h.step();
    assert.equal(h.calls.analyze.length, 1, '2 bits: skipped');
    h.setHashes(['0f0f0f0f0f0f0f00']);                // 4 bits from the last real check
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2, 'the reference never moved on a skip');
  });

  test('a display appearing or disappearing is a change', async () => {
    const h = gated();
    await h.step(ON());
    h.setHashes([...SAME, ...SAME]);
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2);
  });

  test('a skipped tick leaves the strike count alone', async () => {
    const h = gated();
    await h.step(OFF());
    assert.equal(h.live().strikeCount, 1);
    await h.step();
    assert.equal(h.calls.analyze.length, 1);
    assert.equal(h.live().strikeCount, 1, 'the previous verdict stands, it is not re-counted');
    assert.equal(h.live().alerting, false);
  });

  test('changeGating: false never skips', async () => {
    const h = gated({ changeGating: false });
    await h.step(ON());
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2);
  });

  test('without hashes (the default) nothing is gated', async () => {
    const h = build();
    await h.step(ON());
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2);
  });

  test('a config change forces the next check', async () => {
    const h = gated();
    await h.step(ON());
    h.loop.reload();
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 2, 'the reference frame was dropped');
  });
});

describe('13. the hosted plan', () => {
  const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
  const DEVICE = 'a'.repeat(32);
  const serviceErr = (kind, message) => Object.assign(new Error(message || kind), { kind });

  /** A loop on the hosted path, with a recording stand-in for src/account.js. */
  function hosted({ cfg = {}, snapshot = {}, deps = {} } = {}) {
    const calls = { noteCheck: [], noteProblem: [] };
    const snap = {
      plan: 'monthly', status: 'active',
      usage: { checksUsed: 12, checksIncluded: 15000, periodEnd: null },
      hasLicense: true, licenseMasked: 'gry_live_…CB6D', problem: null, needsSubscription: false,
      ...snapshot
    };
    const account = {
      getLicense: () => LICENSE,
      deviceId: () => DEVICE,
      snapshot: () => snap,
      noteCheck: s => { calls.noteCheck.push(s); snap.needsSubscription = false; },
      noteProblem: k => { calls.noteProblem.push(k); snap.problem = k; snap.needsSubscription = true; }
    };
    const h = build({
      cfg: { provider: 'grayout', ...cfg },
      deps: {
        secrets: { getApiKey: () => null, getCanvasToken: () => '' },
        requiresKey: () => false,
        account,
        ...deps
      }
    });
    h.acct = { calls, snap, account };
    return h;
  }

  const hostedOff = () => ({
    verdict: v(true), engine: 'api', usage: null, model: 'grayout',
    service: { plan: 'active', usage: { checksUsed: 14, checksIncluded: 15000, periodEnd: null } }
  });

  const hostedOk = (plan = 'active') => ({
    verdict: v(false), engine: 'api', usage: null, model: 'grayout',
    service: { plan, usage: { checksUsed: 13, checksIncluded: 15000, periodEnd: '2026-10-22T00:00:00Z' } }
  });

  test('the license and the device id ride along instead of a model key', async () => {
    const h = hosted();
    await h.step(hostedOk());
    const { ctx } = h.calls.analyze[0];
    assert.equal(ctx.apiKey, null);
    assert.equal(ctx.license, LICENSE);
    assert.equal(ctx.deviceId, DEVICE);
    assert.equal(h.live().needsKey, false, 'the hosted path never asks for an API key');
    assert.equal(h.calls.log[0].model, 'grayout');
    assert.equal(h.calls.log[0].cost, null, 'no model bill to meter');
    assert.equal(JSON.stringify(h.calls.log[0]).includes('gry_live'), false);
  });

  test('a good check hands the plan and the counters to the account', async () => {
    const h = hosted();
    await h.step(hostedOk('trialing'));
    assert.deepEqual(h.acct.calls.noteCheck, [{ plan: 'trialing', usage: { checksUsed: 13, checksIncluded: 15000, periodEnd: '2026-10-22T00:00:00Z' } }]);
    assert.equal(h.live().needsSubscription, false);
  });

  test('getLive carries the plan facts the tray and the windows print', async () => {
    const h = hosted();
    await h.step(hostedOk());
    const live = h.live();
    assert.equal(live.plan, 'monthly');
    assert.equal(live.status, 'active');
    assert.equal(live.checksUsed, 12);
    assert.equal(live.checksIncluded, 15000);
    assert.equal(live.needsSubscription, false);
    assert.equal(JSON.stringify(live).includes(LICENSE), false, 'never the key itself');
  });

  test('a loop with no account reports nulls rather than inventing a plan', async () => {
    const h = build();
    await h.step(ON());
    const live = h.live();
    assert.deepEqual([live.plan, live.status, live.checksUsed, live.checksIncluded], [null, null, null, null]);
    assert.equal(live.needsSubscription, false);
  });

  test('every plan problem says what to do, backs off 15 minutes and tells the account', async t => {
    t.mock.method(console, 'error', () => {});
    const cases = {
      no_license: 'subscription needed — open Settings to subscribe',
      trial_expired: 'trial ended — subscribe in Settings',
      subscription_inactive: 'subscription paused — update payment to resume',
      free_exhausted: 'free checks used up — subscribe in Settings',
      quota_exceeded: 'monthly checks used up — resumes next period',
      key_rejected: 'license key was not accepted — open Settings'
    };
    for (const [kind, line] of Object.entries(cases)) {
      const h = hosted();
      const at = h.now;
      await h.step({ throw: serviceErr(kind) });
      assert.equal(h.live().errorKind, kind, kind);
      assert.equal(h.live().lastLine, line, kind);
      assert.equal(h.live().needsSubscription, true, kind);
      assert.equal(h.live().backoffUntil, at + 15 * MIN, kind);
      assert.deepEqual(h.acct.calls.noteProblem, [kind], kind);
      assert.equal(h.live().needsKey, false, kind);
      // Inside the backoff nothing is sent again.
      await h.step();
      assert.equal(h.calls.analyze.length, 1, kind);
    }
  });

  test('a billing state never leaves the Mac gray', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    await h.step(hostedOff());
    await h.step(hostedOff());
    assert.equal(h.live().alerting, true, 'precondition: alert on');
    await h.step({ throw: serviceErr('free_exhausted') });
    assert.equal(h.live().alerting, false, 'one failure is enough when it is a plan problem');
    assert.equal(h.calls.gray.at(-1), false);
    assert.equal(h.live().lastLine, 'free checks used up — subscribe in Settings');
  });

  test('a good check clears the flag again', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    await h.step({ throw: serviceErr('subscription_inactive') });
    assert.equal(h.live().needsSubscription, true);
    h.loop.reload();                                  // activating a license reloads the loop
    assert.equal(h.live().needsSubscription, true, 'the account still says so until a check proves otherwise');
    h.acct.snap.needsSubscription = false;
    h.acct.snap.problem = null;
    await h.step(hostedOk());
    assert.equal(h.live().needsSubscription, false);
    assert.equal(h.live().errorKind, null);
  });

  test('a busy service still uses the ordinary backoff ladder', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    const at = h.now;
    await h.step({ throw: serviceErr('rate_limited', 'Slow down.') });
    assert.equal(h.live().backoffUntil, at + 30000);
    assert.equal(h.live().needsSubscription, false, 'busy is not a plan problem');
    assert.match(h.live().lastLine, /^Grayout busy — retrying at /);
  });

  test('a self-hosted key still gets the v1 wording', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build();                                // default deps: an Anthropic key
    await h.step({ throw: Object.assign(new Error('nope'), { kind: 'key_rejected' }) });
    assert.equal(h.live().lastLine, 'Anthropic rejected the API key — fix in Settings');
    assert.equal(h.live().needsSubscription, false);
  });
});

describe('escape hatches', () => {
  test('previewGray shows the consequence, then proves the restore path', async () => {
    const h = build();
    const p = h.loop.previewGray(30);
    await helpers.turns(2);
    assert.equal(h.calls.gray.at(-1), true);
    assert.equal(h.calls.paint.at(-1), true);
    assert.equal(h.live().alerting, false, 'a preview is not an alert');
    const r = await p;
    assert.equal(r, true, 'returns grayscale.available()');
    assert.equal(h.calls.forceOff, 1);
    assert.equal(h.calls.paint.at(-1), false);
    assert.equal(h.loop._state.previewing, false);
    assert.equal(h.live().lastLine, 'color restored');
    // A following tick does not re-gray.
    await h.step(ON());
    assert.equal(h.calls.gray.at(-1), false);
  });

  test('previewGray reports a missing helper', async () => {
    const h = build();
    h.deps.grayscale.available = () => false;
    assert.equal(await h.loop.previewGray(1), false);
    assert.equal(h.calls.forceOff, 1);
  });

  test('restoreColor works while paused (and in any state)', async () => {
    const h = build();
    await h.fire();
    await h.loop.pause();
    // Simulate a display left gray by a dropped command while paused.
    h.loop._state.alerting = true;
    h.loop._state.strikeCount = 2;
    h.loop.restoreColor();
    assert.equal(h.live().paused, true, 'still paused');
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().strikeCount, 0);
    assert.equal(h.calls.forceOff, 1);
    assert.equal(h.calls.paint.at(-1), false);
    assert.equal(h.live().lastLine, 'color restored');
    h.loop.setLocked(true);
    h.loop.restoreColor();
    assert.equal(h.calls.forceOff, 2);
  });

  test('restoreColor during an alert; the next off verdict starts strikes from zero', async () => {
    const h = build();
    await h.fire();
    h.loop.restoreColor();
    assert.equal(h.live().alerting, false);
    await h.step(OFF());
    assert.equal(h.live().strikeCount, 1);
    assert.equal(h.live().alerting, false);
  });
});

describe('timer, status and lifecycle', () => {
  test('start/stop/reload use the injected timer with checkIntervalSec', () => {
    const h = build();
    h.loop.start();
    assert.deepEqual(h.calls.timers, [45000]);
    assert.equal(h.live().running, true);
    h.cfg.checkIntervalSec = 90;
    h.loop.reload();
    assert.deepEqual(h.calls.timers, [45000, 90000]);
    assert.equal(h.calls.cleared, 1);
    h.loop.stop();
    assert.equal(h.live().running, false);
    assert.equal(h.calls.cleared, 2);
    h.loop.reload();
    assert.equal(h.calls.timers.length, 2, 'reload does not start a stopped loop');
  });

  test('onStatus fires with the live snapshot; getLive has the documented keys', async () => {
    const seen = [];
    const h = build({ deps: { onStatus: live => seen.push(live) } });
    await h.step(ON());
    assert.ok(seen.length >= 1);
    const keys = Object.keys(h.live()).sort();
    for (const k of ['paused', 'pausedUntil', 'locked', 'alerting', 'alertSince', 'strikeCount', 'lastLine', 'lastActivity', 'lastApp', 'lastVerdictTs', 'lastCheckAt', 'needsScreenPermission', 'needsKey', 'capHit', 'graceUntil', 'backoffUntil', 'errorKind', 'analyzing', 'running']) {
      assert.ok(keys.includes(k), k);
    }
    assert.equal(h.live().lastCheckAt, T0);
    assert.equal(JSON.stringify(h.live()).includes(KEY), false);
  });

  test('a throwing onStatus or overlays.paint never breaks a tick', async () => {
    const h = build({ deps: { onStatus: () => { throw new Error('ui gone'); }, overlays: { paint: () => { throw new Error('no window'); } } } });
    await h.fire();
    assert.equal(h.live().alerting, true);
  });

  test('destroy() stops the timer and makes tick a no-op', async () => {
    const h = build();
    h.loop.start();
    h.loop.destroy();
    assert.equal(h.live().running, false);
    await h.step(ON());
    assert.equal(h.calls.capture, 0);
  });

  test('createLoop defaults let a bare loop tick without any deps beyond config/capture/analyze', async () => {
    const loop = createLoop({ config: () => ({ ...DEFAULT_CONFIG }), capture: async () => ({ images: ['x'], blank: false }), analyze: async () => ON() });
    await loop.tick();
    assert.equal(loop.getLive().needsKey, true, 'default secrets have no key');
  });
});
