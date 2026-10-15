'use strict';
// Mocked end-to-end tests of the watch loop state machine (BUILD-SPEC §23).
// Every dependency is a fake that records calls; time is a fake clock.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('loop');
const {
  createLoop, BACKOFF_STEPS_MS, TICK_HARD_LIMIT_MS, OVERAGE_FALLBACK_MS, CONFIG_INVALID_LINE, CLI_MISSING_LINE,
  DAILY_BUDGET_LINE, NOT_CONNECTED_LINE, UNREGISTERED_LINE, SECRETS_LOCKED_LINE, SUBSCRIPTION_LINES, FRONT_UNKNOWN_LINE
} = require('../src/loop');
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

  test('an unknown front app (null) with an empty Never capture list is captured and logged as null', async () => {
    const h = build({ cfg: { neverCaptureApps: [] } });
    h.setFront(null);
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.calls.log[0].app, null);
  });

  test('an unknown front app with a Never capture list fails closed: no capture, strikes and alert untouched', async t => {
    const errors = t.mock.method(console, 'error', () => {});
    const h = build();
    assert.ok(h.cfg.neverCaptureApps.length > 0, 'the default list has password managers');
    await h.step(OFF());
    assert.equal(h.live().strikeCount, 1);
    h.setFront(null);
    await h.step();
    await h.step();
    assert.equal(h.calls.capture, 1, 'nothing captured while the front app is unknown');
    assert.equal(h.calls.analyze.length, 1);
    assert.equal(h.calls.webcam, 0);
    assert.equal(h.live().strikeCount, 1);
    assert.equal(h.live().lastLine, FRONT_UNKNOWN_LINE);
    assert.equal(/—/.test(FRONT_UNKNOWN_LINE), false, 'no em dash');
    assert.equal(h.live().lastApp, null);
    assert.equal(errors.mock.calls.length, 1, 'logged once per stretch, not every tick');
    // Known again: behaves exactly as before.
    h.setFront('Code');
    await h.step(OFF());
    assert.equal(h.calls.capture, 2);
    assert.equal(h.live().alerting, true, 'the earlier strike still counted');
    h.setFront(null);
    await h.step();
    assert.equal(h.live().alerting, true, 'alert held, like a Never capture app');
    assert.equal(h.calls.capture, 2);
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

  test('CLI logged out: cli_auth line says claude auth login, no needsKey, no provider of the stored key, 15-min backoff', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build({ deps: { engine: () => 'cli', requiresKey: () => false, secrets: { getApiKey: () => 'sk-proj-openai-key-stored', getCanvasToken: () => '' } } });
    await h.step({ throw: Object.assign(new Error('Claude CLI is not logged in (Invalid API key · Please run /login). Run claude auth login in Terminal.'), { kind: 'cli_auth' }) });
    const live = h.live();
    assert.equal(live.errorKind, 'cli_auth');
    assert.equal(live.lastLine, 'Claude CLI is logged out — run claude auth login in Terminal');
    assert.equal(live.needsKey, false, 'never sends the person to API-key setup');
    assert.equal(/API key|OpenAI|Anthropic|Grayout|subscri/.test(live.lastLine), false);
    assert.equal(live.backoffUntil, T0 + 15 * MIN);
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 1, 'no retry inside the backoff');
    assert.equal(h.live().lastLine, 'Claude CLI is logged out — run claude auth login in Terminal', 'the line survives the backoff');
    h.script.push(ON());
    await h.loop.checkNow(); // after logging in, Check now retries at once
    assert.equal(h.calls.analyze.length, 2);
    assert.equal(h.live().errorKind, null);
  });

  test('CLI logged out behind a wrapper: the line and live.cliLogin carry the wrapper\'s advice', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build({ deps: { engine: () => 'cli', requiresKey: () => false } });
    const login = { command: 'claude-accounts status', text: 'run claude-accounts status in Terminal, then claude-accounts login <account>' };
    await h.step({ throw: Object.assign(new Error('Claude CLI is not logged in (Not logged in).'), { kind: 'cli_auth', login }) });
    assert.equal(h.live().lastLine, 'Claude CLI is logged out — run claude-accounts status in Terminal, then claude-accounts login <account>');
    assert.deepEqual(h.live().cliLogin, login);
    h.now = h.live().backoffUntil;
    await h.step(ON());
    assert.equal(h.live().cliLogin, null, 'cleared by the next good check');
    await h.step({ throw: Object.assign(new Error('Claude CLI is not logged in'), { kind: 'cli_auth' }) });
    assert.deepEqual(h.live().cliLogin, { command: 'claude auth login', text: 'run claude auth login in Terminal' }, 'no advice on the error: the plain claude one');
  });

  test('CLI timeout: stepped backoff with its own line, not an error retried every tick', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build({ deps: { engine: () => 'cli', requiresKey: () => false } });
    const timeout = () => ({ throw: Object.assign(new Error('claude CLI exceeded 90s — check abandoned'), { kind: 'network', timeout: true }) });
    await h.step(timeout());
    assert.equal(h.live().errorKind, 'network');
    assert.equal(h.live().backoffUntil, T0 + BACKOFF_STEPS_MS[0]);
    assert.match(h.live().lastLine, /^Claude CLI timed out — retrying at /);
    h.now = T0 + 20000;
    await h.loop.tick();
    assert.equal(h.calls.analyze.length, 1, 'a tick inside the backoff waits instead of starting another 90 s CLI');
    h.now = T0 + BACKOFF_STEPS_MS[0];
    await h.step(timeout());
    assert.equal(h.live().backoffUntil, T0 + BACKOFF_STEPS_MS[0] + BACKOFF_STEPS_MS[1], 'and the steps grow');
  });

  test('CLI not found: cli_missing line points at cliPath', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build({ deps: { engine: () => 'cli', requiresKey: () => false } });
    await h.step({ throw: Object.assign(new Error('Claude CLI not found'), { kind: 'cli_missing' }) });
    assert.equal(h.live().errorKind, 'cli_missing');
    assert.equal(h.live().lastLine, CLI_MISSING_LINE);
    assert.equal(h.live().lastLine, 'Claude CLI not found — install Claude Code or set cliPath in config.json');
    assert.equal(h.live().needsKey, false);
    assert.equal(h.live().backoffUntil, T0 + 15 * MIN);
    await h.step(ON());
    assert.equal(h.live().lastLine, CLI_MISSING_LINE, 'the line survives the backoff');
  });

  test('CLI usage limit: stepped backoff, the reset time is reported, an earlier reset is honored', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build({ deps: { engine: () => 'cli', requiresKey: () => false } });
    // As classifyCliFailure builds it: resetsAt in epoch ms, retryAfter in seconds (the service's unit).
    const limit = resetsAt => ({ throw: Object.assign(new Error("claude CLI: You've hit your limit"), {
      kind: 'rate_limited', limit: true, resetsAt, retryAfter: resetsAt ? Math.ceil((resetsAt - h.now) / 1000) : null
    }) });
    await h.step(limit(T0 + 3 * 60 * MIN));
    let live = h.live();
    assert.equal(live.errorKind, 'rate_limited');
    assert.equal(live.backoffUntil, T0 + BACKOFF_STEPS_MS[0], 'a later reset is not waited for: a refused call costs no usage and the login may change first');
    assert.match(live.lastLine, /^Claude usage limit reached \(resets .+\) — retrying at /);
    assert.equal(live.needsKey, false);

    h.now = live.backoffUntil;
    const soon = h.now + 10000;
    await h.step(limit(soon));
    assert.equal(h.live().backoffUntil, soon, 'a reset sooner than the next step is the retry time');

    h.now = soon;
    await h.step(limit(null));
    assert.match(h.live().lastLine, /^Claude usage limit reached — retrying at /);
  });

  test('CLI errors never name the stored key\'s provider', async t => {
    t.mock.method(console, 'error', () => {});
    const h = build({ deps: { engine: () => 'cli', requiresKey: () => false, secrets: { getApiKey: () => 'sk-proj-openai-key-stored', getCanvasToken: () => '' } } });
    await h.step({ throw: Object.assign(new Error('claude CLI: API Error: 529 Overloaded'), { kind: 'overloaded' }) });
    assert.match(h.live().lastLine, /^Claude busy — retrying at /);
    h.now = h.live().backoffUntil;
    await h.step({ throw: Object.assign(new Error('claude CLI: issue with the selected model'), { kind: 'bad_model' }) });
    assert.equal(h.live().lastLine, 'model not available on this Claude account — check config.json');
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
    await h.step(ok(v(false), { usage: null, model: undefined }));
    assert.equal(h.calls.log[0].cost, null);
    assert.equal(h.calls.log[0].usage, null);
    assert.equal(h.calls.log[0].engine, 'api');
    assert.equal(h.calls.log[0].model, 'claude-haiku-4-5');
    await h.step(ok(v(false), { model: 'gpt-4o' }));
    assert.equal(h.calls.log[1].cost, null);
    assert.equal(h.calls.log[1].model, 'gpt-4o');
    await h.step(ok(v(false), { usage: { input_tokens: 1000000, output_tokens: 0 }, model: 'claude-haiku-4-5-20251001' }));
    assert.equal(h.calls.log[2].cost, 1);
  });

  test('a CLI check costs 0 (subscription), logs its tokens, engine and provider', async () => {
    const h = build({ deps: { engine: () => 'cli' } });
    await h.step(ok(v(false), { engine: 'cli', provider: 'claude-cli', usage: { input_tokens: 2086, output_tokens: 53 } }));
    const row = h.calls.log[0];
    assert.equal(row.cost, 0, 'no fake dollar figure for a flat-rate plan');
    assert.equal(row.engine, 'cli');
    assert.equal(row.provider, 'claude-cli');
    assert.equal(row.model, 'claude-haiku-4-5');
    assert.deepEqual(row.usage, { input_tokens: 2086, output_tokens: 53 });
    await h.step(ok(v(false), { engine: 'cli', provider: 'claude-cli', usage: null }));
    assert.equal(h.calls.log[1].cost, 0);
  });

  test('a CLI check billed as overage is priced like the API', async () => {
    const h = build({ deps: { engine: () => 'cli' } });
    await h.step(ok(v(false), { engine: 'cli', provider: 'claude-cli', usage: { input_tokens: 1000000, output_tokens: 0, overage: true } }));
    assert.equal(h.calls.log[0].cost, 1);
  });

  test('overage: the paid check is logged, then checks stop until the plan limit resets and color returns', async () => {
    const h = build({ deps: { engine: () => 'cli', requiresKey: () => false } });
    const paid = (verdict, resetsAt) => ok(verdict, { engine: 'cli', provider: 'claude-cli', usage: { input_tokens: 1000000, output_tokens: 0, overage: true }, overage: { resetsAt } });
    await h.step(ok(v(true), { engine: 'cli' }));
    const resets = T0 + 3 * 60 * MIN;
    await h.step(paid(v(true), resets)); // would have been strike 2
    const live = h.live();
    assert.equal(h.calls.log.length, 2);
    assert.equal(h.calls.log[1].cost, 1, 'the one paid check shows its cost');
    assert.equal(live.alerting, false, 'not grayed while nothing is being watched');
    assert.equal(live.strikeCount, 0);
    assert.equal(live.backoffUntil, resets, 'waits for the reset, not the 30 s step');
    assert.equal(live.errorKind, 'rate_limited');
    assert.match(live.lastLine, /^Claude plan limit reached — checks paused until .+ to avoid paid extra usage$/);
    for (let i = 0; i < 10; i++) await h.step(ON());
    assert.equal(h.calls.analyze.length, 2, 'no more paid checks');
    assert.match(h.live().lastLine, /extra usage/, 'the line survives the wait');
    h.now = resets;
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 3, 'checks resume at the reset');
    assert.equal(h.live().errorKind, null);
  });

  test('overage with no readable reset: waits OVERAGE_FALLBACK_MS', async () => {
    const h = build({ deps: { engine: () => 'cli', requiresKey: () => false } });
    await h.step(ok(v(false), { engine: 'cli', usage: { input_tokens: 10, output_tokens: 1, overage: true }, overage: { resetsAt: null } }));
    assert.equal(h.live().backoffUntil, T0 + OVERAGE_FALLBACK_MS);
    const h2 = build({ deps: { engine: () => 'cli', requiresKey: () => false } });
    await h2.step(ok(v(false), { engine: 'cli', usage: { input_tokens: 10, output_tokens: 1, overage: true }, overage: { resetsAt: T0 - MIN } }));
    assert.equal(h2.live().backoffUntil, T0 + OVERAGE_FALLBACK_MS, 'a reset in the past is not a reset');
  });

  test('overage with cliAllowOverage: checks keep running and keep being priced', async () => {
    const h = build({ cfg: { cliAllowOverage: true }, deps: { engine: () => 'cli', requiresKey: () => false } });
    const paid = () => ok(v(true), { engine: 'cli', usage: { input_tokens: 1000000, output_tokens: 0, overage: true }, overage: { resetsAt: T0 + 60 * MIN } });
    await h.step(paid());
    await h.step(paid());
    assert.equal(h.live().alerting, true);
    assert.equal(h.live().backoffUntil, 0);
    assert.deepEqual(h.calls.log.map(r => r.cost), [1, 1]);
  });

  test('an API row logs the provider when the analyzer names it', async () => {
    const h = build();
    await h.step(ok(v(false), { provider: 'openai', model: 'gpt-5-mini' }));
    assert.equal(h.calls.log[0].provider, 'openai');
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
  const serviceErr = (kind, message, extra = {}) => Object.assign(new Error(message || kind), { kind }, extra);

  /** A loop on the hosted path, with a recording stand-in for src/account.js. */
  function hosted({ cfg = {}, snapshot = {}, deps = {}, connected = true } = {}) {
    const calls = { noteCheck: [], noteProblem: [] };
    const snap = {
      configured: connected,
      plan: 'active', status: 'active', interval: 'monthly', service: true,
      usage: { checksUsed: 12, checksIncluded: 10000, periodEnd: null, resetsAt: '2026-11-01T00:00:00Z' },
      hasLicense: true, licenseMasked: 'gry_live_…CB6D', problem: null, needsSubscription: false,
      ...snapshot
    };
    const account = {
      configured: () => connected,
      getLicense: () => LICENSE,
      check: async () => { throw new Error('the loop must not call the service itself'); },
      snapshot: () => snap,
      noteCheck: s => { calls.noteCheck.push(s); snap.needsSubscription = false; },
      noteProblem: (k, detail) => { calls.noteProblem.push(detail && detail.reason ? [k, detail.reason] : k); snap.problem = k; snap.needsSubscription = k !== 'quota_exceeded'; }
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
    service: { plan: 'active', usage: { checksUsed: 14, checksIncluded: 10000, periodEnd: null } }
  });

  const hostedOk = (plan = 'active') => ({
    verdict: v(false), engine: 'api', usage: null, model: 'grayout',
    service: { plan, service: true, usage: { checksUsed: 13, checksIncluded: 10000, periodEnd: '2026-10-22T00:00:00Z' } }
  });

  test('the account client rides along instead of a model key; the key and token never pass through the loop', async () => {
    const h = hosted();
    await h.step(hostedOk());
    const { ctx } = h.calls.analyze[0];
    assert.equal(ctx.apiKey, null);
    assert.equal(ctx.account, h.acct.account, 'the analyzer asks the account client, which adds the identity itself');
    assert.equal('license' in ctx, false);
    assert.equal('deviceId' in ctx, false);
    assert.equal('deviceToken' in ctx, false);
    assert.equal(h.live().needsKey, false, 'the hosted path never asks for an API key');
    assert.equal(h.calls.log[0].model, 'grayout');
    assert.equal(h.calls.log[0].cost, null, 'no model bill to meter');
    assert.equal(JSON.stringify(h.calls.log[0]).includes('gry_live'), false);
  });

  test('a good check hands the plan and the counters to the account', async () => {
    const h = hosted();
    await h.step(hostedOk('trialing'));
    assert.deepEqual(h.acct.calls.noteCheck, [{ plan: 'trialing', service: true, usage: { checksUsed: 13, checksIncluded: 10000, periodEnd: '2026-10-22T00:00:00Z' } }]);
    assert.equal(h.live().needsSubscription, false);
  });

  test('getLive carries the plan facts the tray and the windows print', async () => {
    const h = hosted();
    await h.step(hostedOk());
    const live = h.live();
    assert.equal(live.plan, 'active');
    assert.equal(live.status, 'active');
    assert.equal(live.checksUsed, 12);
    assert.equal(live.checksIncluded, 10000);
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

  test('every plan problem says what to do, stops calling and tells the account', async t => {
    t.mock.method(console, 'error', () => {});
    const cases = {
      no_license: "this Mac's license key is missing — paste it in Settings",
      license_invalid: 'license key was not accepted — open Settings',
      license_revoked: 'subscription was refunded or disputed — see Settings',
      trial_expired: 'trial ended — subscribe in Settings',
      subscription_inactive: 'subscription not active — update payment in Settings or at link.com',
      free_exhausted: 'free checks used up — subscribe in Settings'
    };
    for (const [kind, line] of Object.entries(cases)) {
      const h = hosted();
      await h.step({ throw: serviceErr(kind) });
      assert.equal(h.live().errorKind, kind, kind);
      assert.equal(h.live().lastLine, line, kind);
      assert.equal(h.live().needsSubscription, true, kind);
      assert.deepEqual(h.acct.calls.noteProblem, [kind], kind);
      assert.equal(h.live().needsKey, false, kind);
      // Inside the wait nothing is sent again, and the line stays readable.
      await h.step();
      assert.equal(h.calls.analyze.length, 1, kind);
      assert.equal(h.live().lastLine, line, `${kind}: not replaced by "waiting — retrying at"`);
    }
  });

  test('a refusal that can change from outside (a card fixed at link.com) is retried after 15 minutes', async t => {
    t.mock.method(console, 'error', () => {});
    for (const kind of ['no_license', 'trial_expired', 'subscription_inactive']) {
      const h = hosted();
      const at = h.now;
      await h.step({ throw: serviceErr(kind) });
      assert.equal(h.live().planHold, false, kind);
      assert.equal(h.live().backoffUntil, at + 15 * MIN, kind);
      h.now = at + 15 * MIN;
      await h.step(hostedOk());
      assert.equal(h.calls.analyze.length, 2, `${kind}: asked again once the 15 minutes were up`);
      assert.equal(h.live().needsSubscription, false, kind);
    }
  });

  test('a refusal that cannot change on its own holds until reload(): no screenshot is taken or sent', async t => {
    // Regression: free_exhausted (this device), license_revoked and
    // license_invalid used to be retried every 15 minutes forever, capturing
    // and uploading the screen ~96 times a day just to be refused.
    t.mock.method(console, 'error', () => {});
    for (const [kind, extra] of [['free_exhausted', { reason: 'device' }], ['free_exhausted', {}], ['license_revoked', {}], ['license_invalid', {}]]) {
      const h = hosted();
      await h.step({ throw: serviceErr(kind, kind, extra) });
      assert.equal(h.live().planHold, true, kind);
      assert.equal(h.calls.capture, 1, kind);
      const line = h.live().lastLine;
      // A whole day later, still nothing captured or sent.
      h.advance(24 * 60 * MIN);
      await h.step();
      await h.step();
      assert.equal(h.calls.capture, 1, `${kind}: no capture while held`);
      assert.equal(h.calls.analyze.length, 1, `${kind}: no request while held`);
      assert.equal(h.live().lastLine, line, kind);
      assert.equal(h.live().needsSubscription, true, kind);
      // "Check now" alone does not lift it: only a change to the plan does.
      await h.loop.checkNow();
      assert.equal(h.calls.analyze.length, 1, `${kind}: Check now does not re-send a refused plan`);
      // A new key, a purchase or a restore reloads the loop: one real check.
      h.loop.reload();
      await h.step(hostedOk());
      assert.equal(h.calls.analyze.length, 2, `${kind}: reload lifts the hold`);
      assert.equal(h.live().planHold, false, kind);
    }
  });

  test('the shared daily budget is not held: it comes back after midnight UTC', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted({ snapshot: { hasLicense: false, status: 'free' } });
    await h.step({ throw: serviceErr('free_exhausted', 'Paused for today.', { reason: 'daily_budget' }) });
    assert.equal(h.live().planHold, false);
    assert.ok(h.live().backoffUntil > h.now);
  });

  test('clearPlanHold: a fresh "served" answer lifts a plan wait at once; other waits are left alone', async t => {
    // Regression: after fixing a card at link.com and opening Settings, the
    // panel said Subscribed while the loop sat out its 15-minute wait.
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    await h.step({ throw: serviceErr('subscription_inactive') });
    assert.ok(h.live().backoffUntil > h.now);
    // What /v1/status does first: the account forgets the refusal.
    h.acct.snap.problem = null;
    h.acct.snap.needsSubscription = false;
    assert.equal(h.loop.clearPlanHold(), true);
    assert.equal(h.live().needsSubscription, false, 'the menu bar stops saying "needs attention"');
    assert.equal(h.live().backoffUntil, 0);
    assert.equal(h.live().errorKind, null);
    await h.step(hostedOk());
    assert.equal(h.calls.analyze.length, 2, 'checked again straight away');

    const held = hosted();
    await held.step({ throw: serviceErr('license_revoked') });
    assert.equal(held.loop.clearPlanHold(), true);
    assert.equal(held.live().planHold, false);

    const busy = hosted();
    await busy.step({ throw: serviceErr('rate_limited', 'Slow down.', { retryAfter: 120 }) });
    const until = busy.live().backoffUntil;
    assert.equal(busy.loop.clearPlanHold(), false, 'nothing to lift');
    assert.equal(busy.live().backoffUntil, until, 'a rate-limit wait is not the plan\'s to lift');
  });

  test('somebody who already paid is never told to subscribe (no_license)', () => {
    assert.equal(/subscribe/i.test(require('../src/loop').SUBSCRIPTION_LINES.no_license), false);
  });

  test('free checks paused for everybody today: wait until midnight UTC, and this Mac\'s meter is not filled', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted({ snapshot: { hasLicense: false, status: 'free' } });
    await h.step({ throw: serviceErr('free_exhausted', 'Paused for today.', { reason: 'daily_budget' }) });
    assert.equal(h.live().lastLine, DAILY_BUDGET_LINE);
    const d = new Date(T0);
    assert.equal(h.live().backoffUntil, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 60000);
    assert.deepEqual(h.acct.calls.noteProblem, [['free_exhausted', 'daily_budget']]);
    assert.equal(h.live().needsSubscription, true);
  });

  test('past the monthly allowance: wait as told, say until when, and it is not a plan problem', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    const at = h.now;
    await h.step({ throw: serviceErr('quota_exceeded', 'Monthly checks used up.', { retryAfter: 420 }) });
    assert.equal(h.live().backoffUntil, at + 420 * 1000, 'retryAfter is honoured');
    // The reset is 00:00 UTC on the 1st, printed as that UTC date (never "Oct 31" in a US evening).
    const nov1 = new Date(Date.UTC(2026, 10, 1)).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
    assert.equal(h.live().lastLine, `monthly checks used up: checking every 10 minutes until ${nov1}`);
    assert.equal(h.live().needsSubscription, false);
    assert.deepEqual(h.acct.calls.noteProblem, ['quota_exceeded']);
    const h2 = hosted();
    const at2 = h2.now;
    await h2.step({ throw: serviceErr('quota_exceeded') });
    assert.equal(h2.live().backoffUntil, at2 + 10 * MIN, 'no retryAfter: the 10-minute slow interval');
  });

  test('a Mac the service will not register: say so, wait 15 minutes, no plan problem', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    const at = h.now;
    await h.step({ throw: serviceErr('device_unverified', 'Grayout could not register this Mac with the service. Try again later.') });
    assert.equal(h.live().lastLine, UNREGISTERED_LINE);
    assert.equal(h.live().backoffUntil, at + 15 * MIN);
    assert.equal(h.live().needsSubscription, false);
    await h.step();
    assert.equal(h.calls.analyze.length, 1, 'no new registration attempts inside the wait');
  });

  test('saved keys the Keychain will not unlock: say so, wait 15 minutes, no plan problem', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    const at = h.now;
    await h.step({ throw: serviceErr('secrets_locked', 'Grayout could not unlock its saved keys.') });
    assert.equal(h.live().lastLine, SECRETS_LOCKED_LINE);
    assert.equal(h.live().backoffUntil, at + 15 * MIN);
    assert.equal(h.live().needsSubscription, false);
    await h.step();
    assert.equal(h.calls.analyze.length, 1);
  });

  test('a rate limit with retryAfter waits at least that long', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    const at = h.now;
    await h.step({ throw: serviceErr('rate_limited', 'Slow down.', { retryAfter: 120 }) });
    assert.equal(h.live().backoffUntil, at + 120000);
  });

  test('the service missing a setting (not_configured, 503) is treated like a busy service', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted();
    const at = h.now;
    await h.step({ throw: serviceErr('not_configured', 'Billing is not set up.') });
    assert.equal(h.live().backoffUntil, at + 30000);
    assert.match(h.live().lastLine, /^Grayout busy — retrying at /);
    assert.equal(h.live().needsSubscription, false);
  });

  test('a build with no service address takes no screenshot at all and gives the color back', async t => {
    t.mock.method(console, 'error', () => {});
    const h = hosted({ connected: false });
    await h.step();
    assert.equal(h.calls.capture, 0, 'nothing captured');
    assert.equal(h.calls.analyze.length, 0, 'nothing sent');
    assert.equal(h.live().lastLine, NOT_CONNECTED_LINE);
    assert.equal(h.live().errorKind, 'not_connected');
    assert.equal(h.live().alerting, false);
  });

  test('a self-hosted key works in a build with no service address', async () => {
    const h = build({ deps: { account: { configured: () => false, snapshot: () => null } } });   // default deps: an Anthropic key
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.calls.analyze.length, 1);
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

describe('14. the CLI engine next to the hosted service', () => {
  // A stand-in for src/account.js that must never be asked for anything a check needs.
  function cliLoop({ cfg = {}, snapshot = null, connected = false, key = null } = {}) {
    const account = {
      configured: () => connected,
      check: async () => { throw new Error('the CLI engine must never reach the service'); },
      snapshot: () => snapshot,
      noteCheck: () => { throw new Error('no plan facts on the CLI engine'); },
      noteProblem: () => { throw new Error('no plan problems on the CLI engine'); }
    };
    return build({
      cfg: { engine: 'cli', ...cfg },
      deps: { engine: () => 'cli', requiresKey: () => false, account, secrets: { getApiKey: () => key, getCanvasToken: () => '' } }
    });
  }
  const cliOk = (off = false) => ok(v(off), { engine: 'cli', provider: 'claude-cli', usage: { input_tokens: 2086, output_tokens: 53 } });

  test('no key, provider auto, a build with no service address: checks still run through the CLI', async () => {
    const h = cliLoop();
    await h.step(cliOk());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.calls.analyze.length, 1);
    assert.notEqual(h.live().errorKind, 'not_connected');
    assert.notEqual(h.live().lastLine, NOT_CONNECTED_LINE);
    assert.equal(h.live().needsKey, false);
    assert.equal(h.calls.log[0].cost, 0);
  });

  test('provider "grayout" in config.json does not route a CLI check to the service', async () => {
    const h = cliLoop({ cfg: { provider: 'grayout' }, connected: true });
    await h.step(cliOk(true));
    await h.step(cliOk(true));
    assert.equal(h.live().alerting, true, 'verdicts from the CLI drive the alert as usual');
    assert.equal(h.calls.log.length, 2);
  });

  test('change-gating still skips unchanged frames on the CLI engine', async () => {
    const h = build({ cfg: { engine: 'cli' }, deps: { engine: () => 'cli', requiresKey: () => false, hashFrames: () => ['00ff00ff00ff00ff'] } });
    await h.step(cliOk());
    await h.step();
    assert.equal(h.calls.analyze.length, 1, 'an unchanged screen costs no CLI run either');
    assert.match(h.live().lastLine, /^no change/);
  });

  test('an old plan problem from the service never asks a CLI user to subscribe', async () => {
    const h = cliLoop({ connected: true, snapshot: { plan: 'free', status: 'free', usage: { checksUsed: 100, checksIncluded: 100 }, hasLicense: false, problem: 'free_exhausted', needsSubscription: true } });
    await h.step(cliOk());
    const live = h.live();
    assert.equal(live.needsSubscription, false);
    assert.equal(live.plan, null);
    assert.equal(live.checksUsed, null);
  });

  test('CLI errors never take the hosted plan branches, even with provider "grayout"', async t => {
    t.mock.method(console, 'error', () => {});
    const h = cliLoop({ cfg: { provider: 'grayout' }, connected: true });
    await h.step({ throw: Object.assign(new Error('claude CLI: API Error: 529'), { kind: 'overloaded' }) });
    assert.match(h.live().lastLine, /^Claude busy — retrying at /, 'Claude, not "Grayout busy"');
    assert.equal(h.live().needsSubscription, false);
    for (const line of Object.values(SUBSCRIPTION_LINES)) assert.notEqual(h.live().lastLine, line);
  });

  test('a CLI usage limit days away is not waited out like the service\'s retryAfter', async t => {
    t.mock.method(console, 'error', () => {});
    const h = cliLoop();
    const resetsAt = T0 + 3 * 24 * 60 * MIN; // a weekly limit
    await h.step({ throw: Object.assign(new Error("claude CLI: You've hit your weekly limit"), { kind: 'rate_limited', limit: true, resetsAt, retryAfter: (resetsAt - T0) / 1000 }) });
    assert.equal(h.live().backoffUntil, T0 + BACKOFF_STEPS_MS[0], 'a failover wrapper may route around it on the next check');
    assert.match(h.live().lastLine, /^Claude usage limit reached \(resets .+\) — retrying at /);
  });
});

