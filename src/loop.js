'use strict';
// The watch loop as a state machine with injected dependencies, so the whole
// tick can run under plain Node in tests. main.js wires the real deps.
const { classifyApiError } = require('./analyzer');
const { costUsd } = require('./pricing');
const providers = require('./providers');
const framehash = require('./framehash');

const BILLING_URL = { anthropic: 'console.anthropic.com', openai: 'platform.openai.com' };

// Plan problems on the hosted path (docs/API-CONTRACT.md section 8). Each
// needs the person to do something, so none of them is retried every tick, and
// none of them ever leaves the Mac gray.
const SUBSCRIPTION_LINES = {
  // The service has a license on file for this Mac and the app could not get
  // it back by itself. Never say "subscribe" to somebody who already paid.
  no_license: "this Mac's license key is missing — paste it in Settings",
  license_invalid: 'license key was not accepted — open Settings',
  license_revoked: 'subscription was refunded or disputed — see Settings',
  trial_expired: 'trial ended — subscribe in Settings',
  subscription_inactive: 'subscription not active — update payment in Settings or at link.com',
  free_exhausted: 'free checks used up — subscribe in Settings'
};
// free_exhausted with reason "daily_budget": everybody's free checks for today
// are used up, not this Mac's. They come back at midnight UTC.
const DAILY_BUDGET_LINE = 'free checks paused for today (high demand) — back after midnight UTC, or subscribe in Settings';
const SUBSCRIPTION_BACKOFF_MS = 15 * 60000;
// Refusals that cannot change on their own. The free taste never comes back
// (free_exhausted for this device), a refunded or disputed key stays revoked,
// and a key Grayout never issued stays invalid. Retrying them every 15 minutes
// would capture the screen and upload it ~96 times a day just to be refused.
// So the loop HOLDS instead: no capture, no request, until reload() (a new key,
// a purchase, a restore) or clearPlanHold() (the service says the plan is
// served again). trial_expired and subscription_inactive are not here: a card
// fixed at link.com or in the billing portal can bring them back at any time.
function isStickyPlanProblem(kind, reason) {
  if (kind === 'license_revoked' || kind === 'license_invalid') return true;
  return kind === 'free_exhausted' && reason !== 'daily_budget';
}
// Past the monthly allowance the service serves one check every 10 minutes.
const QUOTA_RETRY_MS = 10 * 60000;
const NOT_CONNECTED_LINE = 'not connected to the Grayout service yet';
const UNREGISTERED_LINE = 'could not register this Mac with the Grayout service — will try again later';
const SECRETS_LOCKED_LINE = "can't unlock Grayout's saved keys — reopen Grayout and choose Always Allow";

