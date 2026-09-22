'use strict';
// The watch loop as a state machine with injected dependencies, so the whole
// tick can run under plain Node in tests. main.js wires the real deps.
const { classifyApiError } = require('./analyzer');
const { costUsd } = require('./pricing');
const providers = require('./providers');
const framehash = require('./framehash');

const BILLING_URL = { anthropic: 'console.anthropic.com', openai: 'platform.openai.com' };

// Plan problems on the hosted path. Each needs the person to do something, so
// none of them is retried every tick, and none of them ever leaves the Mac gray.
const SUBSCRIPTION_LINES = {
  no_license: 'subscription needed — open Settings to subscribe',
  key_rejected: 'license key was not accepted — open Settings',
  trial_expired: 'trial ended — subscribe in Settings',
  subscription_inactive: 'subscription paused — update payment to resume',
  free_exhausted: 'free checks used up — subscribe in Settings',
  quota_exceeded: 'monthly checks used up — resumes next period'
};
const SUBSCRIPTION_BACKOFF_MS = 15 * 60000;

// Longer than any single check (API timeout is 60s, CLI 90s). If `analyzing`
// is still set past this, something wedged and we take the lock back rather
// than stalling the loop forever with the alert possibly stuck on.
const TICK_HARD_LIMIT_MS = 150000;
const BACKOFF_STEPS_MS = [30000, 60000, 120000, 300000];
const PERMISSION_RE = /screencapture|could not create image|Screen Recording|produced no file/i;