describe('escape hatches', () => {
  test('previewGray shows the consequence, then proves the restore path', async () => {
    const h = build();
    // The preview runs on a real timer. 30 ms was flaky when the whole suite
    // ran in parallel: a starved process can let 30 ms pass between two event
    // loop turns, so the color came back before the "it is gray" asserts ran.
    const p = h.loop.previewGray(400);
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

  test('config.json invalid at launch: no capture, no check, color restored; resumes once it parses', async () => {
    let invalid = false;
    const h = build({ deps: { configInvalid: () => invalid } });
    await h.fire();
    invalid = true;
    await h.step(OFF());
    assert.equal(h.live().alerting, false);
    assert.equal(h.live().configInvalid, true);
    assert.equal(h.live().lastLine, CONFIG_INVALID_LINE);
    assert.equal(h.calls.capture, 2);
    assert.equal(h.calls.analyze.length, 2);
    await h.step(OFF());
    assert.equal(h.calls.capture, 2, 'still nothing captured or sent');
    h.script.length = 0;
    invalid = false;
    await h.step(ON());
    assert.equal(h.calls.analyze.length, 3);
    assert.equal(h.live().configInvalid, false);
  });

  test('config.json invalid at launch on the hosted defaults: nothing reaches the service', async () => {
    const account = { configured: () => true, snapshot: () => null, check: async () => { throw new Error('must not be called'); } };
    const h = build({ cfg: { provider: 'auto' }, deps: { configInvalid: () => true, requiresKey: () => false, account, secrets: { getApiKey: () => null, getCanvasToken: () => '' } } });
    await h.step(ON());
    assert.equal(h.calls.capture, 0);
    assert.equal(h.calls.analyze.length, 0);
    assert.equal(h.live().lastLine, CONFIG_INVALID_LINE);
  });

  test('onStatus fires with the live snapshot; getLive has the documented keys', async () => {
    const seen = [];
    const h = build({ deps: { onStatus: live => seen.push(live) } });
    await h.step(ON());
    assert.ok(seen.length >= 1);
    const keys = Object.keys(h.live()).sort();
    for (const k of ['paused', 'pausedUntil', 'locked', 'alerting', 'alertSince', 'strikeCount', 'lastLine', 'lastActivity', 'lastApp', 'lastVerdictTs', 'lastCheckAt', 'needsScreenPermission', 'needsKey', 'capHit', 'graceUntil', 'backoffUntil', 'errorKind', 'cliLogin', 'configInvalid', 'analyzing', 'running']) {
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

describe('consent (5.1.2(i)): never capture or send without the person\'s permission', () => {
  const { NO_CONSENT_LINE } = require('../src/loop');

  test('without consent a tick captures nothing, asks nothing, takes no webcam frame and reads no tasks', async () => {
    const h = build({ cfg: { camera: true }, deps: { hasConsent: () => false } });
    await h.loop.tick();
    await h.loop.checkNow();
    await h.loop.resume();
    assert.equal(h.calls.capture, 0);
    assert.equal(h.calls.analyze.length, 0);
    assert.equal(h.calls.webcam, 0);
    assert.equal(h.calls.tasks.length, 0);
    assert.equal(h.calls.log.length, 0);
    assert.equal(h.checksToday(), 0);
    assert.equal(h.live().lastLine, NO_CONSENT_LINE);
    assert.equal(h.live().needsConsent, true);
  });

  test('anything but a clear yes counts as no, including a throwing answer', async () => {
    for (const hasConsent of [() => undefined, () => 'yes', () => 1, () => { throw new Error('state unreadable'); }]) {
      const h = build({ deps: { hasConsent } });
      await h.loop.tick();
      assert.equal(h.calls.capture, 0, String(hasConsent));
      assert.equal(h.live().needsConsent, true);
    }
  });

  test('withdrawn while gray: the color comes back and checks stop', async () => {
    let allowed = true;
    const h = build({ deps: { hasConsent: () => allowed } });
    await h.fire();
    allowed = false;
    const captures = h.calls.capture;
    await h.step();
    assert.equal(h.live().alerting, false);
    assert.equal(h.calls.gray.at(-1), false);
    assert.equal(h.calls.paint.at(-1), false);
    assert.equal(h.calls.capture, captures, 'no new capture');
    assert.equal(h.live().lastLine, NO_CONSENT_LINE);
  });

  test('withdrawn during the awaits before capture or before the request: nothing more is captured or sent', async () => {
    let allowed = true;
    const h = build({ deps: { hasConsent: () => allowed, getFrontmostApp: async () => { allowed = false; return 'Code'; } } });
    await h.loop.tick();
    assert.equal(h.calls.capture, 0, 'checked again right before capture');

    let allowed2 = true;
    const h2 = build({ deps: { hasConsent: () => allowed2, gatherTasks: async () => { allowed2 = false; return { canvas: [], file: [] }; } } });
    await h2.loop.tick();
    assert.equal(h2.calls.capture, 1);
    assert.equal(h2.calls.analyze.length, 0, 'checked again right before the request');
  });

  test('granted again: the next tick checks as usual', async () => {
    let allowed = false;
    const h = build({ deps: { hasConsent: () => allowed } });
    await h.step();
    assert.equal(h.calls.capture, 0);
    allowed = true;
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.calls.analyze.length, 1);
    assert.equal(h.live().needsConsent, false);
  });

  test('a loop built without hasConsent behaves exactly as before (main.js always passes it)', async () => {
    const h = build();
    await h.step(ON());
    assert.equal(h.calls.capture, 1);
    assert.equal(h.live().needsConsent, false);
  });

  test('"could not create image from display" (screencapture denied, also inside the App Sandbox) still reads as Screen Recording', async () => {
    const h = build();
    h.setCapture(async () => { throw new Error('screencapture exited 1: could not create image from display'); });
    await h.step();
    assert.equal(h.live().needsScreenPermission, true);
    assert.equal(h.live().lastLine, 'needs Screen Recording permission');
  });
});