// Longer than any single check (API timeout is 60s, CLI 90s). If `analyzing`
// is still set past this, something wedged and we take the lock back rather
// than stalling the loop forever with the alert possibly stuck on.
const TICK_HARD_LIMIT_MS = 150000;
const BACKOFF_STEPS_MS = [30000, 60000, 120000, 300000];
// A CLI check billed as extra usage with no readable reset time: try again after this.
const OVERAGE_FALLBACK_MS = 60 * 60000;
const CONFIG_INVALID_LINE = 'config.json has a JSON error — checks paused until it is fixed';
const CLI_MISSING_LINE = 'Claude CLI not found — install Claude Code or set cliPath in config.json';
const CLI_LOGIN_DEFAULT = { command: 'claude auth login', text: 'run claude auth login in Terminal' };
const PERMISSION_RE = /screencapture|could not create image|Screen Recording|produced no file/i;
// The person has not allowed screenshots to go to a third-party AI, or took
// that back in Settings (src/consent.js). Nothing is captured or sent.
const NO_CONSENT_LINE = 'checks are off until you allow sending screenshots';
// The front app could not be read (src/frontmost.js answered null) while the
// Never capture list has entries. The screen might be one of those apps, so
// this tick captures nothing: an exclusion fails closed, never open.
const FRONT_UNKNOWN_LINE = "skipped: can't tell which app is in front (protects your Never capture list)";

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
    // 'api' | 'cli' (analyzer.resolveEngine). On 'cli' the hosted service and
    // any stored model key play no part: not in the gates, not in error lines.
    engine: () => 'api',
    // True while config.json did not parse at launch (config() is then only defaults).
    configInvalid: () => false,
    // True once the person has allowed screenshots to be sent for checks
    // (src/consent.js satisfied()). False means no capture, no request, no
    // webcam frame. main.js always wires the real answer; the default keeps a
    // bare loop (tests) working.
    hasConsent: () => true,
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
    // The plan problem the service last refused a check for (a SUBSCRIPTION_LINES
    // kind), and whether it is one that waits for the person (planHold) rather
    // than a timer. See isStickyPlanProblem.
    planProblem: null, planHold: false,
    // True while lastLine explains a wait the person should read (a plan
    // problem, a monthly allowance, a registration failure). The generic
    // "waiting — retrying at …" line must not replace it.
    holdLine: false,
    // needsScreenPermission is a UI hint set by a capture failure that smelled
    // like permission; screenDenied is the authoritative answer from macOS
    // (fed in by main.js) and is the only thing that stops us capturing.
    needsScreenPermission: false, screenDenied: false, needsKey: false, capHit: false, errorKind: null,
    // { command, text } for a logged-out CLI (claudecli.loginHelp), else null.
    cliLogin: null,
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
  // Anything but a clear yes is a no.
  const consentGiven = () => { try { return d.hasConsent() === true; } catch { return false; } };

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

  // A usage-limit reset can be days away (weekly limits); name the day then.
  function fmtWhen(ts) {
    try {
      const sameDay = new Date(ts).toDateString() === new Date(d.now()).toDateString();
      return sameDay ? fmtTime(ts) : new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  }

  // The next 00:00 UTC, plus a minute so the service's day has really turned.
  function nextUtcMidnight(ts) {
    const t = new Date(ts);
    return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1) + 60000;
  }

  // " until Nov 1", from the reset date the last good check reported.
  function quotaResetText() {
    let iso = null;
    try { const snap = d.account && d.account.snapshot ? d.account.snapshot() : null; iso = snap && snap.usage ? snap.usage.resetsAt : null; } catch { iso = null; }
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return ' until the month resets';
    // The meter resets at 00:00 UTC on the 1st: print that date in UTC, or a
    // US evening would read it as the last day of the month.
    try { return ` until ${new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })}`; } catch { return ' until the month resets'; }
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

      // No permission to send screenshots (5.1.2(i)): never capture, never ask
      // the model. Checked before everything that could capture or send.
      if (!consentGiven()) {
        s.strikeCount = 0;
        if (s.alerting) await clearAlert(NO_CONSENT_LINE);
        else { s.lastLine = NO_CONSENT_LINE; status(); }
        return;
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

      // config.json did not parse at launch, so cfg is only the defaults. Running
      // on them could switch engine (from the CLI to the hosted service, say)
      // over one comma, so nothing is captured or sent until it parses.
      if (d.configInvalid()) {
        s.strikeCount = 0;
        s.lastLine = CONFIG_INVALID_LINE;
        if (s.alerting) await clearAlert(s.lastLine);
        else status();
        return;
      }

      if (s.locked) { s.lastLine = 'screen locked — checks paused'; status(); return; }
      if (s.wokeAt && now - s.wokeAt < c.wakeGraceSec * 1000) { s.lastLine = 'just woke — waiting'; status(); return; }
      // A plan refusal that only the person can fix: nothing is captured or
      // sent until reload() or clearPlanHold() lifts it.
      if (s.planHold) { status(); return; }
      if (now < s.backoffUntil) { if (!s.holdLine && !/retrying|credit|rejected|model/.test(s.lastLine)) s.lastLine = `waiting — retrying at ${fmtTime(s.backoffUntil)}`; status(); return; }

      const apiKey = d.secrets.getApiKey();
      if (!apiKey && d.requiresKey()) {
        s.needsKey = true; s.lastLine = 'API key needed — open Settings';
        if (s.alerting) await clearAlert(s.lastLine);
        status(); return;
      }
      s.needsKey = false;

      // The hosted service, but this build was never given its address (the
      // deploy step did not fill in DEFAULT_API_BASE). Nobody can judge a
      // screenshot, so do not even take one. The CLI engine never uses it.
      const hostedPath = d.engine() !== 'cli' && providers.resolve(c, apiKey).provider === providers.HOSTED;
      if (hostedPath && d.account && typeof d.account.configured === 'function' && !d.account.configured()) {
        s.strikeCount = 0;
        s.errorKind = 'not_connected';
        if (s.alerting) await clearAlert(NOT_CONNECTED_LINE);
        else { s.lastLine = NOT_CONNECTED_LINE; status(); }
        return;
      }

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
      // Like a Never capture match: no capture, strikes and alert left as they are.
      if (!frontApp && Array.isArray(c.neverCaptureApps) && c.neverCaptureApps.some(Boolean)) {
        if (s.lastLine !== FRONT_UNKNOWN_LINE) console.error('[tick] front app unknown; skipping capture (Never capture list is set)');
        s.lastLine = FRONT_UNKNOWN_LINE;
        status(); return;
      }
      if (isMatch(c.alwaysAllowedApps, frontApp)) {
        s.strikeCount = 0;
        s.errorStreak = 0;
        await setAlert(false, `allowlisted: ${frontApp}`);
        return;
      }

      // Consent can be withdrawn while the awaits above run.
      if (!consentGiven()) return;
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
      if (stale() || !consentGiven()) return;

      const { verdict, engine, usage, model, provider, service, overage } = await d.analyze({
        screenshotsB64: capture.images,
        webcamB64,
        workDescription: c.workDescription,
        canvasTasks: taskInfo.canvas || [],
        fileTasks: taskInfo.file || [],
        frontApp,
        apiKey,
        // The hosted path's client (src/account.js): it adds this Mac's device
        // identity and license key itself, so neither passes through here.
        account: d.account || null
      }, c);
      if (stale()) return;

      s.errorStreak = 0;
      s.backoffStep = 0;
      s.errorKind = null;
      s.needsSubscription = false;
      s.planProblem = null;
      s.planHold = false;
      s.holdLine = false;
      s.cliLogin = null;
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
      // The CLI runs on a flat-rate Claude subscription: no per-check charge,
      // unless the account is paying for overage, which bills at API prices.
      const cost = engine === 'cli' && !(usage && usage.overage) ? 0 : costUsd(usage, model || c.model);
      d.logVerdict({
        ts, off: verdict.off_task, conf: verdict.confidence,
        activity: verdict.activity, app: frontApp || null,
        displays: capture.images.length, strikes: s.strikeCount, engine,
        ...(provider ? { provider } : {}),
        model: model || c.model, usage: usage || null, cost: cost === null ? null : Number(cost.toFixed(6))
      });
      d.state.bumpChecks();

      // The plan's limit is used up and this check was billed as extra usage.
      // Its verdict is logged (and priced) above; stop until the limit resets
      // rather than pay for every check, unless config.json opts in. Nothing
      // is being watched meanwhile, so the color comes back too.
      if (overage && !c.cliAllowOverage) {
        const until = typeof overage.resetsAt === 'number' && overage.resetsAt > ts ? overage.resetsAt : ts + OVERAGE_FALLBACK_MS;
        s.backoffUntil = until;
        s.errorKind = 'rate_limited';
        s.holdLine = true;
        s.strikeCount = 0;
        await clearAlert(`Claude plan limit reached — checks paused until ${fmtWhen(until)} to avoid paid extra usage`);
        return;
      }

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
        s.holdLine = false;   // the branches below that need it set it again
        s.cliLogin = null;
        // On the CLI engine neither the hosted service nor a stored model key
        // is involved: never name their provider or follow their branches.
        const cli = d.engine() === 'cli';
        const provider = cli ? 'anthropic' : providers.resolve(c, d.secrets.getApiKey()).provider;
        const who = cli ? 'Claude' : providers.label(provider);
        const hosted = !cli && provider === providers.HOSTED;
        // Seconds the service asked us to wait (rate_limited, quota_exceeded).
        const retryAfterMs = e && Number.isFinite(e.retryAfter) && e.retryAfter > 0 ? Math.min(e.retryAfter, 86400) * 1000 : 0;
        if (hosted && SUBSCRIPTION_LINES[kind]) {
          // A billing state is never a verdict: say what is wrong, stop calling
          // for a while, and give the color back.
          const budget = kind === 'free_exhausted' && e && e.reason === 'daily_budget';
          s.needsSubscription = true;
          s.holdLine = true;
          s.planProblem = kind;
          s.planHold = isStickyPlanProblem(kind, e && e.reason);
          s.lastLine = budget ? DAILY_BUDGET_LINE : SUBSCRIPTION_LINES[kind];
          // A held problem waits for the person, not a timer (planHold above).
          s.backoffUntil = budget ? nextUtcMidnight(d.now()) : s.planHold ? 0 : d.now() + SUBSCRIPTION_BACKOFF_MS;
          if (d.account && d.account.noteProblem) { try { d.account.noteProblem(kind, { reason: e && e.reason }); } catch {} }
          if (s.alerting) await clearAlert(s.lastLine);
        } else if (hosted && kind === 'quota_exceeded') {
          // Not a problem to fix: past 10,000 checks the service slows to one
          // check every 10 minutes until the month resets. Wait as told.
          s.holdLine = true;
          s.backoffUntil = d.now() + (retryAfterMs || QUOTA_RETRY_MS);
          s.lastLine = `monthly checks used up: checking every 10 minutes${quotaResetText()}`;
          if (d.account && d.account.noteProblem) { try { d.account.noteProblem(kind); } catch {} }
          if (s.alerting) await clearAlert(s.lastLine);
        } else if (hosted && (kind === 'device_unverified' || kind === 'not_connected' || kind === 'secrets_locked')) {
          // device_unverified: the account client already registered this Mac
          // again once and retried once (contract 4.1). secrets_locked: the
          // Keychain would not unlock this Mac's saved keys, and registering a
          // new identity would bury them. Either way: stop, say so, try later.
          s.holdLine = true;
          s.lastLine = kind === 'not_connected' ? NOT_CONNECTED_LINE : kind === 'secrets_locked' ? SECRETS_LOCKED_LINE : UNREGISTERED_LINE;
          s.backoffUntil = d.now() + SUBSCRIPTION_BACKOFF_MS;
          if (s.alerting) await clearAlert(s.lastLine);
        } else if (kind === 'cli_auth') {
          // The fix depends on the binary: a wrapper logs its accounts in its own way.
          s.cliLogin = e && e.login && typeof e.login.text === 'string' ? e.login : CLI_LOGIN_DEFAULT;
          s.holdLine = true;
          s.lastLine = `Claude CLI is logged out — ${s.cliLogin.text}`;
          s.backoffUntil = d.now() + 15 * 60000; // Check now retries at once after logging in
        } else if (kind === 'cli_missing') {
          s.holdLine = true;
          s.lastLine = CLI_MISSING_LINE;
          s.backoffUntil = d.now() + 15 * 60000;
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
        } else if (kind === 'rate_limited' || kind === 'overloaded' || kind === 'network' || kind === 'not_configured') {
          // not_configured here is the SERVICE missing a setting (503): like
          // a busy service, it counts as on-task and is tried again later.
          const step = BACKOFF_STEPS_MS[Math.min(s.backoffStep, BACKOFF_STEPS_MS.length - 1)];
          s.backoffStep++;
          if (cli) {
            // A known reset sooner than the next step is the better time to
            // retry. A later one is only reported, not waited for: a refused
            // call costs no usage, and the login behind the CLI can change
            // before a weekly reset (claude auth login to another account, or
            // a failover wrapper that has recorded this limit and routes
            // around it).
            s.backoffUntil = d.now() + step;
            const resets = e && typeof e.resetsAt === 'number' && e.resetsAt > d.now() ? e.resetsAt : null;
            if (resets && resets < s.backoffUntil) s.backoffUntil = resets;
            s.lastLine = e && e.limit
              ? `Claude usage limit reached${resets ? ` (resets ${fmtWhen(resets)})` : ''} — retrying at ${fmtTime(s.backoffUntil)}`
              : e && e.timeout
                ? `Claude CLI timed out — retrying at ${fmtTime(s.backoffUntil)}`
                : `${kind === 'network' ? 'no connection' : `${who} busy`} — retrying at ${fmtTime(s.backoffUntil)}`;
          } else {
            s.backoffUntil = d.now() + Math.max(step, retryAfterMs);
            s.lastLine = `${kind === 'network' ? 'no connection' : `${who} busy`} — retrying at ${fmtTime(s.backoffUntil)}`;
          }
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
    s.planProblem = null;
    s.planHold = false;
    s.holdLine = false;
    s.lastHashes = null;
    s.lastHashApp = null;
    if (timer) start();
    applyAlertState();
    status();
  }

  /**
   * The service has just said this plan is served (a fresh /v1/status after
   * the card was fixed at link.com or in the billing portal). Lift whatever
   * plan refusal the loop is waiting out, so checks start again now rather
   * than when the 15-minute wait runs out. Does nothing when the loop is not
   * waiting on the plan: a network backoff, for example, is left alone.
   */
  function clearPlanHold() {
    if (!s.planProblem && !s.planHold && !s.needsSubscription) return false;
    s.planProblem = null;
    s.planHold = false;
    s.needsSubscription = false;
    s.backoffUntil = 0;
    s.backoffStep = 0;
    s.errorKind = null;
    if (s.holdLine) { s.holdLine = false; s.lastLine = 'watching…'; }
    status();
    return true;
  }

  /**
   * Plan facts for the tray and the windows; nulls when there is no account,
   * or on the CLI engine, where no plan is used and an old plan problem from
   * the hosted service must not ask for a subscription.
   */
  function accountLive() {
    let snap = null;
    if (d.account && d.account.snapshot && d.engine() !== 'cli') { try { snap = d.account.snapshot(); } catch { snap = null; } }
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
      graceUntil: s.graceUntil, backoffUntil: s.backoffUntil, errorKind: s.errorKind, planHold: s.planHold,
      cliLogin: s.cliLogin, configInvalid: !!d.configInvalid(), needsConsent: !consentGiven(),
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
    setLocked, onWake, recheckPermission, start, stop, reload, clearPlanHold, getLive, destroy,
    applyAlertState, setNeedsScreenPermission, _state: s
  };
}

module.exports = {
  createLoop, TICK_HARD_LIMIT_MS, BACKOFF_STEPS_MS, OVERAGE_FALLBACK_MS, CONFIG_INVALID_LINE, CLI_MISSING_LINE,
  SUBSCRIPTION_LINES, SUBSCRIPTION_BACKOFF_MS, NO_CONSENT_LINE, FRONT_UNKNOWN_LINE,
  DAILY_BUDGET_LINE, QUOTA_RETRY_MS, NOT_CONNECTED_LINE, UNREGISTERED_LINE, SECRETS_LOCKED_LINE, isStickyPlanProblem
};