function createLoop(deps) {
  const d = {
    now: () => Date.now(),
    displays: () => 1,
    notify: () => {},
    onStatus: () => {},
    logVerdict: () => {},
    captureWebcam: async () => null,
    gatherTasks: async () => ({ canvas: [], file: [] }),
    getFrontmostApp: async () => null,
    getIdleSeconds: async () => null,
    overlays: { paint: () => {} },
    grayscale: { set: async () => true, forceOffSync: () => true, available: () => true, usable: () => true },
    secrets: { getApiKey: () => null, getCanvasToken: () => '' },
    requiresKey: () => true,
    // The hosted-service client (src/account.js). Absent in tests and on the
    // self-hosted path, where the loop behaves exactly as it did in v1.
    account: null,
    // Perceptual hashes of this capture, one per display, for change-gating.
    // Null disables gating for this tick, which costs a call and never skips one.
    hashFrames: () => null,
    state: { checksToday: () => 0, bumpChecks: () => 1 },
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: t => clearInterval(t),
    ...deps
  };

  const s = {
    paused: false, pausedUntil: 0, locked: false, wokeAt: 0,
    analyzing: false, analyzingSince: 0,
    alerting: false, alertSince: 0, strikeCount: 0, errorStreak: 0,
    graceUntil: 0, backoffUntil: 0, backoffStep: 0,
    lastLine: 'starting…', lastActivity: '', lastApp: null, lastVerdictTs: 0, lastCheckAt: 0,
    lastIdleRecheckAt: 0, epoch: 0,
    // Change-gating: what the displays looked like, and which app was in front,
    // at the last REAL check. Skipped ticks never update them, so slow drift
    // still adds up to a change instead of hiding forever.
    lastHashes: null, lastHashApp: null, skippedChecks: 0,
    needsSubscription: false,
    // needsScreenPermission is a UI hint set by a capture failure that smelled
    // like permission; screenDenied is the authoritative answer from macOS
    // (fed in by main.js) and is the only thing that stops us capturing.
    needsScreenPermission: false, screenDenied: false, needsKey: false, capHit: false, errorKind: null,
    previewing: false
  };
  let timer = null;
  let destroyed = false;
  // Every tick takes a run id. Only the current owner may release the
  // `analyzing` lock or apply a verdict, so a reclaimed (wedged) tick that
  // finally settles cannot clobber the tick that replaced it.
  let runSeq = 0;

  const cfg = () => d.config();
  const status = () => { try { d.onStatus(getLive()); } catch {} };

  /* ---------------- alert state ----------------
     Idempotent and re-asserted every tick. Deliberately NOT transition-guarded:
     a command that silently fails once must be retried, or the display can stay
     gray while the app believes it is clear. */
  function applyAlertState() {
    const c = cfg();
    const on = s.alerting || s.previewing;
    try { d.overlays.paint(on && c.redFlash); } catch {}
    return d.grayscale.set(on && c.grayscale);
  }

  function setAlert(on, why) {
    const was = s.alerting;
    s.alerting = !!on;
    if (s.alerting && !was) s.alertSince = d.now();
    if (why !== undefined) s.lastLine = s.alerting ? `off task: ${why}` : why;
    const p = applyAlertState();
    status();
    return p;
  }

  function clearAlert(reason) {
    s.alerting = false;
    s.strikeCount = 0;
    if (reason) s.lastLine = reason;
    const p = applyAlertState();
    status();
    return p;
  }

  function isMatch(list, frontApp) {
    if (!frontApp || !Array.isArray(list)) return false;
    const name = String(frontApp).toLowerCase();
    return list.some(a => a && name.includes(String(a).toLowerCase()));
  }

  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
  }

  async function tick() {
    if (destroyed) return;
    const now = d.now();
    const c = cfg();

    if (s.paused) {
      if (s.pausedUntil && now >= s.pausedUntil) { s.paused = false; s.pausedUntil = 0; s.lastLine = 'watching…'; }
      else return;
    }
    if (s.analyzing) {
      if (now - s.analyzingSince < TICK_HARD_LIMIT_MS) return;
      // The previous check is older than any check can legitimately be. Take the
      // lock back AND bump the epoch, so when that check finally settles its
      // verdict is discarded instead of being applied minutes late.
      console.error('[tick] previous check wedged — reclaiming');
      s.analyzing = false;
      s.epoch++;
    }

    const run = ++runSeq;
    const myEpoch = s.epoch;
    const stale = () => s.paused || s.epoch !== myEpoch || destroyed || run !== runSeq;

    s.analyzing = true;
    s.analyzingSince = now;
    try {
      // Self-heal: re-assert what the display should look like every cycle, so a
      // dropped grayscale command or a respawned overlay converges on its own.
      await applyAlertState();

      // Watchdog: color always comes back after maxAlertMinutes, whatever happened.
      if (s.alerting && now - s.alertSince >= c.maxAlertMinutes * 60000) {
        await clearAlert(`color restored after ${c.maxAlertMinutes} min`);
        d.notify('Grayout restored color', `It had been gray for ${c.maxAlertMinutes} minutes. If that was wrong, open the dashboard.`);
      }

      // macOS is not giving us the screen. Do not capture: depending on the
      // macOS version, screencapture either fails or silently returns a
      // desktop-picture-only image, and judging (and paying for) that would be
      // worse than saying plainly that we are blocked.
      if (s.screenDenied) {
        s.strikeCount = 0;
        if (s.alerting) await clearAlert('no screen access — color restored');
        else { s.lastLine = 'needs Screen Recording permission'; status(); }
        return;
      }

      if (s.locked) { s.lastLine = 'screen locked — checks paused'; status(); return; }
      if (s.wokeAt && now - s.wokeAt < c.wakeGraceSec * 1000) { s.lastLine = 'just woke — waiting'; status(); return; }
      if (now < s.backoffUntil) { if (!/retrying|credit|rejected|model/.test(s.lastLine)) s.lastLine = `waiting — retrying at ${fmtTime(s.backoffUntil)}`; status(); return; }

      const apiKey = d.secrets.getApiKey();
      if (!apiKey && d.requiresKey()) {
        s.needsKey = true; s.lastLine = 'API key needed — open Settings';
        if (s.alerting) await clearAlert(s.lastLine);
        status(); return;
      }
      s.needsKey = false;

      // Daily cap: a hard ceiling on spend, resets at local midnight.
      if (d.state.checksToday() >= c.dailyCheckCap) {
        s.capHit = true;
        if (s.alerting) await clearAlert('daily check cap reached');
        s.lastLine = `daily cap of ${c.dailyCheckCap} checks reached — resumes tomorrow`;
        status(); return;
      }
      s.capHit = false;

      // Away from the keyboard: stop paying for checks. The current alert is HELD,
      // not cleared — passive video watching produces no input either, and
      // clearing here would flap gray/color during the exact behaviour we target.
      // Exception: while alerting, still run one check every heldAlertRecheckSec
      // so a wrong gray self-corrects even with no input at all.
      const idle = await d.getIdleSeconds();
      if (stale()) return;
      if (idle !== null && idle >= c.idleSkipSec) {
        const due = s.alerting && now - s.lastIdleRecheckAt >= c.heldAlertRecheckSec * 1000;
        if (!due) {
          s.lastLine = `idle ${idle}s — checks paused${s.alerting ? ' (alert held)' : ''}`;
          s.errorStreak = 0;
          status(); return;
        }
        s.lastIdleRecheckAt = now;
      }

      const frontApp = await d.getFrontmostApp();
      if (stale()) return;
      s.lastApp = frontApp;

      // The lock screen is a real app ("loginwindow"). powerMonitor only tells
      // us about locks that happen after launch, so catch the already-locked case
      // here: nothing to judge, no call to pay for.
      if (frontApp === 'loginwindow') {
        s.strikeCount = 0;
        s.lastLine = 'screen locked — checks paused';
        status(); return;
      }

      if (isMatch(c.neverCaptureApps, frontApp)) {
        s.lastLine = `not watching: ${frontApp}`;
        status(); return;
      }
      if (isMatch(c.alwaysAllowedApps, frontApp)) {
        s.strikeCount = 0;
        s.errorStreak = 0;
        await setAlert(false, `allowlisted: ${frontApp}`);
        return;
      }

      const capture = await d.capture(d.displays());
      if (stale()) return;
      s.needsScreenPermission = false; // we can see the screen again

      // Display asleep or locked: nothing to judge, and no call to pay for.
      if (capture.blank) {
        s.strikeCount = 0;
        s.lastLine = 'screen blank/asleep — skipping';
        s.errorStreak = 0;
        status(); return;
      }

      // Change-gating (docs/API-CONTRACT.md). If every display still looks the
      // way it did at the last real check, and the same app is in front, there
      // is nothing new to judge: skip the call and let the previous verdict
      // stand. Nothing is logged and nothing is counted for a skipped tick.
      //
      // Never while alerting: a gray screen must always be able to clear itself,
      // and the person fixing it may not change enough pixels to beat the hash.
      // A real check happens at least every forceCheckSec regardless.
      let hashes = null;
      try { hashes = d.hashFrames(capture.images); } catch { hashes = null; }
      if (c.changeGating && !s.alerting && hashes && s.lastHashes) {
        const forced = now - s.lastCheckAt >= c.forceCheckSec * 1000;
        if (!forced && frontApp === s.lastHashApp && framehash.unchanged(s.lastHashes, hashes)) {
          s.skippedChecks++;
          s.errorStreak = 0;
          s.lastLine = s.lastActivity ? `no change — ${s.lastActivity}` : 'no change since the last check';
          status(); return;
        }
      }

      const [webcamB64, taskInfo] = await Promise.all([
        c.camera ? d.captureWebcam() : Promise.resolve(null),
        d.gatherTasks(c, d.secrets.getCanvasToken ? d.secrets.getCanvasToken() : '')
      ]);
      if (stale()) return;

      const { verdict, engine, usage, model, service } = await d.analyze({
        screenshotsB64: capture.images,
        webcamB64,
        workDescription: c.workDescription,
        canvasTasks: taskInfo.canvas || [],
        fileTasks: taskInfo.file || [],
        frontApp,
        apiKey,
        // The hosted path sends these instead of a model key.
        license: d.account ? d.account.getLicense() : null,
        deviceId: d.account ? d.account.deviceId() : null
      }, c);
      if (stale()) return;

      s.errorStreak = 0;
      s.backoffStep = 0;
      s.errorKind = null;
      s.needsSubscription = false;
      s.lastCheckAt = d.now();
      // This is now the reference frame for change-gating.
      s.lastHashes = hashes;
      s.lastHashApp = frontApp;
      // The service returns the plan and the month's counters with every check.
      if (service && d.account && d.account.noteCheck) { try { d.account.noteCheck(service); } catch {} }
      s.lastIdleRecheckAt = s.lastCheckAt; // the held-alert recheck clock starts from the last real check

      // Punish only on an unambiguous call, repeated `strikes` times in a row.
      const clearlyOff = verdict.off_task && verdict.confidence === 'high';
      s.strikeCount = clearlyOff ? s.strikeCount + 1 : 0;

      const ts = d.now();
      s.lastVerdictTs = ts;
      s.lastActivity = verdict.activity || '';
      const cost = costUsd(usage, model || c.model);
      d.logVerdict({
        ts, off: verdict.off_task, conf: verdict.confidence,
        activity: verdict.activity, app: frontApp || null,
        displays: capture.images.length, strikes: s.strikeCount, engine,
        model: model || c.model, usage: usage || null, cost: cost === null ? null : Number(cost.toFixed(6))
      });
      d.state.bumpChecks();

      // "I'm working" grace: keep judging and logging, but never fire.
      if (ts < s.graceUntil) {
        await setAlert(false, `${verdict.activity || 'on task'} (not grayed until ${fmtTime(s.graceUntil)})`);
        return;
      }

      if (s.strikeCount >= c.strikes) await setAlert(true, verdict.activity);
      else await setAlert(false, verdict.activity || 'on task');
    } catch (e) {
      if (stale()) return;
      s.errorStreak++;
      // A failed check is not evidence of anything: drop the streak so two
      // sightings minutes apart, with an unobserved gap between them, can't add
      // up to "consecutive".
      s.strikeCount = 0;
      const msg = String(e && e.message || e);
      const denied = PERMISSION_RE.test(msg);
      if (denied) {
        s.needsScreenPermission = true;
        s.lastLine = 'needs Screen Recording permission';
      } else {
        const { kind } = classifyApiError(e);
        s.errorKind = kind;
        const { provider } = providers.resolve(c, d.secrets.getApiKey());
        const who = providers.label(provider);
        const hosted = provider === providers.HOSTED;
        if (hosted && SUBSCRIPTION_LINES[kind]) {
          // A billing state is never a verdict: say what is wrong, stop calling
          // for a while, and give the color back.
          s.needsSubscription = true;
          s.lastLine = SUBSCRIPTION_LINES[kind];
          s.backoffUntil = d.now() + SUBSCRIPTION_BACKOFF_MS;
          if (d.account && d.account.noteProblem) { try { d.account.noteProblem(kind); } catch {} }
          if (s.alerting) await clearAlert(s.lastLine);
        } else if (kind === 'key_rejected' || kind === 'no_key') {
          s.needsKey = true;
          s.lastLine = kind === 'no_key' ? 'API key needed — open Settings' : `${who} rejected the API key — fix in Settings`;
          // Don't re-send a dead key every tick; saving a new key resets this.
          if (kind === 'key_rejected') s.backoffUntil = d.now() + 15 * 60000;
        } else if (kind === 'no_credit') {
          s.lastLine = `${who} account has no credit — add credit at ${BILLING_URL[provider] || BILLING_URL.anthropic}`;
          s.backoffUntil = d.now() + 15 * 60000; // don't hammer a dead account
        } else if (kind === 'bad_model') {
          s.lastLine = `model not available on this ${who} account — check config.json`;
          s.backoffUntil = d.now() + 15 * 60000;
        } else if (kind === 'rate_limited' || kind === 'overloaded' || kind === 'network') {
          const wait = BACKOFF_STEPS_MS[Math.min(s.backoffStep, BACKOFF_STEPS_MS.length - 1)];
          s.backoffStep++;
          s.backoffUntil = d.now() + wait;
          s.lastLine = `${kind === 'network' ? 'no connection' : `${who} busy`} — retrying at ${fmtTime(s.backoffUntil)}`;
        } else {
          s.lastLine = `error: ${msg.slice(0, 120)}`;
        }
      }
      console.error('[tick]', msg);
      // Never keep punishing once we've stopped being able to see the screen
      // or reach the model.
      if (s.alerting && s.errorStreak >= 2) await clearAlert('check failing — color restored');
      else status();
    } finally {
      // Only the current owner releases the lock: a reclaimed tick settling late
      // must not let a third check start while the second is still running.
      if (run === runSeq) s.analyzing = false;
    }
  }

  /* ---------------- public actions ---------------- */

  function pause(reason) {
    s.paused = true;
    s.pausedUntil = 0;
    s.epoch++; // discard any in-flight check
    return clearAlert(reason || 'paused');
  }

  function pauseFor(ms) {
    const p = pause('paused');
    s.pausedUntil = d.now() + Math.max(60000, ms);
    s.lastLine = `paused until ${fmtTime(s.pausedUntil)}`;
    status();
    return p;
  }

  function resume() {
    s.paused = false;
    s.pausedUntil = 0;
    s.epoch++;
    s.lastLine = 'watching…';
    status();
    return tick();
  }

  // "I'm working": clear now and back off for disputeGraceMin minutes.
  function dispute(refTs) {
    const c = cfg();
    s.graceUntil = d.now() + c.disputeGraceMin * 60000;
    d.logVerdict({ ts: d.now(), type: 'dispute', ref: refTs || s.lastVerdictTs || null });
    return clearAlert(`okay — not grayed for ${c.disputeGraceMin} min`);
  }

  function checkNow() {
    s.backoffUntil = 0;
    s.wokeAt = 0;
    if (s.paused) return Promise.resolve();
    return tick();
  }

  // Enabled in every state, including paused and blocked.
  function restoreColor() {
    s.alerting = false;
    s.strikeCount = 0;
    s.previewing = false;
    try { d.overlays.paint(false); } catch {}
    d.grayscale.forceOffSync();
    s.lastLine = 'color restored';
    status();
  }

  // Onboarding: show the consequence for a moment, then prove the restore path.
  async function previewGray(ms = 3000) {
    s.previewing = true;
    await applyAlertState();
    status();
    await new Promise(r => setTimeout(r, ms));
    s.previewing = false;
    restoreColor();
    return grayscaleUsable();
  }

  // False when the display cannot be grayed: the helper is missing, or the
  // system Color Filters switch already belongs to the user.
  function grayscaleUsable() {
    try { return d.grayscale.usable ? d.grayscale.usable() : d.grayscale.available(); }
    catch { return false; }
  }

  function setLocked(locked) {
    s.locked = !!locked;
    if (!s.locked) s.wokeAt = d.now();
    s.lastLine = s.locked ? 'screen locked — checks paused' : 'just woke — waiting';
    status();
  }

  function onWake() { s.wokeAt = d.now(); s.lastLine = 'just woke — waiting'; status(); }

  function recheckPermission() {
    s.needsScreenPermission = false;
    s.screenDenied = false;
    return checkNow();
  }

  function start() {
    stop();
    timer = d.setTimer(tick, cfg().checkIntervalSec * 1000);
  }
  function stop() { if (timer) { d.clearTimer(timer); timer = null; } }

  // Config changed: restart the timer and discard any in-flight verdict.
  function reload() {
    s.epoch++;
    s.backoffUntil = 0;
    s.backoffStep = 0;
    s.needsKey = false;
    // A new license, or a changed provider, deserves a real check rather than
    // a skip against a frame judged under the old settings.
    s.needsSubscription = false;
    s.lastHashes = null;
    s.lastHashApp = null;
    if (timer) start();
    applyAlertState();
    status();
  }

  /** Plan facts for the tray and the windows; nulls when there is no account. */
  function accountLive() {
    let snap = null;
    if (d.account && d.account.snapshot) { try { snap = d.account.snapshot(); } catch { snap = null; } }
    if (!snap) {
      return { plan: null, status: null, checksUsed: null, checksIncluded: null, needsSubscription: s.needsSubscription };
    }
    const usage = snap.usage || {};
    return {
      plan: snap.plan || null,
      status: snap.status || null,
      checksUsed: Number.isFinite(usage.checksUsed) ? usage.checksUsed : null,
      checksIncluded: Number.isFinite(usage.checksIncluded) ? usage.checksIncluded : null,
      needsSubscription: s.needsSubscription || !!snap.needsSubscription
    };
  }

  function getLive() {
    return {
      ...accountLive(),
      paused: s.paused, pausedUntil: s.pausedUntil, locked: s.locked,
      alerting: s.alerting, alertSince: s.alertSince, strikeCount: s.strikeCount,
      lastLine: s.lastLine, lastActivity: s.lastActivity, lastApp: s.lastApp,
      lastVerdictTs: s.lastVerdictTs, lastCheckAt: s.lastCheckAt,
      needsScreenPermission: s.needsScreenPermission || s.screenDenied, needsKey: s.needsKey, capHit: s.capHit,
      graceUntil: s.graceUntil, backoffUntil: s.backoffUntil, errorKind: s.errorKind,
      analyzing: s.analyzing, running: !!timer,
      grayscaleUsable: grayscaleUsable()
    };
  }

  // Authoritative permission state from macOS (main.js polls it). While set,
  // the loop does not capture at all.
  function setNeedsScreenPermission(v) {
    const next = !!v;
    if (s.screenDenied === next && s.needsScreenPermission === next) return;
    s.screenDenied = next;
    s.needsScreenPermission = next;
    status();
  }

  function destroy() { destroyed = true; stop(); }

  return {
    tick, pause, pauseFor, resume, dispute, checkNow, restoreColor, previewGray,
    setLocked, onWake, recheckPermission, start, stop, reload, getLive, destroy,
    applyAlertState, setNeedsScreenPermission, _state: s
  };
}

module.exports = { createLoop, TICK_HARD_LIMIT_MS, BACKOFF_STEPS_MS, SUBSCRIPTION_LINES, SUBSCRIPTION_BACKOFF_MS };
